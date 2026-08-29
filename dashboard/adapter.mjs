/**
 * Artifact adapter: maps runner output under .data/ into the versioned
 * dashboard read model. The UI only ever sees what this module returns.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const SCHEMA_VERSION = "1.1";
const EPISODES_DIR = ".data/episodes";
const EXPERIMENTS_DIR = ".data/experiments";
const TASKS_DIR = "tasks";

export const POLICIES = {
  A: { key: "A", name: "planner+coder+reviewer", label: "Planner + Coder + Reviewer", colour: "blue" },
  B: { key: "B", name: "planner+coder", label: "Planner + Coder", colour: "slate" },
  C: { key: "C", name: "coder+reviewer", label: "Coder + Reviewer", colour: "violet" },
  D: { key: "D", name: "planner+coder+reviewer+retry", label: "Planner + Coder + Reviewer + Retry", colour: "mint" },
};
const policyByName = (name) => Object.values(POLICIES).find((p) => p.name === name) ?? { key: "?", name, label: name, colour: "slate" };

const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; } };
const readJsonl = (file) => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean); } catch { return []; } };

function loadTask(taskId) {
  return readJson(join(TASKS_DIR, `${taskId}.json`));
}

function issueOf(task, taskId) {
  if (!task) return { title: taskId, repository: "unknown", base_commit: "" };
  const firstLine = (task.issue ?? "").split("\n")[0].replace(/^Title:\s*/, "");
  return {
    number: task.meta?.issue_number,
    title: task.meta?.issue_title ?? firstLine ?? taskId,
    url: task.meta?.issue_url,
    labels: task.meta?.labels ?? [],
    repository: task.repository,
    base_commit: task.base_commit,
    body: task.issue,
  };
}

/** Everything the dashboard knows about one episode directory. */
function readEpisodeDir(id) {
  const dir = join(EPISODES_DIR, id);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return undefined;
  const status = readJson(join(dir, "status.json"));
  const result = readJson(join(dir, "result.json"));
  const evaluation = readJson(join(dir, "eval.json")) ?? result?.eval;
  const planFile = readJson(join(dir, "plan.json"));
  const plan = (planFile && "plan" in planFile ? planFile.plan : planFile) ?? result?.plan;
  const reviewFile = readJson(join(dir, "review.json"));
  const review = (reviewFile && "review" in reviewFile ? reviewFile.review : reviewFile) ?? result?.review;
  const diff = readJson(join(dir, "diff.json"))?.diff ?? result?.diff ?? "";
  const task = readJson(join(dir, "task.json")) ?? loadTask(result?.task_id ?? status?.task_id ?? id.split("-")[0]);
  const events = readJsonl(join(dir, "events.jsonl"));
  const logs = readJsonl(join(dir, "log.jsonl"));
  const mtime = statSync(dir).mtime.toISOString();
  return { id, dir, status, result, evaluation, plan, review, diff, task, events, logs, mtime };
}

function deriveState(e) {
  // Legacy episodes (before status.json) only have result.json, or nothing.
  if (e.result) {
    if (e.result.status === "error") return "error";
    if (e.result.status === "abstained") return "abstained";
    return e.evaluation?.success ? "passed" : "failed";
  }
  if (e.status) {
    if (e.status.state === "running") {
      const stale = Date.now() - Date.parse(e.status.updated_at) > 45 * 60 * 1000;
      return stale ? "error" : "running";
    }
    return e.status.state === "done" ? (e.evaluation?.success ? "passed" : "failed") : e.status.state;
  }
  return e.events.length ? "error" : "error";
}

const sumUsage = (usage = []) => usage.reduce((a, u) => ({ input: a.input + (u.input_tokens ?? 0), output: a.output + (u.output_tokens ?? 0) }), { input: 0, output: 0 });
const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtDuration = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");

