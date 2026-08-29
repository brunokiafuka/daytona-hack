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

The issue may be a bug or a feature request. Understand enough of the codebase to say concretely where and how it should be addressed, then answer with a single JSON object and nothing after it:
{"diagnosis": "<for a bug: what is wrong and why; for a feature: what exists today and what is missing>", "files": ["<paths the change must touch or create>"], "plan": ["<concrete step>", ...], "confidence": <0.0-1.0>, "concerns": ["<anything that makes you doubt the plan>"]}

Work with a small budget: you get about a dozen tool calls. Start with structure (\`find . -path ./node_modules -prune -o -type f -name '*.ts*' -print | head -80\`, \`cat package.json\`), then read only the 3–6 files that matter (\`sed -n\` ranges, \`grep -rn\`). Do not page through whole directories. Answer as soon as you can name real files and functions; do not keep exploring to be thorough. Never modify anything.

confidence is a gate: the system only spends an execution sandbox on this issue if your confidence is high enough. Be calibrated — 0.9+ means the change is mechanical and localised; 0.5 means you have a plausible design; below 0.3 means the issue is ambiguous, needs decisions only the maintainers can make, or the environment is broken. Low confidence with honest concerns is a good answer; false confidence is the worst one. Always emit the JSON, even when unsure.`;

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
      maxSteps: 18,
      maxWallMs: 8 * 60_000,
      guard: (tool, input) =>
        tool === "bash" && /(>|>>|\brm\b|\bmv\b|\bsed -i|git (commit|push|checkout|reset))/.test(String(input.command).replace(/\d?>\s*\/dev\/null/g, ""))
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
