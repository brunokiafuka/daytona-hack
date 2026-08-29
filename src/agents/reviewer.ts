import { parseJson, runAgent, sandboxExecutor } from "../agent.js";
import type { AgentResult, Effort } from "../agent.js";
import type { RepoSandbox } from "../sandbox.js";
import type { Task } from "../tasks.js";
import type { Trajectory } from "../trajectory.js";

/**
 * §5 — independent gate before the PR. A discrete rubric rather than a
 * free-floating 0..1 score: LLM scalar scores are poorly calibrated, four
 * booleans are not.
 */
export interface Review {
  verdict: "approve" | "reject";
  issues: string[];
  rubric: {
    resolves_issue: boolean;
    no_regressions: boolean;
    minimal_change: boolean;
    tests_untouched: boolean;
  };
}

const SYSTEM = `You are the Reviewer in an autonomous engineering system. A Coder has changed the repository to resolve a GitHub issue. Independently decide whether the change is ready to be opened as a PR.

You have read-only tools. Inspect the diff, read surrounding code, and run the tests yourself. Look for: requirements the change misses, regressions, edits to tests, unnecessary changes.

Answer with a single JSON object and nothing after it:
{"verdict": "approve" | "reject", "issues": ["<specific, actionable problem>", ...], "rubric": {"resolves_issue": bool, "no_regressions": bool, "minimal_change": bool, "tests_untouched": bool}}

Reject if any rubric item is false.`;

export async function runReviewer(
  task: Task,
  sandbox: RepoSandbox,
  trajectory: Trajectory,
  diff: string,
  testOutput: string,
  effort?: Effort,
): Promise<{ review: Review; result: AgentResult }> {
  const result = await runAgent(
    {
      name: "reviewer",
      system: SYSTEM,
      tools: ["bash", "read_file"],
      effort,
      maxSteps: 20,
      maxWallMs: 8 * 60_000,
      guard: (tool, input) =>
        tool === "bash" && /(>|>>|\bsed -i|git (commit|push|checkout|reset|stash))/.test(String(input.command))
          ? "Reviewer is read-only."
          : undefined,
    },
    `Issue:\n${task.issue}\n\nTest command: ${task.test_command}\nLast test run (exit code and tail):\n${testOutput}\n\nDiff:\n${diff}`,
    sandboxExecutor(sandbox),
    trajectory,
  );
  const review = parseJson<Review>(result.text) ?? {
    verdict: "reject",
    issues: ["Reviewer produced no parseable verdict."],
    rubric: { resolves_issue: false, no_regressions: false, minimal_change: false, tests_untouched: false },
  };
  trajectory.artifact("review", { review, stopped_by: result.stopped_by, usage: result.usage });
  return { review, result };
}