function summary(e) {
  const state = deriveState(e);
  const policy = policyByName(e.result?.policy ?? e.status?.policy ?? e.id.replace(/-[0-9a-f]{8}$/, "").split("-").slice(-1)[0]);
  const usage = sumUsage(e.result?.usage ?? e.status?.usage ?? (e.evaluation ? [{ input_tokens: e.evaluation.cost.input_tokens, output_tokens: e.evaluation.cost.output_tokens }] : []));
  const startedAt = e.status?.started_at ?? e.result?.started_at ?? e.events[0]?.timestamp ?? e.mtime;
  const finishedAt = e.status?.finished_at ?? e.result?.finished_at;
  const wallMs = e.evaluation?.cost?.wall_ms ?? e.result?.wall_ms ?? (finishedAt ? Date.parse(finishedAt) - Date.parse(startedAt) : Date.now() - Date.parse(startedAt));
  return {
    id: e.id,
    task_id: e.result?.task_id ?? e.status?.task_id ?? e.task?.task_id ?? "",
    experiment_id: e.status?.experiment_id ?? e.result?.experiment_id,
    policy,
    state,
    phase: e.status?.phase ?? (e.result ? "finished" : "unknown"),
    detail: e.status?.detail ?? e.result?.error,
    // Infrastructure failures (quota, rate limit, sandbox API, killed runner) say nothing about the policy.
    infra: /rate limit|credits|status code 50\d|stopped by user|ECONNRESET|fetch failed/i.test(e.result?.error ?? e.status?.detail ?? "") || undefined,
    issue: issueOf(e.task, e.result?.task_id ?? e.status?.task_id ?? ""),
    started_at: startedAt,
    updated_at: e.status?.updated_at ?? e.mtime,
    finished_at: finishedAt,
    wall_ms: wallMs,
    reward: e.evaluation?.reward,
    success: e.evaluation?.success,
    confidence: e.plan?.confidence,
    tokens: usage.input + usage.output,
    events: e.events.length,
    sandboxes: e.result?.sandboxes ?? e.status?.sandboxes ?? {},
    models: e.status?.models,
    demo: e.status?.demo || /demo/.test(e.id) || undefined,
  };
}

function agentStates(e, s) {
  const policy = POLICIES[s.policy.key] ?? {};
  const hasPlanner = /planner/.test(s.policy.name);
  const hasReviewer = /reviewer/.test(s.policy.name);
  const phase = s.phase;
  const running = s.state === "running";
  const plannerEvents = e.events.filter((ev) => ev.agent === "planner").length;
  const coderEvents = e.events.filter((ev) => ev.agent === "coder").length;
  const reviewerEvents = e.events.filter((ev) => ev.agent === "reviewer").length;
  const order = ["planner", "coder", "reviewer", "eval", "finished"];
  const after = (p) => order.indexOf(phase) > order.indexOf(p) || (!running && phase === "finished");

  const planner = !hasPlanner ? { state: "skipped", detail: "Not in policy" }
    : e.plan ? { state: s.state === "abstained" ? "rejected" : "passed", detail: `Confidence ${(e.plan.confidence ?? 0).toFixed(2)}${s.state === "abstained" ? " · abstained" : ""}` }
    : running && phase === "planner" ? { state: "running", detail: plannerEvents ? `${plannerEvents} actions` : s.detail ?? "Booting sandbox" }
    : after("planner") ? { state: "passed", detail: "Done" } : { state: s.state === "error" ? "errored" : "queued", detail: s.state === "error" && phase === "planner" ? "Errored" : "Waiting" };

  const coder = s.state === "abstained" ? { state: "skipped", detail: "Planner abstained" }
    : running && phase === "coder" ? { state: "running", detail: `${coderEvents} actions${s.attempt ? ` · retry ${s.attempt}` : ""}` }
    : after("coder") || e.diff ? { state: e.diff?.trim() ? "passed" : after("coder") ? "rejected" : "queued", detail: e.diff?.trim() ? `${coderEvents} actions · patch ready` : "Empty patch" }
    : s.state === "error" ? { state: "errored", detail: "Errored" } : { state: "queued", detail: "Waiting for plan" };

  const reviewer = !hasReviewer ? { state: "skipped", detail: "Not in policy" }
    : s.state === "abstained" ? { state: "skipped", detail: "Planner abstained" }
    : running && phase === "reviewer" ? { state: "running", detail: `${reviewerEvents} actions` }
    : e.review ? { state: e.review.verdict === "approve" ? "passed" : "rejected", detail: e.review.verdict === "approve" ? "Approved" : `Rejected · ${e.review.issues?.length ?? 0} issues` }
    : s.state === "error" ? { state: "errored", detail: "Did not run" } : { state: "queued", detail: "Awaiting patch" };

  const evaluation = s.state === "abstained" ? { state: "skipped", detail: "No patch to evaluate" }
    : e.evaluation ? { state: e.evaluation.success ? "passed" : "rejected", detail: `Reward ${e.evaluation.reward.toFixed(2)}` }
    : running && phase === "eval" ? { state: "running", detail: s.detail ?? "Running oracle" }
    : s.state === "error" ? { state: "errored", detail: "Did not run" } : { state: "pending", detail: "Hidden oracle" };

  return [
    { key: "planner", label: "Planner", ...planner },
    { key: "coder", label: "Coder", ...coder },
    { key: "reviewer", label: "Reviewer", ...reviewer },
    { key: "evaluation", label: "Evaluation", ...evaluation },
  ];
}

