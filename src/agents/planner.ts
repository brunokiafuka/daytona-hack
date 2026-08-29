import { parseJson, runAgent, sandboxExecutor } from "../agent.js";
import type { AgentResult, Effort } from "../agent.js";
import type { RepoSandbox } from "../sandbox.js";
import type { Task } from "../tasks.js";
import type { Trajectory } from "../trajectory.js";

/** §3 — understand the issue, produce an implementation plan. Read-only. */
export interface Plan {
  diagnosis: string;
  files: string[];
  plan: string[];
  /** 0..1 — how sure the planner is that the plan resolves the issue. Gates the next phase. */
  confidence: number;
  /** Why the planner would rather not proceed (unclear issue, can't reproduce, env broken…). */
  concerns?: string[];
}

const SYSTEM = `You are the Planner in an autonomous engineering system. You are given a GitHub issue and read-only access to the repository in a sandbox.

Investigate until you understand the root cause, then answer with a single JSON object and nothing after it:
{"diagnosis": "<what is wrong and why>", "files": ["<paths the fix must touch>"], "plan": ["<concrete step>", ...], "confidence": <0.0-1.0>, "concerns": ["<anything that makes you doubt the plan>"]}

Be precise: name real files and functions you have looked at. Do not modify anything.

confidence is a gate: the system only spends an execution sandbox on this issue if your confidence is high enough. Be calibrated — 0.9+ means you located the bug and the fix is mechanical; 0.5 means you have a hypothesis; below 0.3 means the issue is ambiguous, not reproducible, or the environment is broken. Low confidence with honest concerns is a good answer; false confidence is the worst one.`;

export async function runPlanner(
  task: Task,
  sandbox: RepoSandbox,
  trajectory: Trajectory,
  effort?: Effort,
): Promise<{ plan: Plan | undefined; result: AgentResult }> {
  const exec = sandboxExecutor(sandbox);
  const result = await runAgent(
    {
      name: "planner",
      system: SYSTEM,
      tools: ["bash", "read_file"],
      effort,
      maxSteps: 25,
      maxWallMs: 8 * 60_000,
      guard: (tool, input) =>
        tool === "bash" && /(>|>>|\brm\b|\bmv\b|\bsed -i|git (commit|push|checkout|reset))/.test(String(input.command))
          ? "Planner is read-only; use the coder for changes."
          : undefined,
    },
    `Repository: ${task.repository} @ ${task.base_commit}\nTest command: ${task.test_command}\n\nIssue:\n${task.issue}`,
    exec,
    trajectory,
  );
  const plan = parseJson<Plan>(result.text);
  trajectory.artifact("plan", { plan, stopped_by: result.stopped_by, usage: result.usage });
  return { plan, result };
}
