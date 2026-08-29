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
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Policy {
  name: string;
  planner: boolean;
  reviewer: boolean;
  /** Reviewer → Coder retry loop (§5). 0 = reviewer is a pure gate. */
  maxRetries: number;
  effort?: Partial<Record<"planner" | "coder" | "reviewer", Effort>>;
}

export const POLICIES: Record<string, Policy> = {
  A: { name: "planner+coder+reviewer", planner: true, reviewer: true, maxRetries: 0 },
  B: { name: "planner+coder", planner: true, reviewer: false, maxRetries: 0 },
  C: { name: "coder+reviewer", planner: false, reviewer: true, maxRetries: 0 },
  D: { name: "planner+coder+reviewer+retry", planner: true, reviewer: true, maxRetries: 2 },
};

export interface EpisodeResult {
  episode_id: string;
  task_id: string;
  policy: string;
  status: "done" | "error";
  error?: string;
  eval?: EpisodeEval;
  diff?: string;
  review?: Review;
  plan?: Plan;
  sandbox_id?: string;
}

export type Progress = (phase: string, detail?: string) => void;

export async function runEpisode(task: Task, policy: Policy, progress: Progress = () => {}): Promise<EpisodeResult> {
  const episodeId = `${task.task_id}-${policy.name}-${randomUUID().slice(0, 8)}`;
  const trajectory = new Trajectory(episodeId);
  const started = Date.now();
  const usage: AgentUsage[] = [];
  let sandbox: RepoSandbox | undefined;
  const base: EpisodeResult = { episode_id: episodeId, task_id: task.task_id, policy: policy.name, status: "done" };

  try {
    progress("sandbox", "booting");
    sandbox = await bootRepoSandbox({ episode: episodeId, task: task.task_id });
    base.sandbox_id = sandbox.id;
    progress("sandbox", `clone ${task.repository}@${task.base_commit.slice(0, 7)}`);
    await sandbox.clone(task.repository, task.base_commit);
    if (task.setup_command) {
      progress("sandbox", "setup");
      const s = await sandbox.exec(task.setup_command);
      if (s.exitCode !== 0) throw new Error(`setup failed: ${s.output.slice(-500)}`);
    }

    let plan: Plan | undefined;
    if (policy.planner) {
      progress("planner");
      const p = await runPlanner(task, sandbox, trajectory, policy.effort?.planner);
      plan = p.plan;
      usage.push(p.result.usage);
    }

    let review: Review | undefined;
    let attempt = 0;
    while (true) {
      progress("coder", attempt ? `retry ${attempt}` : undefined);
      const c = await runCoder(task, sandbox, trajectory, { plan, feedback: review, effort: policy.effort?.coder });
      usage.push(c.usage);
      if (!policy.reviewer) break;

      const diff = await gitDiff(sandbox);
      const tests = await sandbox.exec(task.test_command);
      progress("reviewer");
      const r = await runReviewer(task, sandbox, trajectory, diff, `exit ${tests.exitCode}\n${tests.output.slice(-3000)}`, policy.effort?.reviewer);
      review = r.review;
      usage.push(r.result.usage);
      if (review.verdict === "approve" || attempt >= policy.maxRetries) break;
      attempt++;
    }

    // Freeze: everything below is measurement, the agents no longer act.
    progress("eval");
    const diff = await gitDiff(sandbox);
    const tests = await sandbox.exec(task.test_command);
    const hidden = await sandbox.exec(task.evaluation_command);
    const changed = (await sandbox.exec("git status --porcelain")).output;
    const protectedPaths = task.protected_paths ?? ["test", "tests", "__tests__", "spec"];
    const testsUntouched = !changed.split("\n").some((l) => {
      const p = l.slice(3).trim();
      return protectedPaths.some((pp) => p.startsWith(pp + "/") || p.includes(`/${pp}/`)) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)test_.*\.py$/.test(p);
    });
    const coderTestRuns = countTestRuns(trajectory, task.test_command);

    const ev = evaluateEpisode({
      task,
      testsPass: tests.exitCode === 0,
      hiddenPass: hidden.exitCode === 0,
      testsUntouched,
      diff,
      review,
      plan,
      coderSteps: trajectory.stepsFor("coder"),
      coderTestRuns,
      usage,
      wallMs: Date.now() - started,
    });
    trajectory.artifact("eval", ev);
    trajectory.artifact("diff", { diff });
    const result: EpisodeResult = { ...base, eval: ev, diff, review, plan };
    trajectory.artifact("result", result);
    return result;
  } catch (err) {
    const result: EpisodeResult = { ...base, status: "error", error: (err as Error).message };
    trajectory.artifact("result", result);
    return result;
  } finally {
    if (sandbox) {
      progress("sandbox", "terminate");
      await sandbox.terminate().catch(() => {});
    }
  }
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
