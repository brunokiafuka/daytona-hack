import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { runCoder } from "./agents/coder.js";
import { runPlanner } from "./agents/planner.js";
import type { Plan } from "./agents/planner.js";
import { runReviewer } from "./agents/reviewer.js";
import type { Review } from "./agents/reviewer.js";
import { evaluateEpisode } from "./eval.js";
import type { EpisodeEval } from "./eval.js";
import { bootRepoSandbox } from "./sandbox.js";
import type { RepoSandbox } from "./sandbox.js";
import type { Task } from "./tasks.js";
import { Trajectory } from "./trajectory.js";
import type { AgentUsage } from "./trajectory.js";

/**
 * §10/§12 — a policy is which agents run and how. The orchestrator runs one
 * episode of one policy on one task: sandbox → agents → eval → reward.
 */
export type { Effort } from "./agent.js";
import type { Effort } from "./agent.js";
import { modelFor } from "./agent.js";

export interface Policy {
  name: string;
  planner: boolean;
  reviewer: boolean;
  /** Reviewer → Coder retry loop (§5). 0 = reviewer is a pure gate. */
  maxRetries: number;
  /** Planner confidence below this aborts before any execution sandbox is created. */
  minConfidence: number;
  effort?: Partial<Record<"planner" | "coder" | "reviewer", Effort>>;
}

export const POLICIES: Record<string, Policy> = {
  A: { name: "planner+coder+reviewer", planner: true, reviewer: true, maxRetries: 0, minConfidence: 0.6 },
  B: { name: "planner+coder", planner: true, reviewer: false, maxRetries: 0, minConfidence: 0.6 },
  C: { name: "coder+reviewer", planner: false, reviewer: true, maxRetries: 0, minConfidence: 0 },
  D: { name: "planner+coder+reviewer+retry", planner: true, reviewer: true, maxRetries: 2, minConfidence: 0.6 },
};

export interface EpisodeResult {
  episode_id: string;
  task_id: string;
  policy: string;
  status: "done" | "abstained" | "error";
  error?: string;
  eval?: EpisodeEval;
  diff?: string;
  review?: Review;
  plan?: Plan;
  /** One sandbox per phase: planner, coder, reviewer (per attempt). */
  sandboxes: Partial<Record<"planner" | "coder" | "reviewer", string[]>>;
  started_at?: string;
  finished_at?: string;
  wall_ms?: number;
  usage?: AgentUsage[];
  /** Set when the episode is part of an experiment run. */
  experiment_id?: string;
}

export type Progress = (phase: string, detail?: string) => void;

/** Episodes in flight register a canceller here so SIGTERM (dashboard "stop") releases sandboxes. */
const inFlight = new Set<() => Promise<void>>();
let shuttingDown = false;
export async function shutdownEpisodes(reason = "stopped"): Promise<void> {
  shuttingDown = true;
  await Promise.all([...inFlight].map((f) => f().catch(() => {})));
}
export function installShutdownHandlers(): void {
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, async () => {
      console.log(`\n${sig}: releasing sandboxes…`);
      await shutdownEpisodes();
      process.exit(130);
    });
  }
}

export interface RunOptions {
  /** Pre-assigned id (the dashboard trigger allocates one so it can follow the run immediately). */
  episodeId?: string;
  experimentId?: string;
}

export function newEpisodeId(task: Task, policy: Policy): string {
  return `${task.task_id}-${policy.name}-${randomUUID().slice(0, 8)}`;
}