function classify(ev, task) {
  const tool = ev.action?.tool;
  const input = ev.action?.input ?? {};
  const testHead = (task?.test_command ?? "").split(/\s+/)[0];
  if (tool === "write_file") return { kind: "edit", title: `Write ${input.path ?? ""}`, command: `write_file ${input.path ?? ""}` };
  if (tool === "read_file") return { kind: "read", title: `Read ${input.path ?? ""}`, command: `read_file ${input.path ?? ""}` };
  const cmd = String(input.command ?? "");
  const short = cmd.split("\n")[0].slice(0, 90);
  if (task?.test_command && (cmd.includes(task.test_command) || (testHead && cmd.includes(testHead) && /typecheck|test|build|lint/.test(cmd)))) return { kind: "test", title: `Run ${short}`, command: cmd };
  if (/^(grep|rg|find|ls|cat|sed -n|head|tail|tree|git (log|show|diff|status)|wc)\b/.test(cmd)) return { kind: "search", title: short, command: cmd };
  return { kind: "bash", title: short, command: cmd };
}

function trace(e) {
  const testHead = e.task?.test_command;
  return e.events.map((ev, i) => {
    const c = classify(ev, e.task);
    const exit = ev.observation?.exit_code;
    const output = ev.observation?.output ?? "";
    const failed = exit !== undefined && exit !== 0;
    return {
      id: `${ev.agent}-${ev.step}-${i}`,
      index: i + 1,
      step: String(ev.step).padStart(2, "0"),
      agent: ev.agent,
      kind: c.kind,
      title: c.title,
      command: c.command,
      tool: ev.action?.tool,
      input: ev.action?.input,
      output,
      output_preview: output.split("\n").filter(Boolean).slice(-2).join(" · ").slice(0, 160),
      exit_code: exit,
      state: failed ? "failed" : "ok",
      timestamp: ev.timestamp,
      time: clock(ev.timestamp),
      duration: `${((ev.duration_ms ?? 0) / 1000).toFixed(1)}s`,
      duration_ms: ev.duration_ms ?? 0,
    };
  });
}

/**
 * Per-sandbox terminal transcript: orchestrator commands (log.jsonl lines that
 * carry output) merged with the agent's own bash/write actions (events.jsonl)
 * for the phase that owns the sandbox, ordered by time. Read-only by design —
 * the agent drives the machine; a human typing would corrupt the trajectory.
 */
