#!/usr/bin/env node
// probe.mjs: fetch every site in sites.json, judge each one, record the result,
// and keep one GitHub issue per down site as the incident record.
//
// Zero dependencies. Node 22+. Runs from GitHub Actions every 15 minutes
// (.github/workflows/probe.yml); also runs locally with `node probe.mjs`.
//
// Flags:
//   --fast   skip the 30 s wait before the retry (local testing only)
//
// Env (all optional; issue handling is skipped without a token):
//   GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID   set by Actions
//   NTFY_TOPIC, NTFY_SERVER, NTFY_TOKEN              opt-in phone push

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(ROOT, "state");
const LATEST = path.join(STATE_DIR, "latest.json");
const HISTORY = path.join(STATE_DIR, "history.ndjson");
const README = path.join(ROOT, "README.md");

const TIMEOUT_MS = 10_000; // per fetch
const RETRY_DELAY_MS = 30_000; // one retry, this long after a failure
const HEARTBEAT_MS = 6 * 60 * 60 * 1000; // record a run this often even if nothing changed
const HISTORY_KEEP_MS = 35 * 24 * 60 * 60 * 1000; // the page draws 30 days; keep a margin
const UA = "uptime-probe/1 (+https://github.com/jamessuuu/uptime)";

const env = process.env;
const REPO = env.GITHUB_REPOSITORY || "jamessuuu/uptime";
const RUN_URL = env.GITHUB_RUN_ID ? `https://github.com/${REPO}/actions/runs/${env.GITHUB_RUN_ID}` : null;
const FAST = process.argv.includes("--fast");

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- config

const config = JSON.parse(await readFile(path.join(ROOT, "sites.json"), "utf8"));
const defaults = { status: 200, maxMs: 8000, ...(config.defaults || {}) };
const notContains = config.notContains || [];
const sites = (config.sites || []).map((s) => ({ ...s, expect: { ...defaults, ...(s.expect || {}) } }));

{
  const seen = new Set();
  for (const s of sites) {
    if (!s.slug || !/^[a-z0-9-]+$/.test(s.slug)) throw new Error(`bad slug: ${JSON.stringify(s.slug)}`);
    if (seen.has(s.slug)) throw new Error(`duplicate slug: ${s.slug}`);
    seen.add(s.slug);
    if (!s.url || !/^https?:\/\//.test(s.url)) throw new Error(`${s.slug}: bad url`);
    if (typeof s.expect.contains !== "string" || !s.expect.contains) throw new Error(`${s.slug}: expect.contains is required`);
  }
  if (!sites.length) throw new Error("sites.json has no sites");
}

// ---------------------------------------------------------------- fetch + judge

function judge(site, r) {
  const e = site.expect;
  const problems = [];
  if (r.status !== e.status) problems.push(`status ${r.status}, expected ${e.status}`);
  if (!r.body.includes(e.contains)) problems.push(`body lacks ${JSON.stringify(e.contains)}`);
  for (const bad of notContains) if (r.body.includes(bad)) problems.push(`body contains ${JSON.stringify(bad)}`);
  const base = {
    status: r.status,
    ms: r.ms,
    bytes: r.bytes,
    finalUrl: r.finalUrl,
    firstBytes: r.body.slice(0, 160).replace(/\s+/g, " ").trim(),
  };
  if (problems.length) return { ...base, ok: false, state: "down", reason: problems.join("; ") };
  if (r.ms > e.maxMs) return { ...base, ok: true, state: "slow", reason: `over ${e.maxMs} ms` };
  return { ...base, ok: true, state: "up", reason: "" };
}

async function fetchOnce(site) {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(site.url, {
      redirect: "follow",
      signal: ac.signal,
      headers: { "user-agent": UA, accept: "text/html,*/*" },
    });
    const body = await res.text();
    const ms = Math.round(performance.now() - t0);
    return judge(site, { status: res.status, ms, bytes: Buffer.byteLength(body), body, finalUrl: res.url });
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    const reason =
      err.name === "AbortError" || err.name === "TimeoutError"
        ? `timeout after ${TIMEOUT_MS} ms`
        : `fetch error: ${err.cause?.code || err.cause?.message || err.message}`;
    return { ok: false, state: "down", status: null, ms, bytes: 0, finalUrl: null, firstBytes: "", reason };
  } finally {
    clearTimeout(timer);
  }
}

log(`probing ${sites.length} sites`);
const first = await Promise.all(sites.map(fetchOnce));
const results = first.map((r) => ({ ...r, attempts: 1 }));
const failed = first.map((r, i) => (r.state === "down" ? i : -1)).filter((i) => i >= 0);
if (failed.length) {
  log(`${failed.length} failed on the first attempt (${failed.map((i) => sites[i].slug).join(", ")}); retrying in ${FAST ? 0 : RETRY_DELAY_MS / 1000} s`);
  await sleep(FAST ? 0 : RETRY_DELAY_MS);
  const second = await Promise.all(failed.map((i) => fetchOnce(sites[i])));
  failed.forEach((i, k) => {
    results[i] = { ...second[k], attempts: 2, firstAttempt: first[i].reason };
  });
}

