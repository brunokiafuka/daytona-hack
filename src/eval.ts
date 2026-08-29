import type { AgentUsage } from "./trajectory.js";
import type { Plan } from "./agents/planner.js";
import type { Review } from "./agents/reviewer.js";
import type { Task } from "./tasks.js";

/**
 * §8/§9 — episode-level evaluation and reward. Hard signals come from the
 * sandbox after the agents are done (hidden evaluation command, tests,
 * diff hygiene); soft signals from the reviewer and the trajectory.
 */
export interface EpisodeEval {
  hard: {
    tests_pass: boolean;
    hidden_eval_pass: boolean;
    tests_untouched: boolean;
    diff_nonempty: boolean;
  };
  soft: {
    reviewer_approved: boolean;
    coder_steps: number;
    coder_iterations: number; // test runs
    planner_file_precision?: number;
    planner_file_recall?: number;
  };
  cost: { input_tokens: number; output_tokens: number; wall_ms: number };
  success: boolean;
  reward: number;
}

export interface EvalInputs {
  task: Task;
  testsPass: boolean;
  hiddenPass: boolean;
  testsUntouched: boolean;
  diff: string;
  review?: Review;
  plan?: Plan;
  coderSteps: number;
  coderTestRuns: number;
  usage: AgentUsage[];
  wallMs: number;
}

export function evaluateEpisode(i: EvalInputs): EpisodeEval {
  const hard = {
    tests_pass: i.testsPass,
    hidden_eval_pass: i.hiddenPass,
    tests_untouched: i.testsUntouched,
    diff_nonempty: i.diff.trim().length > 0,
  };
  const soft: EpisodeEval["soft"] = {
    reviewer_approved: i.review?.verdict === "approve",
    coder_steps: i.coderSteps,
    coder_iterations: i.coderTestRuns,
  };
  if (i.plan && i.task.reference_files?.length) {
    const ref = new Set(i.task.reference_files);
    const got = new Set(i.plan.files);
    const hit = [...got].filter((f) => ref.has(f)).length;
    soft.planner_file_precision = got.size ? hit / got.size : 0;
    soft.planner_file_recall = hit / ref.size;
  }
  const cost = {
    input_tokens: i.usage.reduce((a, u) => a + u.input_tokens, 0),
    output_tokens: i.usage.reduce((a, u) => a + u.output_tokens, 0),
    wall_ms: i.wallMs,
  };

  // Success is the hidden oracle, and only the hidden oracle.
  const success = hard.hidden_eval_pass && hard.tests_untouched;

  // Reward: success dominates; efficiency penalties are large enough to
  // reorder two successful policies, small enough never to beat a solve.
  let reward = 0;
  if (hard.hidden_eval_pass) reward += 0.7;
  if (hard.tests_pass) reward += 0.1;
  if (hard.tests_untouched) reward += 0.1;
  if (soft.planner_file_recall !== undefined) reward += 0.1 * soft.planner_file_recall;
  reward -= Math.min(0.15, Math.max(0, i.coderSteps - 20) * 0.01); // unnecessary actions
  reward -= Math.min(0.1, Math.max(0, i.coderTestRuns - 5) * 0.02); // excessive iterations
  reward = Math.max(0, Math.min(1, reward));

  return { hard, soft, cost, success, reward };
}