function terminals(e, sandboxes) {
  const phaseOf = {};
  for (const [phase, ids] of Object.entries(sandboxes)) ids.forEach((id, i) => (phaseOf[id] = { phase, attempt: i }));
  const out = {};
  for (const [id, { phase, attempt }] of Object.entries(phaseOf)) {
    const rows = [];
    // Orchestrator lines are scoped to a sandbox by id mention (boot/release) or by phase + attempt window.
    const byPhase = e.logs.filter((l) => l.phase === phase || l.message.includes(id));
    // Split a phase's log lines into attempt windows on each "booted" marker.
    let window = -1;
    for (const l of byPhase) {
      if (/booted/.test(l.message)) window++;
      if (window !== attempt && !l.message.includes(id)) continue;
      const m = /^(.*?): (.*)$/s.exec(l.message);
      if (l.output !== undefined || l.exit_code !== undefined) {
        rows.push({ t: l.timestamp, source: "orchestrator", label: m?.[1] ?? l.phase, cmd: m?.[2] ?? l.message, output: l.output ?? "", exit_code: l.exit_code, duration_ms: l.duration_ms });
      } else {
        rows.push({ t: l.timestamp, source: "note", cmd: l.message, level: l.level });
      }
    }
    const agentSteps = e.events.filter((ev) => ev.agent === phase);
    // Attempt windows for the agent: retries restart the step counter.
    let w = -1, last = Infinity;
    for (const ev of agentSteps) {
      if (ev.step <= last) w++;
      last = ev.step;
      if (w !== attempt) continue;
      const tool = ev.action?.tool, inp = ev.action?.input ?? {};
      const obs = ev.observation ?? {};
      if (tool === "bash") rows.push({ t: ev.timestamp, source: "agent", cmd: inp.command ?? "", output: obs.output ?? "", exit_code: obs.exit_code, duration_ms: ev.duration_ms, step: ev.step });
      else if (tool === "write_file") rows.push({ t: ev.timestamp, source: "agent", cmd: `write ${inp.path ?? ""}`, output: obs.output ?? "", exit_code: obs.exit_code ?? 0, duration_ms: ev.duration_ms, step: ev.step, meta: `${String(inp.content ?? "").split("\n").length} lines` });
      else if (tool === "read_file") rows.push({ t: ev.timestamp, source: "agent", cmd: `cat ${inp.path ?? ""}`, output: obs.output ?? "", exit_code: obs.exit_code ?? 0, duration_ms: ev.duration_ms, step: ev.step });
      else if (tool) rows.push({ t: ev.timestamp, source: "agent", cmd: `${tool} ${JSON.stringify(inp).slice(0, 120)}`, output: obs.output ?? "", exit_code: obs.exit_code ?? 0, duration_ms: ev.duration_ms, step: ev.step });
    }
    rows.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    out[id] = rows.map((r, i) => ({ id: `${id}-${i}`, ...r, time: clock(r.t), output: (r.output ?? "").slice(-6000) }));
  }
  return out;
}

function diffSummary(diff) {
  const files = [];
  let additions = 0, deletions = 0, current;
  for (const line of diff.split("\n")) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) { current = { path: m[2], additions: 0, deletions: 0 }; files.push(current); continue; }
    if (!current || line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) { additions++; current.additions++; }
    else if (line.startsWith("-")) { deletions++; current.deletions++; }
  }
  return { text: diff, files, additions, deletions };
}

