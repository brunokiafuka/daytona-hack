import { SANDBOX_TOOLS, runAgent, sandboxExecutor } from "../agent.js";
import type { AgentResult } from "../agent.js";
import type { RepoSandbox } from "../sandbox.js";
import type { Task } from "../tasks.js";
import type { Trajectory } from "../trajectory.js";
import type { Plan } from "./planner.js";
import type { Review } from "./reviewer.js";

/**
 * §4 — closed loop: implement → run tests → observe → fix → … → pass.
 * Test files are protected: the cheapest way to make tests pass is to edit
 * them, and the reward would happily pay for it.
 */
const SYSTEM = `You are the Coder in an autonomous engineering system. Your job is to resolve the GitHub issue in the sandboxed repository so that the test command passes.

Work in a closed loop: make a change, run the tests, read the failure, fix, run again. Do not stop at a patch — stop only when the test command exits 0, or when you are certain the remaining failures are pre-existing and unrelated (say so explicitly).

Rules:
- Never modify test files or test fixtures. If a test looks wrong, say so in your final message instead.
- Keep the change minimal and idiomatic for the codebase.
- Do not commit; leave changes in the working tree.

When done, reply with a short summary of what you changed and the final test result.`;

export async function runCoder(
  task: Task,
  sandbox: RepoSandbox,
  trajectory: Trajectory,
  opts: { plan?: Plan; feedback?: Review; effort?: "low" | "medium" | "high" | "xhigh" | "max" },
): Promise<AgentResult> {
  const protectedPaths = task.protected_paths ?? ["test", "tests", "__tests__", "spec"];
  const isProtected = (p: string) => protectedPaths.some((pp) => p === pp || p.startsWith(pp + "/") || p.includes(`/${pp}/`) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)test_.*\.py$/.test(p));

  const parts = [
    `Repository: ${task.repository} @ ${task.base_commit}`,
    `Test command: ${task.test_command}`,
    task.setup_command ? `Dependencies are already installed via: ${task.setup_command}` : "",
    `\nIssue:\n${task.issue}`,
  ];
  if (opts.plan) parts.push(`\nPlanner's plan:\n${JSON.stringify(opts.plan, null, 2)}`);
  if (opts.feedback) parts.push(`\nThe Reviewer rejected the previous attempt. Address these issues:\n${opts.feedback.issues.map((i) => `- ${i}`).join("\n")}`);

  return runAgent(
    {
      name: "coder",
      system: SYSTEM,
      tools: [SANDBOX_TOOLS.bash!, SANDBOX_TOOLS.read_file!, SANDBOX_TOOLS.write_file!],
      effort: opts.effort ?? "xhigh",
      maxSteps: 60,
      maxWallMs: 20 * 60_000,
      guard: (tool, input) => {
        const path = String(input.path ?? "");
        if (tool === "write_file" && isProtected(path)) return `Refused: ${path} is a protected test path.`;
        if (tool === "bash" && /git (commit|push|checkout|reset|stash)/.test(String(input.command))) return "Refused: git history is managed by the orchestrator.";
        return undefined;
      },
    },
    parts.filter(Boolean).join("\n"),
    sandboxExecutor(sandbox),
    trajectory,
  );
}