export async function runEpisode(task: Task, policy: Policy, progress: Progress = () => {}, opts: RunOptions = {}): Promise<EpisodeResult> {
  const episodeId = opts.episodeId ?? newEpisodeId(task, policy);
  const trajectory = new Trajectory(episodeId);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const usage: AgentUsage[] = [];
  const base: EpisodeResult = { episode_id: episodeId, task_id: task.task_id, policy: policy.name, status: "done", sandboxes: {}, started_at: startedAt, experiment_id: opts.experimentId };
  const live = new Set<RepoSandbox>();
  // The task is copied into the episode so the dashboard can show the issue
  // without the evaluation command (agents and viewers never see the oracle).
  const { evaluation_command: _hidden, ...visibleTask } = task;
  trajectory.artifact("task", visibleTask);
  trajectory.status({ task_id: task.task_id, policy: policy.name, phase: "init", experiment_id: opts.experimentId, models: { planner: modelFor("planner"), coder: modelFor("coder"), reviewer: modelFor("reviewer") } });

  const note: Progress = (phase, detail) => {
    trajectory.status({ phase, detail });
    trajectory.log(phase, detail ?? phase);
    progress(phase, detail);
  };
  const finish = (result: EpisodeResult): EpisodeResult => {
    const full: EpisodeResult = { ...result, finished_at: new Date().toISOString(), wall_ms: Date.now() - started, usage };
    trajectory.artifact("result", full);
    trajectory.status({ state: full.status, phase: "finished", detail: full.status === "error" ? full.error : undefined, finished_at: full.finished_at, usage });
    return full;
  };

  // Run a sandbox command on behalf of the orchestrator and keep its output as evidence.
  async function run(sb: RepoSandbox, phase: string, label: string, cmd: string, cwd?: string) {
    const t0 = Date.now();
    const r = await sb.exec(cmd, cwd);
    trajectory.log(phase, `${label}: ${cmd}`, { output: r.output.slice(-12_000), exit_code: r.exitCode, duration_ms: Date.now() - t0, level: r.exitCode === 0 ? "info" : "warn" });
    return r;
  }

  // Each phase gets its own machine, cloned at the base commit. Phases hand
  // off through artifacts (plan JSON, git patch), never through shared state.
  async function boot(phase: "planner" | "coder" | "reviewer"): Promise<RepoSandbox> {
    note(phase, "boot sandbox");
    const t0 = Date.now();
    const sb = await bootRepoSandbox({ episode: episodeId, task: task.task_id, phase });
    live.add(sb);
    (base.sandboxes[phase] ??= []).push(sb.id);
    trajectory.log(phase, `sandbox ${sb.id} booted`, { duration_ms: Date.now() - t0 });
    trajectory.status({ sandboxes: base.sandboxes, detail: `sandbox ${sb.id.slice(0, 8)} · clone ${task.repository}@${task.base_commit.slice(0, 10)}` });
    const t1 = Date.now();
    await sb.clone(task.repository, task.base_commit);
    trajectory.log(phase, `cloned ${task.repository}@${task.base_commit}`, { duration_ms: Date.now() - t1 });
    if (task.setup_command) {
      trajectory.status({ detail: `sandbox ${sb.id.slice(0, 8)} · setup` });
      const r = await run(sb, phase, "setup", task.setup_command);
      if (r.exitCode !== 0) throw new Error(`setup failed in ${phase} sandbox: ${r.output.slice(-500)}`);
    }
    return sb;
  }
  async function release(sb: RepoSandbox, phase: string): Promise<void> {
    live.delete(sb);
    await sb.terminate().catch(() => {});
    trajectory.log(phase, `sandbox ${sb.id} released`);
  }

  const cancel = async () => {
    for (const sb of live) await release(sb, "cleanup");
    if (trajectory.status({}).state === "running") finish({ ...base, status: "error", error: "stopped by user" });
  };
  inFlight.add(cancel);

  try {
    if (shuttingDown) throw new Error("stopped by user");
    // Phase 1 — planner, read-only, then decide whether the issue is worth a coder.
    let plan: Plan | undefined;
    if (policy.planner) {
      const sb = await boot("planner");
      note("planner", "investigating");
      const p = await runPlanner(task, sb, trajectory, policy.effort?.planner);
      await release(sb, "planner");
      plan = p.plan;
      usage.push(p.result.usage);
      trajectory.status({ usage });
      const confidence = plan?.confidence ?? 0;
      note("planner", `confidence ${confidence.toFixed(2)} (gate ${policy.minConfidence})`);
      if (confidence < policy.minConfidence) {
        trajectory.log("planner", `abstained: confidence ${confidence.toFixed(2)} below gate ${policy.minConfidence}`, { level: "warn" });
        return finish({ ...base, status: "abstained", plan });
      }
    }

    // Phase 2 — coder gets its own machine; the patch is what leaves it.
    const coderSb = await boot("coder");
    let review: Review | undefined;
    let patch = "";
    let attempt = 0;
    while (true) {
      trajectory.status({ attempt });
      note("coder", attempt ? `retry ${attempt} (reviewer feedback)` : "implementing");
      const c = await runCoder(task, coderSb, trajectory, { plan, feedback: review, effort: policy.effort?.coder });
      usage.push(c.usage);
      trajectory.status({ usage });
      patch = await gitDiff(coderSb);
      trajectory.artifact("diff", { diff: patch, attempt });
      trajectory.log("coder", `patch captured (${patch.length} bytes, stopped by ${c.stopped_by})`);
      if (!policy.reviewer) break;

      // Phase 3 — reviewer on a fresh machine with only the patch applied, so it
      // sees exactly what a PR would contain and nothing the coder left behind.
      const reviewSb = await boot("reviewer");
      await applyPatch(reviewSb, patch);
      trajectory.status({ detail: "running visible tests on patched sandbox" });
      const tests = await run(reviewSb, "reviewer", "tests", task.test_command);
      note("reviewer", "reviewing patch");
      const r = await runReviewer(task, reviewSb, trajectory, patch, `exit ${tests.exitCode}\n${tests.output.slice(-3000)}`, policy.effort?.reviewer);
      await release(reviewSb, "reviewer");
      review = r.review;
      usage.push(r.result.usage);
      trajectory.status({ usage });
      note("reviewer", `${review.verdict}${review.issues.length ? `: ${review.issues[0]}` : ""}`);
      if (review.verdict === "approve" || attempt >= policy.maxRetries) break;
      attempt++;
    }

    // Freeze: the coder sandbox stops being acted on and becomes the thing measured.
    note("eval", "visible tests");
    const tests = await run(coderSb, "eval", "tests", task.test_command);
    note("eval", "hidden evaluation");
    const hidden = await coderSb.exec(task.evaluation_command);
    // The oracle's command line stays hidden; its verdict and output do not.
    trajectory.log("eval", "hidden evaluation", { output: hidden.output.slice(-12_000), exit_code: hidden.exitCode, level: hidden.exitCode === 0 ? "info" : "warn" });
    const changed = (await run(coderSb, "eval", "changed files", "git status --porcelain")).output;
    await release(coderSb, "coder");
    const protectedPaths = task.protected_paths ?? ["test", "tests", "__tests__", "spec"];
    const testsUntouched = !changed.split("\n").some((l) => {
      const p = l.slice(3).trim();
      return protectedPaths.some((pp) => p.startsWith(pp + "/") || p.includes(`/${pp}/`)) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)test_.*\.py$/.test(p);
    });

    const ev = evaluateEpisode({
      task,
      testsPass: tests.exitCode === 0,
      hiddenPass: hidden.exitCode === 0,
      testsUntouched,
      diff: patch,
      review,
      plan,
      coderSteps: trajectory.stepsFor("coder"),
      coderTestRuns: countTestRuns(trajectory, task.test_command),
      usage,
      wallMs: Date.now() - started,
    });
    trajectory.artifact("eval", ev);
    note("eval", `${ev.success ? "success" : "failed"} reward ${ev.reward.toFixed(2)}`);
    return finish({ ...base, eval: ev, diff: patch, review, plan });
  } catch (err) {
    const message = (err as Error).message;
    trajectory.log("error", message, { level: "error" });
    return finish({ ...base, status: "error", error: message });
  } finally {
    inFlight.delete(cancel);
    for (const sb of live) await release(sb, "cleanup");
  }
}

async function applyPatch(sandbox: RepoSandbox, patch: string): Promise<void> {
  if (!patch.trim()) return;
  await sandbox.writeFile(".agent.patch", patch);
  const r = await sandbox.exec("git apply --whitespace=nowarn .agent.patch && rm .agent.patch");
  if (r.exitCode !== 0) throw new Error(`patch did not apply in reviewer sandbox: ${r.output.slice(-500)}`);
}

async function gitDiff(sandbox: RepoSandbox): Promise<string> {
  await sandbox.exec("git add -N .");
  return (await sandbox.exec("git diff")).output;
}

function countTestRuns(trajectory: Trajectory, testCommand: string): number {
  // Cheap heuristic over the recorded events: the test command's first token.
  const head = testCommand.split(/\s+/)[0] ?? testCommand;
  try {
    return readFileSync(`${trajectory.dir}/events.jsonl`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { agent: string; action: { tool: string; input: { command?: string } } })
      .filter((e) => e.agent === "coder" && e.action.tool === "bash" && String(e.action.input.command ?? "").includes(head)).length;
  } catch {
    return 0;
  }
}