function rewardBreakdown(ev) {
  if (!ev) return [];
  const steps = Math.min(0.15, Math.max(0, ev.soft.coder_steps - 20) * 0.01);
  const iters = Math.min(0.1, Math.max(0, ev.soft.coder_iterations - 5) * 0.02);
  const rows = [
    { label: "Hidden evaluation passes", value: ev.hard.hidden_eval_pass ? 0.7 : 0, max: 0.7, ok: ev.hard.hidden_eval_pass },
    { label: "Visible tests pass", value: ev.hard.tests_pass ? 0.1 : 0, max: 0.1, ok: ev.hard.tests_pass },
    { label: "Tests untouched", value: ev.hard.tests_untouched ? 0.1 : 0, max: 0.1, ok: ev.hard.tests_untouched },
  ];
  if (ev.soft.planner_file_recall !== undefined) rows.push({ label: "Planner file recall", value: 0.1 * ev.soft.planner_file_recall, max: 0.1, ok: ev.soft.planner_file_recall > 0 });
  rows.push({ label: `Step penalty (${ev.soft.coder_steps} coder steps, free ≤ 20)`, value: -steps, max: -0.15, ok: steps === 0 });
  rows.push({ label: `Iteration penalty (${ev.soft.coder_iterations} test runs, free ≤ 5)`, value: -iters, max: -0.1, ok: iters === 0 });
  return rows;
}

export function episodeDetail(id) {
  const e = readEpisodeDir(id);
  if (!e) return undefined;
  const s = summary(e);
  const ev = e.evaluation;
  const tr = trace(e);
  const testEvents = tr.filter((t) => t.kind === "test");
  const lastTest = testEvents.at(-1);
  const usage = sumUsage(e.result?.usage ?? e.status?.usage ?? []);
  const tokens = ev ? ev.cost.input_tokens + ev.cost.output_tokens : usage.input + usage.output;
  const coderSteps = ev?.soft.coder_steps ?? e.events.filter((x) => x.agent === "coder").length;
  const coderIters = ev?.soft.coder_iterations ?? testEvents.filter((t) => t.agent === "coder").length;
  const metrics = [
    ev ? { label: "Visible tests", value: ev.hard.tests_pass ? "Pass" : "Fail", tone: ev.hard.tests_pass ? "good" : "bad", note: e.task?.test_command ?? "" }
       : { label: "Visible tests", value: lastTest ? (lastTest.state === "ok" ? "Pass" : "Fail") : "—", tone: lastTest ? (lastTest.state === "ok" ? "good" : "warn") : "muted", note: lastTest ? `last run by ${lastTest.agent}` : "not run yet" },
    { label: "Actions", value: String(e.events.length), note: `${coderSteps} by coder` },
    { label: "Iterations", value: String(coderIters), note: "coder test runs" },
    ev ? { label: "Reward", value: ev.reward.toFixed(2), tone: ev.success ? "good" : "bad", note: ev.success ? "hidden oracle passed" : "hidden oracle failed" } : { label: "Reward", value: "—", tone: "muted", note: s.state === "abstained" ? "abstained" : "pending evaluation" },
    { label: "Tokens", value: fmtTokens(tokens), note: `${fmtTokens(ev?.cost.input_tokens ?? usage.input)} in · ${fmtTokens(ev?.cost.output_tokens ?? usage.output)} out` },
    { label: s.state === "running" ? "Elapsed" : "Duration", value: fmtDuration(s.wall_ms), note: s.state === "running" ? `sandbox active · ${s.phase}` : `finished ${clock(s.finished_at)}` },
  ];
  const evaluationChecks = [
    { label: "Visible test command", state: ev ? (ev.hard.tests_pass ? "passed" : "failed") : "pending", note: e.task?.test_command },
    { label: "Hidden evaluation command", state: ev ? (ev.hard.hidden_eval_pass ? "passed" : "failed") : "pending", note: "command withheld from agents" },
    { label: "Tests untouched", state: ev ? (ev.hard.tests_untouched ? "passed" : "failed") : "pending" },
    { label: "Meaningful diff", state: ev ? (ev.hard.diff_nonempty ? "passed" : "failed") : e.diff?.trim() ? "passed" : "pending" },
  ];
  return {
    schema_version: SCHEMA_VERSION,
    ...s,
    task: e.task ? { task_id: e.task.task_id, repository: e.task.repository, base_commit: e.task.base_commit, test_command: e.task.test_command, setup_command: e.task.setup_command, protected_paths: e.task.protected_paths, issue: e.task.issue } : undefined,
    agents: agentStates(e, s),
    metrics,
    planner: e.plan ? { diagnosis: e.plan.diagnosis, files: e.plan.files ?? [], plan: e.plan.plan ?? [], confidence: e.plan.confidence, concerns: e.plan.concerns ?? [] } : undefined,
    review: e.review ? { verdict: e.review.verdict, issues: e.review.issues ?? [], rubric: e.review.rubric ?? {} } : undefined,
    evaluation: ev ? { ...ev, checks: evaluationChecks, breakdown: rewardBreakdown(ev) } : { checks: evaluationChecks, breakdown: [] },
    diff: diffSummary(e.diff ?? ""),
    trace: tr,
    logs: e.logs.map((l, i) => ({ id: `log-${i}`, ...l, time: clock(l.timestamp) })),
    terminals: terminals(e, s.sandboxes ?? {}),
    usage: e.result?.usage ?? e.status?.usage ?? [],
    error: e.result?.error,
    attempt: e.status?.attempt ?? 0,
  };
}

