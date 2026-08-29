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
}

export type Progress = (phase: string, detail?: string) => void;

export async function runEpisode(task: Task, policy: Policy, progress: Progress = () => {}): Promise<EpisodeResult> {
  const episodeId = `${task.task_id}-${policy.name}-${randomUUID().slice(0, 8)}`;
  const trajectory = new Trajectory(episodeId);
  const started = Date.now();
  const usage: AgentUsage[] = [];
  const base: EpisodeResult = { episode_id: episodeId, task_id: task.task_id, policy: policy.name, status: "done", sandboxes: {} };
  const live = new Set<RepoSandbox>();

  // Each phase gets its own machine, cloned at the base commit. Phases hand
  // off through artifacts (plan JSON, git patch), never through shared state.
  async function boot(phase: "planner" | "coder" | "reviewer"): Promise<RepoSandbox> {
    progress(phase, "boot sandbox");
    const sb = await bootRepoSandbox({ episode: episodeId, task: task.task_id, phase });
    live.add(sb);
    (base.sandboxes[phase] ??= []).push(sb.id);
    await sb.clone(task.repository, task.base_commit);
    if (task.setup_command) {
      const r = await sb.exec(task.setup_command);
      if (r.exitCode !== 0) throw new Error(`setup failed in ${phase} sandbox: ${r.output.slice(-500)}`);
    }
    return sb;
  }
  async function release(sb: RepoSandbox): Promise<void> {
    live.delete(sb);
    await sb.terminate().catch(() => {});
  }

  try {
    // Phase 1 — planner, read-only, then decide whether the issue is worth a coder.
    let plan: Plan | undefined;
    if (policy.planner) {
      const sb = await boot("planner");
      progress("planner");
      const p = await runPlanner(task, sb, trajectory, policy.effort?.planner);
      await release(sb);
      plan = p.plan;
      usage.push(p.result.usage);
      const confidence = plan?.confidence ?? 0;
      progress("planner", `confidence ${confidence.toFixed(2)} (gate ${policy.minConfidence})`);
      if (confidence < policy.minConfidence) {
        const result: EpisodeResult = { ...base, status: "abstained", plan };
        trajectory.artifact("result", { ...result, wall_ms: Date.now() - started, usage });
        return result;
      }
    }

    // Phase 2 — coder gets its own machine; the patch is what leaves it.
    const coderSb = await boot("coder");
    let review: Review | undefined;
    let patch = "";
    let attempt = 0;
    while (true) {
      progress("coder", attempt ? `retry ${attempt}` : undefined);
      const c = await runCoder(task, coderSb, trajectory, { plan, feedback: review, effort: policy.effort?.coder });
      usage.push(c.usage);
      patch = await gitDiff(coderSb);
      if (!policy.reviewer) break;

      // Phase 3 — reviewer on a fresh machine with only the patch applied, so it
      // sees exactly what a PR would contain and nothing the coder left behind.
      const reviewSb = await boot("reviewer");
      await applyPatch(reviewSb, patch);
      const tests = await reviewSb.exec(task.test_command);
      progress("reviewer");
      const r = await runReviewer(task, reviewSb, trajectory, patch, `exit ${tests.exitCode}\n${tests.output.slice(-3000)}`, policy.effort?.reviewer);
      await release(reviewSb);
      review = r.review;
      usage.push(r.result.usage);
      if (review.verdict === "approve" || attempt >= policy.maxRetries) break;
      attempt++;
    }

    // Freeze: the coder sandbox stops being acted on and becomes the thing measured.
    progress("eval");
    const tests = await coderSb.exec(task.test_command);
    const hidden = await coderSb.exec(task.evaluation_command);
    const changed = (await coderSb.exec("git status --porcelain")).output;
    await release(coderSb);
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
    trajectory.artifact("diff", { diff: patch });
    const result: EpisodeResult = { ...base, eval: ev, diff: patch, review, plan };
    trajectory.artifact("result", result);
    return result;
  } catch (err) {
    const result: EpisodeResult = { ...base, status: "error", error: (err as Error).message };
    trajectory.artifact("result", result);
    return result;
  } finally {
    for (const sb of live) await release(sb);
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