const now = new Date();
const checkedAt = now.toISOString();
const rows = sites.map((s, i) => ({
  slug: s.slug,
  url: s.url,
  state: results[i].state,
  ok: results[i].ok,
  status: results[i].status,
  ms: results[i].ms,
  bytes: results[i].bytes,
  attempts: results[i].attempts,
  reason: results[i].reason,
  firstAttempt: results[i].firstAttempt,
  firstBytes: results[i].firstBytes,
  finalUrl: results[i].finalUrl,
  expect: s.expect,
}));
const summary = {
  total: rows.length,
  up: rows.filter((r) => r.state === "up").length,
  slow: rows.filter((r) => r.state === "slow").length,
  down: rows.filter((r) => r.state === "down").length,
};
summary.label = `${summary.up + summary.slow}/${summary.total} up`;
summary.color = summary.down ? "e5484d" : summary.slow ? "f5a524" : "2ea043";

for (const r of rows) {
  const mark = r.state === "up" ? "ok  " : r.state === "slow" ? "slow" : "DOWN";
  log(`${mark} ${r.slug.padEnd(16)} ${String(r.status ?? "-").padStart(3)} ${String(r.ms).padStart(5)} ms ${r.reason}`);
}
log(`${summary.label}, ${summary.down} down, ${summary.slow} slow`);

// ---------------------------------------------------------------- state files (change-only)

const prev = existsSync(LATEST) ? JSON.parse(await readFile(LATEST, "utf8")) : null;
const signature = (rs) => JSON.stringify(rs.map((r) => [r.slug, r.state, r.status, r.reason]));
const changed = !prev || signature(prev.sites || []) !== signature(rows);
const stale = !prev || now - new Date(prev.generatedAt) > HEARTBEAT_MS;
const record = changed || stale;

if (record) {
  await mkdir(STATE_DIR, { recursive: true });
  const latest = { generatedAt: checkedAt, run: RUN_URL, summary, sites: rows };
  await writeFile(LATEST, JSON.stringify(latest, null, 2) + "\n");

  // history.ndjson: one line per recorded run. r[slug] = [state, ms, status].
  const line = JSON.stringify({ t: checkedAt, run: env.GITHUB_RUN_ID || null, r: Object.fromEntries(rows.map((r) => [r.slug, [r.state, r.ms, r.status]])) });
  const old = existsSync(HISTORY) ? (await readFile(HISTORY, "utf8")).split("\n").filter(Boolean) : [];
  const cutoff = now.getTime() - HISTORY_KEEP_MS;
  const kept = old.filter((l) => {
    try { return new Date(JSON.parse(l).t).getTime() >= cutoff; } catch { return false; }
  });
  kept.push(line);
  await writeFile(HISTORY, kept.join("\n") + "\n");

  await regenerateReadme(rows, summary, checkedAt);
  log(changed ? "state changed: wrote state/ and README" : "heartbeat: wrote state/ and README");
} else {
  log("no change since last record; state/ untouched");
}

async function regenerateReadme(rows, summary, at) {
  if (!existsSync(README)) return;
  const md = await readFile(README, "utf8");
  const start = "<!-- table:start -->";
  const end = "<!-- table:end -->";
  const a = md.indexOf(start);
  const b = md.indexOf(end);
  if (a < 0 || b < 0) return;
  const icon = { up: "up", slow: "slow", down: "DOWN" };
  const lines = [
    `Last recorded ${at.replace("T", " ").slice(0, 19)} UTC: **${summary.label}**${summary.down ? `, ${summary.down} down` : ""}${summary.slow ? `, ${summary.slow} slow` : ""}. Regenerated by probe.mjs; do not edit by hand.`,
    "",
    "| Site | State | Status | ms | Note |",
    "|---|---|---|---:|---|",
    ...rows.map((r) => `| [${r.slug}](${r.url}) | ${icon[r.state]} | ${r.status ?? "-"} | ${r.ms} | ${r.reason} |`),
  ];
  await writeFile(README, md.slice(0, a + start.length) + "\n" + lines.join("\n") + "\n" + md.slice(b));
}

// ---------------------------------------------------------------- run summary (Actions)

if (env.GITHUB_STEP_SUMMARY) {
  const { appendFile } = await import("node:fs/promises");
  const table = [
    `## ${summary.label}${summary.down ? ` (${summary.down} down)` : ""}`,
    "",
    "| Site | State | Status | ms | Note |",
    "|---|---|---|---:|---|",
    ...rows.map((r) => `| ${r.slug} | ${r.state} | ${r.status ?? "-"} | ${r.ms} | ${r.reason} |`),
    "",
  ].join("\n");
  await appendFile(env.GITHUB_STEP_SUMMARY, table);
}

// ---------------------------------------------------------------- issues (one per down site)

const token = env.GITHUB_TOKEN;
if (!token) {
  log("no GITHUB_TOKEN: skipping issue handling");
} else {
  await manageIssues();
}