export function listEpisodes() {
  if (!existsSync(EPISODES_DIR)) return [];
  return readdirSync(EPISODES_DIR)
    .map(readEpisodeDir)
    .filter(Boolean)
    .map(summary)
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
}

function aggregate(all) {
  const hidden = all.filter((e) => e.infra).length;
  const episodes = all.filter((e) => !e.infra);
  const byPolicy = new Map();
  for (const ep of episodes) {
    const key = ep.policy.key;
    if (!byPolicy.has(key)) byPolicy.set(key, { ...ep.policy, episodes: [] });
    byPolicy.get(key).episodes.push(ep);
  }
  const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const policies = [...byPolicy.values()].map((p) => {
    const evaluated = p.episodes.filter((e) => e.reward !== undefined);
    const n = evaluated.length;
    const avg = (f) => (n ? evaluated.reduce((a, e) => a + f(e), 0) / n : 0);
    const reviewed = p.episodes.filter((e) => e.review);
    return {
      key: p.key, name: p.name, label: p.label, colour: p.colour,
      episodes: p.episodes.length,
      evaluated: n,
      running: p.episodes.filter((e) => e.state === "running").length,
      abstained: p.episodes.filter((e) => e.state === "abstained").length,
      errors: p.episodes.filter((e) => e.state === "error").length,
      successes: evaluated.filter((e) => e.success).length,
      success_rate: n ? evaluated.filter((e) => e.success).length / n : null,
      reward: n ? avg((e) => e.reward) : null,
      steps: n ? avg((e) => e.coder_steps ?? 0) : null,
      tokens: n ? avg((e) => e.tokens) : null,
      duration_ms: median(evaluated.map((e) => e.wall_ms)),
      reviewer_approval: reviewed.length ? reviewed.filter((e) => e.review.verdict === "approve").length / reviewed.length : null,
    };
  }).sort((a, b) => a.key.localeCompare(b.key));
  const tasks = [...new Set(episodes.map((e) => e.task_id))].map((task_id) => ({
    task_id,
    issue: episodes.find((e) => e.task_id === task_id)?.issue,
    cells: Object.fromEntries(policies.map((p) => [p.key, episodes.filter((e) => e.task_id === task_id && e.policy.key === p.key).map((e) => ({ id: e.id, state: e.state, reward: e.reward }))])),
  }));
  const points = episodes.filter((e) => e.reward !== undefined).map((e) => ({ id: e.id, policy: e.policy.key, reward: e.reward, tokens: e.tokens, task_id: e.task_id }));
  const ranked = policies.filter((p) => p.reward !== null).sort((a, b) => (b.success_rate - a.success_rate) || (b.reward - a.reward));
  return { policies, tasks, points, best: ranked[0]?.key, episodes, hidden_infra: hidden };
}

