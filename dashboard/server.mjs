/**
 * Dashboard server: static UI + read-model API over .data/ + run triggers.
 *
 *   GET  /api/episodes            episode summaries, newest first
 *   GET  /api/episodes/:id        full episode detail (status, trace, logs, evidence)
 *   GET  /api/experiments         experiment runs (saved files + live experiment ids)
 *   GET  /api/experiments/:id     aggregated policy/task comparison (id "all" = every episode)
 *   GET  /api/overview            organisation replay overview (schema 1.1 `overview`)
 *   GET  /api/tasks               imported benchmark tasks
 *   GET  /api/issues?repo=o/r     open GitHub issues (via gh)
 *   GET  /api/sandboxes           live Daytona sandboxes (labels tell which episode/phase owns them)
 *   GET  /api/runs                runner processes started from the dashboard
 *   POST /api/runs/issue          { issue: "owner/repo#N", policy: "A" }   → live episode
 *   POST /api/runs/experiment     { policies: ["A","B"], tasks: ["scribl-15"] } → benchmark
 *   POST /api/runs/demo             { live: true }  → replay the seeded demo episode (no credits, no sandboxes)
 *   POST /api/runs/:id/stop
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { parse as parseEnv } from "dotenv";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { POLICIES, benchmark, overview, episodeDetail, experimentDetail, listEpisodes, listExperiments, listTasks } from "./adapter.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(root, "..");
const port = Number(process.env.DASHBOARD_PORT ?? 4173);
const DEFAULT_REPO = process.env.DASHBOARD_REPO ?? "uselucerna/scribl";
const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".woff2": "font/woff2" };

process.chdir(projectRoot); // adapter paths are relative to the project

// ---- run triggers -----------------------------------------------------------
const runs = new Map(); // id → { record, child? }
mkdirSync(".data/runs", { recursive: true });
const persist = (record) => writeFileSync(join(".data/runs", `${record.id}.json`), JSON.stringify(record, null, 2));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Reload runs from earlier server processes; their children outlive a dashboard restart.
for (const f of readdirSync(".data/runs").filter((f) => f.endsWith(".json"))) {
  try {
    const record = JSON.parse(readFileSync(join(".data/runs", f), "utf8"));
    if (record.state === "running" && !alive(record.pid)) { record.state = "done"; record.finished_at = record.finished_at ?? new Date().toISOString(); record.note = "finished while dashboard was down"; persist(record); }
    runs.set(record.id, { record });
  } catch {}
}

function startRun(kind, args, env, meta) {
  const id = `${kind}-${randomUUID().slice(0, 8)}`;
  const log = join(".data/runs", `${id}.log`);
  const fd = openSync(log, "a");
  // Re-read .env on every trigger so a rotated API key takes effect without restarting the dashboard.
  const dotenv = existsSync(".env") ? parseEnv(readFileSync(".env")) : {};
  const child = spawn("./node_modules/.bin/tsx", [args[0] === "demo" ? "src/demo.ts" : "src/index.ts", ...(args[0] === "demo" ? args.slice(1) : args)], { cwd: projectRoot, env: { ...process.env, ...dotenv, ...env }, stdio: ["ignore", fd, fd] });
  const record = { id, kind, args, ...meta, pid: child.pid, state: "running", started_at: new Date().toISOString(), log };
  child.on("exit", (code) => { record.state = code === 0 ? "done" : "failed"; record.exit_code = code; record.finished_at = new Date().toISOString(); persist(record); });
  child.on("error", (err) => { record.state = "failed"; record.error = err.message; record.finished_at = new Date().toISOString(); persist(record); });
  runs.set(id, { record, child });
  persist(record);
  return record;
}

const slugOf = (input) => input.match(/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/) ?? input.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);

function triggerIssue(body) {
  const policy = body.policy ?? "A";
  if (!POLICIES[policy]) throw new Error(`unknown policy ${policy}`);
  const m = slugOf(String(body.issue ?? ""));
  if (!m) throw new Error("issue must be owner/repo#N or an issue URL");
  const repo = m[1].split("/")[1];
  const episodeId = `${repo}-${m[2]}-${POLICIES[policy].name}-${randomUUID().slice(0, 8)}`;
  return startRun("issue", ["issue", `${m[1]}#${m[2]}`, policy], { EPISODE_ID: episodeId }, { episode_id: episodeId, issue: `${m[1]}#${m[2]}`, policy });
}

function triggerDemo(body) {
  // One fixed replay episode, re-played in place — never a new episode per click.
  const episodeId = "scribl-15-planner+coder+reviewer-demolive";
  const already = [...runs.values()].find((r) => r.record.kind === "demo" && r.record.state === "running");
  if (already) return already.record;
  const args = ["demo"]; if (body.live !== false) args.push("--live");
  return startRun("demo", args, { EPISODE_ID: episodeId, DEMO_SPEED: String(body.speed ?? 0.4) }, { episode_id: episodeId, issue: "uselucerna/scribl#15", policy: "A", demo: true });
}

function triggerExperiment(body) {
  const policies = (body.policies ?? ["A", "B", "C"]).filter((p) => POLICIES[p]);
  if (!policies.length) throw new Error("no valid policies");
  const tasks = Array.isArray(body.tasks) && body.tasks.length ? body.tasks : undefined;
  const experimentId = `exp-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${randomUUID().slice(0, 4)}`;
  const args = ["experiment", policies.join(",")];
  if (tasks) args.push(tasks.join(","));
  return startRun("experiment", args, { EXPERIMENT_ID: experimentId, CONCURRENCY: String(body.concurrency ?? process.env.CONCURRENCY ?? 2) }, { experiment_id: experimentId, policies, tasks: tasks ?? "all" });
}

// ---- external reads ---------------------------------------------------------
let issueCache = { at: 0, repo: "", data: [] };
async function issues(repo) {
  if (issueCache.repo === repo && Date.now() - issueCache.at < 60_000) return issueCache.data;
  const { stdout } = await run("gh", ["issue", "list", "-R", repo, "--state", "open", "--limit", "50", "--json", "number,title,labels,url,updatedAt"]);
  const data = JSON.parse(stdout).map((i) => ({ ref: `${repo}#${i.number}`, number: i.number, title: i.title, url: i.url, labels: i.labels.map((l) => l.name), updated_at: i.updatedAt, task_id: `${repo.split("/")[1]}-${i.number}` }));
  issueCache = { at: Date.now(), repo, data };
  return data;
}

let daytona;
async function sandboxes() {
  if (!process.env.DAYTONA_API_KEY) return { available: false, reason: "DAYTONA_API_KEY not set", sandboxes: [] };
  try {
    if (!daytona) { const { Daytona } = await import("@daytonaio/sdk"); daytona = new Daytona(); }
    const all = [];
    for await (const s of daytona.list()) all.push(s);
    const items = all.map((s) => ({
      id: s.id,
      state: s.state,
      labels: s.labels ?? {},
      created_at: s.createdAt,
      updated_at: s.updatedAt,
      cpu: s.cpu, memory: s.memory, disk: s.disk,
      auto_stop_minutes: s.autoStopInterval,
      target: s.target,
    }));
    return { available: true, sandboxes: items };
  } catch (err) {
    return { available: false, reason: err.message, sandboxes: [] };
  }
}

// ---- http -------------------------------------------------------------------
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok, fail) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { fail(e); } }); });

async function api(req, res, url) {
  const path = url.pathname.replace(/^\/api/, "");
  const now = new Date().toISOString();
  if (req.method === "GET") {
    if (path === "/episodes") return json(res, 200, { schema_version: "1.1", updated_at: now, episodes: listEpisodes() });
    if (path.startsWith("/episodes/")) { const d = episodeDetail(decodeURIComponent(path.slice(10))); return d ? json(res, 200, { updated_at: now, episode: d }) : json(res, 404, { error: "episode not found" }); }
    if (path === "/experiments") return json(res, 200, { schema_version: "1.1", updated_at: now, experiments: listExperiments() });
    if (path.startsWith("/experiments/")) { const id = decodeURIComponent(path.slice(13)); const d = id === "all" ? benchmark(url.searchParams.get("demo") === "1") : experimentDetail(id); return d ? json(res, 200, { updated_at: now, experiment: d }) : json(res, 404, { error: "experiment not found" }); }
    if (path === "/tasks") return json(res, 200, { tasks: listTasks() });
    if (path === "/overview") return json(res, 200, { schema_version: "1.1", updated_at: now, overview: overview() });
    if (path === "/issues") { try { return json(res, 200, { repo: url.searchParams.get("repo") ?? DEFAULT_REPO, issues: await issues(url.searchParams.get("repo") ?? DEFAULT_REPO) }); } catch (e) { return json(res, 502, { error: e.message, issues: [] }); } }
    if (path === "/sandboxes") return json(res, 200, { updated_at: now, ...(await sandboxes()) });
    if (path === "/runs") { for (const r of runs.values()) if (r.record.state === "running" && !r.child && !alive(r.record.pid)) { r.record.state = "done"; r.record.finished_at = now; persist(r.record); } return json(res, 200, { runs: [...runs.values()].map((r) => r.record).sort((a, b) => b.started_at.localeCompare(a.started_at)) }); }
    if (path === "/config") return json(res, 200, { repo: DEFAULT_REPO, policies: Object.values(POLICIES), model: process.env.OPENAI_MODEL ?? "gpt-5.4-mini", concurrency: Number(process.env.CONCURRENCY ?? 2) });
  }
  if (req.method === "POST") {
    let body; try { body = await readBody(req); } catch { return json(res, 400, { error: "invalid json" }); }
    try {
      if (path === "/runs/issue") return json(res, 201, { run: triggerIssue(body) });
      if (path === "/runs/experiment") return json(res, 201, { run: triggerExperiment(body) });
      if (path === "/runs/demo") return json(res, 201, { run: triggerDemo(body) });
      const stop = path.match(/^\/runs\/([^/]+)\/stop$/);
      if (stop) { const r = runs.get(stop[1]); if (!r) return json(res, 404, { error: "run not found" }); if (r.child) r.child.kill("SIGTERM"); else if (alive(r.record.pid)) process.kill(r.record.pid, "SIGTERM"); r.record.state = "stopped"; r.record.finished_at = now; persist(r.record); return json(res, 200, { run: r.record }); }
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  return json(res, 404, { error: "not found" });
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (url.pathname.startsWith("/api/")) { try { await api(request, response, url); } catch (e) { json(response, 500, { error: e.message }); } return; }
  const relative = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^[/\\]+/, "");
  const file = join(root, relative);
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, { "content-type": contentTypes[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  createReadStream(file).pipe(response);
}).listen(port, () => console.log(`Agent Atlas running at http://localhost:${port}  (repo ${DEFAULT_REPO}, data ${projectRoot}/.data)`));