async function gh(method, url, body) {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": UA,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const LABEL = "uptime";

async function ensureLabel() {
  try {
    await gh("GET", `/repos/${REPO}/labels/${LABEL}`);
  } catch {
    await gh("POST", `/repos/${REPO}/labels`, { name: LABEL, color: "b60205", description: "Opened and closed by probe.mjs" });
  }
}

function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

function issueBody(r) {
  return [
    `**${r.slug}** failed its probe at ${checkedAt} UTC.`,
    "",
    `- URL: ${r.url}`,
    `- Expected: status ${r.expect.status}, body contains ${JSON.stringify(r.expect.contains)}`,
    `- Got: status ${r.status ?? "none"}, ${r.ms} ms, ${r.bytes} bytes`,
    `- Reason: ${r.reason}`,
    r.firstAttempt && r.firstAttempt !== r.reason ? `- First attempt: ${r.firstAttempt}` : null,
    r.firstBytes ? `- First bytes: \`${r.firstBytes.replace(/`/g, "'")}\`` : null,
    RUN_URL ? `- Run: ${RUN_URL}` : null,
    "",
    `Fetched twice, ${RETRY_DELAY_MS / 1000} s apart; both attempts failed. This issue closes itself when the probe sees the site healthy again.`,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

async function manageIssues() {
  await ensureLabel();
  const open = await gh("GET", `/repos/${REPO}/issues?state=open&labels=${LABEL}&per_page=100`);
  const byTitle = new Map(open.filter((i) => !i.pull_request).map((i) => [i.title, i]));
  const prevBySlug = new Map((prev?.sites || []).map((s) => [s.slug, s]));
  const events = [];

  for (const r of rows) {
    const title = `DOWN: ${r.slug}`;
    const issue = byTitle.get(title);
    byTitle.delete(title);
    if (r.state === "down") {
      if (!issue) {
        const created = await gh("POST", `/repos/${REPO}/issues`, { title, body: issueBody(r), labels: [LABEL] });
        log(`opened #${created.number} ${title}`);
        events.push({ kind: "down", r, issue: created });
      } else if (prevBySlug.get(r.slug)?.reason !== r.reason) {
        await gh("POST", `/repos/${REPO}/issues/${issue.number}/comments`, {
          body: `Still down at ${checkedAt}. Now: ${r.reason} (status ${r.status ?? "none"}, ${r.ms} ms).${RUN_URL ? ` Run: ${RUN_URL}` : ""}`,
        });
        log(`updated #${issue.number} ${title}`);
      }
    } else if (issue) {
      const downFor = fmtDuration(now - new Date(issue.created_at));
      await gh("POST", `/repos/${REPO}/issues/${issue.number}/comments`, {
        body: `Recovered at ${checkedAt} after ${downFor}: status ${r.status} in ${r.ms} ms${r.state === "slow" ? " (slow)" : ""}.${RUN_URL ? ` Run: ${RUN_URL}` : ""}`,
      });
      await gh("PATCH", `/repos/${REPO}/issues/${issue.number}`, { state: "closed", state_reason: "completed" });
      log(`closed #${issue.number} ${title} (down ${downFor})`);
      events.push({ kind: "up", r, issue, downFor });
    }
  }

  // Open DOWN issues whose slug is no longer in sites.json: the entry was removed, so the incident is over.
  for (const [title, issue] of byTitle) {
    const slug = title.replace(/^DOWN: /, "");
    const downFor = fmtDuration(now - new Date(issue.created_at));
    await gh("POST", `/repos/${REPO}/issues/${issue.number}/comments`, {
      body: `Closed at ${checkedAt} after ${downFor}: \`${slug}\` is no longer in sites.json.${RUN_URL ? ` Run: ${RUN_URL}` : ""}`,
    });
    await gh("PATCH", `/repos/${REPO}/issues/${issue.number}`, { state: "closed", state_reason: "completed" });
    log(`closed #${issue.number} ${title} (removed from sites.json)`);
    events.push({ kind: "removed", r: { slug }, issue, downFor });
  }

  await notify(events);
}

async function notify(events) {
  if (!env.NTFY_TOPIC || !events.length) return;
  const server = (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
  for (const e of events) {
    const title = e.kind === "down" ? `DOWN: ${e.r.slug}` : `Recovered: ${e.r.slug}`;
    const body =
      e.kind === "down"
        ? `${e.r.url}\n${e.r.reason}\n${e.issue.html_url}`
        : `${e.r.url || e.r.slug} back after ${e.downFor}\n${e.issue.html_url}`;
    try {
      const res = await fetch(`${server}/${env.NTFY_TOPIC}`, {
        method: "POST",
        headers: {
          title,
          priority: e.kind === "down" ? "high" : "default",
          tags: e.kind === "down" ? "rotating_light" : "white_check_mark",
          ...(env.NTFY_TOKEN ? { authorization: `Bearer ${env.NTFY_TOKEN}` } : {}),
        },
        body,
      });
      log(`ntfy ${title}: ${res.status}`);
    } catch (err) {
      log(`ntfy failed: ${err.message}`);
    }
  }
}