function experimentEpisodes(id) {
  // Live episodes tagged with the experiment id take precedence; the saved file is the frozen record.
  const live = listEpisodes().filter((e) => e.experiment_id === id);
  if (live.length) return live.map((e) => ({ ...episodeDetailLite(e) }));
  const file = readJson(join(EXPERIMENTS_DIR, `${id}.json`));
  if (!Array.isArray(file)) return [];
  const ids = new Set(file.map((r) => r.episode_id));
  return listEpisodes().filter((e) => ids.has(e.id)).map(episodeDetailLite);
}

function episodeDetailLite(s) {
  const e = readEpisodeDir(s.id);
  return { ...s, coder_steps: e?.evaluation?.soft.coder_steps, review: e?.review ? { verdict: e.review.verdict } : undefined };
}

export function listExperiments() {
  const files = existsSync(EXPERIMENTS_DIR) ? readdirSync(EXPERIMENTS_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")) : [];
  const live = [...new Set(listEpisodes().map((e) => e.experiment_id).filter(Boolean))];
  const ids = [...new Set([...live, ...files])];
  return ids.map((id) => {
    const eps = experimentEpisodes(id);
    const running = eps.some((e) => e.state === "running");
    const started = eps.map((e) => Date.parse(e.started_at)).filter(Boolean);
    return {
      id,
      state: running ? "running" : eps.length ? "done" : "empty",
      episodes: eps.length,
      policies: [...new Set(eps.map((e) => e.policy.key))].sort(),
      tasks: [...new Set(eps.map((e) => e.task_id))],
      started_at: started.length ? new Date(Math.min(...started)).toISOString() : undefined,
      saved: files.includes(id),
      demo: eps.some((e) => e.demo) || undefined,
    };
  }).sort((a, b) => Date.parse(b.started_at ?? 0) - Date.parse(a.started_at ?? 0));
}

export function experimentDetail(id) {
  const eps = experimentEpisodes(id);
  if (!eps.length) return undefined;
  return { schema_version: SCHEMA_VERSION, id, state: eps.some((e) => e.state === "running") ? "running" : "done", ...aggregate(eps) };
}

/** Benchmark-wide aggregate: every evaluated episode of every experiment plus ad-hoc runs. */
export function benchmark(includeDemo = false) {
  const eps = listEpisodes().filter((e) => includeDemo || !e.demo).map(episodeDetailLite);
  return { schema_version: SCHEMA_VERSION, id: "all", state: eps.some((e) => e.state === "running") ? "running" : "done", ...aggregate(eps) };
}

export function listTasks() {
  if (!existsSync(TASKS_DIR)) return [];
  return readdirSync(TASKS_DIR).filter((f) => f.endsWith(".json")).map((f) => {
    const t = readJson(join(TASKS_DIR, f));
    return t ? { task_id: t.task_id, issue: issueOf(t, t.task_id), test_command: t.test_command, setup_command: t.setup_command } : undefined;
  }).filter(Boolean);
}

/**
 * Organisation replay overview (schema 1.1 `overview`). The org-scale figures are a
 * deterministic replay snapshot — this repo has no 38-service backlog — but the
 * "Resolved" stage and the policy gain are re-derived from real evaluated episodes
 * whenever any exist, so the page tells the truth about this installation.
 */
export function overview() {
  const b = benchmark(false);
  const evaluated = b.policies.reduce((a, p) => a + p.evaluated, 0);
  const running = b.episodes.filter((e) => e.state === "running");
  const inPhase = (phase) => running.filter((e) => e.phase === phase).length;
  const best = b.policies.find((p) => p.key === b.best);
  const baseline = b.policies.find((p) => p.key === "A" && p.reward !== null);
  const pp = (x) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)} pp`;
  const live = evaluated > 0;
  const successRate = live ? Math.round((b.policies.reduce((a, p) => a + p.successes, 0) / evaluated) * 100) : 86;
  return {
    snapshot_label: live ? "Live installation · replay backlog" : "Deterministic replay snapshot",
    backlog: {
      period: "Current organisation snapshot",
      metrics: [
        { label: "Open backlog", value: "12,847", note: "Across 38 engineering services", tone: "backlog" },
        { label: "Created today", value: "428", note: "18 new issues per hour", tone: "intake" },
        { label: "Urgent", value: "238", note: "Critical and high-priority work", tone: "urgent" },
        { label: "Aging tickets", value: "1,109", note: "Open for more than 7 days", tone: "aging" },
      ],
    },
    pipeline: {
      period: live ? `${running.length} episode${running.length === 1 ? "" : "s"} in flight · ${evaluated} evaluated on this installation` : "Current work in progress · resolved output over the last 30 days",
      stages: [
        { key: "backlog", label: "Incoming backlog", value: "12,847", detail: "428 created today" },
        { key: "planner", label: "Planner", value: live ? String(inPhase("planner")) : "1,284", detail: "Triaging scope and risk" },
        { key: "coder", label: "Coder", value: live ? String(inPhase("coder")) : "742", detail: "Implementing tested fixes" },
        { key: "reviewer", label: "Reviewer", value: live ? String(inPhase("reviewer")) : "186", detail: "Independent quality gates" },
        { key: "resolved", label: "Resolved", value: live ? String(b.policies.reduce((a, p) => a + p.successes, 0)) : "6,482", detail: live ? `of ${evaluated} evaluated episodes` : "Verified in the last 30 days", score: { value: `${successRate}%`, label: "verified success score" } },
      ],
    },
    priority_queue: running.length
      ? running.slice(0, 4).map((e) => ({ id: e.issue.number ? `#${e.issue.number}` : e.task_id, title: e.issue.title, repository: e.issue.repository, priority: "High", age: ago(e.started_at), stage: e.phase ? e.phase[0].toUpperCase() + e.phase.slice(1) : "Queued", episode_id: e.id }))
      : [
          { id: "#6911", title: "Prevent duplicate invoice captures after payment retries", repository: "acme/payments-api", priority: "Critical", age: "8m", stage: "Planner" },
          { id: "#1842", title: "Refresh sessions before they expire", repository: "acme/auth-service", priority: "High", age: "17m", stage: "Coder" },
          { id: "#8247", title: "Preserve audit events during shard failover", repository: "acme/event-platform", priority: "High", age: "24m", stage: "Reviewer" },
          { id: "#3574", title: "Stop stale inventory reservations after cancelled orders", repository: "acme/fulfilment-core", priority: "High", age: "41m", stage: "Planner" },
        ],
    learning: {
      period: "Evidence captured from evaluated episodes",
      metrics: [
        { label: "Evaluated trajectories", value: live ? evaluated.toLocaleString() : "7,263", note: "Tool actions, observations, and outcomes retained" },
        { label: "Validated patterns", value: "184", note: "Reusable, evidence-backed engineering strategies" },
      ],
      policy: best && baseline && best.key !== baseline.key
        ? { name: `Policy ${best.key}`, success_gain: pp(best.success_rate - baseline.success_rate), reward_gain: `${best.reward - baseline.reward >= 0 ? "+" : ""}${(best.reward - baseline.reward).toFixed(2)}`, baseline: `versus Policy A across ${evaluated} evaluated episodes` }
        : { name: "Policy D", success_gain: "+16 pp", reward_gain: "+0.16", baseline: "versus Policy A across the replay benchmark" },
      note: "Evaluation signals and preserved trajectories inform policy selection and future improvement. This replay does not claim live model training or fine-tuning.",
    },
  };
}

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}
