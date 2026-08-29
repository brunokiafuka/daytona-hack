import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";

import { fetchIssue, parseIssueRef, saveTask, taskFromIssue } from "./github.js";
import { LEARNED_FILE, allocate, writeLearned } from "./learn.js";
import { POLICIES, installShutdownHandlers, runEpisode } from "./orchestrator.js";
import type { EpisodeResult, Policy } from "./orchestrator.js";
import { bootRepoSandbox } from "./sandbox.js";
import { listTasks, loadTask } from "./tasks.js";
import type { Task } from "./tasks.js";

/**
 * CLI.
 *   pnpm episode <task-id> [policy]          one episode (default policy A)
 *   pnpm issue <owner/repo#N|url> [policy]   live run: import the GitHub issue as a task, then one episode
 *                                            policy `auto`: ROLLOUTS parallel sandboxes allocated from the learned posterior, best reward wins
 *   pnpm learn                               recompute .data/learned.json (policy posterior + next allocation) and print it
 *   pnpm tasks:import <owner/repo> <N,N,..>  import issues as benchmark tasks (tasks/<repo>-<N>.json)
 *   pnpm experiment [policies] [tasks]       e.g. `pnpm experiment A,B,D` or `A,D scribl-15,scribl-16`
 *   pnpm sandbox:smoke                       boot a sandbox, run a command, tear down
 *
 * Env: EPISODE_ID / EXPERIMENT_ID pre-assign ids (used by the dashboard trigger), CONCURRENCY for experiments, ROLLOUTS for `auto`.
 */
const [cmd, ...rest] = process.argv.slice(2);
installShutdownHandlers();

const log = (episode: string) => (phase: string, detail?: string) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${episode}  ${phase}${detail ? `  ${detail}` : ""}`);

function policy(key: string): Policy {
  const p = POLICIES[key];
  if (!p) throw new Error(`unknown policy ${key}; have ${Object.keys(POLICIES).join(", ")}`);
  return p;
}

function summarize(r: EpisodeResult): string {
  if (r.status === "error") return `ERROR ${r.error}`;
  if (r.status === "abstained") return `— abstained (confidence ${(r.plan?.confidence ?? 0).toFixed(2)}) ${r.plan?.concerns?.join("; ") ?? ""}`;
  const e = r.eval!;
  return `${e.success ? "✓" : "✗"} reward=${e.reward.toFixed(2)} hidden=${e.hard.hidden_eval_pass} tests=${e.hard.tests_pass} reviewer=${e.soft.reviewer_approved} steps=${e.soft.coder_steps} iters=${e.soft.coder_iterations} tokens=${e.cost.input_tokens + e.cost.output_tokens} ${(e.cost.wall_ms / 1000).toFixed(0)}s`;
}

async function importIssues(slug: string, numbers: number[]): Promise<Task[]> {
  const tasks: Task[] = [];
  for (const n of numbers) {
    const issue = await fetchIssue({ slug, number: n });
    const task = taskFromIssue({ slug, number: n }, issue);
    const file = saveTask(task);
    console.log(`imported #${n} "${issue.title}" @ ${issue.head_commit.slice(0, 10)} → ${file}`);
    tasks.push(task);
  }
  return tasks;
}

async function experiment(policies: Policy[], tasks: Task[], experimentId?: string): Promise<void> {
  const concurrency = Number(process.env.CONCURRENCY ?? 3);
  const jobs = policies.flatMap((p) => tasks.map((t) => ({ p, t })));
  const results: EpisodeResult[] = [];
  console.log(`experiment ${experimentId ?? ""}: ${policies.length} policies × ${tasks.length} tasks, concurrency ${concurrency}`);
  // Simple worker pool — Daytona sandboxes are the unit of parallelism.
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      for (let j = jobs.shift(); j; j = jobs.shift()) {
        const r = await runEpisode(j.t, j.p, log(`${j.t.task_id}/${j.p.name}`), { experimentId });
        console.log(`${r.episode_id}: ${summarize(r)}`);
        results.push(r);
      }
    }),
  );
  writeLearned();
  mkdirSync(".data/experiments", { recursive: true });
  const file = `.data/experiments/${experimentId ?? new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(results, null, 2));

  console.log("\nExperiment Results\n");
  console.log(`${"policy".padEnd(32)} ${"success".padStart(8)} ${"reward".padStart(7)} ${"steps".padStart(6)} ${"tokens".padStart(9)}`);
  for (const p of policies) {
    const all = results.filter((r) => r.policy === p.name);
    const rs = all.filter((r) => r.eval);
    const abstained = all.filter((r) => r.status === "abstained").length;
    const n = rs.length;
    const ok = rs.filter((r) => r.eval!.success).length;
    const avg = (f: (r: EpisodeResult) => number) => (n ? rs.reduce((a, r) => a + f(r), 0) / n : 0);
    console.log(
      `${p.name.padEnd(32)} ${`${ok}/${n}`.padStart(8)} ${avg((r) => r.eval!.reward).toFixed(2).padStart(7)} ${avg((r) => r.eval!.soft.coder_steps).toFixed(0).padStart(6)} ${avg((r) => r.eval!.cost.input_tokens + r.eval!.cost.output_tokens).toFixed(0).padStart(9)}${abstained ? `   (${abstained} abstained)` : ""}`,
    );
  }
  console.log(`\nsaved ${file}`);
}

/**
 * The learning loop's action: sample ROLLOUTS policies from the posterior, run
 * them as parallel Daytona sandboxes on the same issue, keep the best-rewarded
 * episode. Each rollout is a normal episode, so it also becomes training data.
 */
async function autoRollouts(task: Task): Promise<EpisodeResult> {
  const alloc = allocate(Number(process.env.ROLLOUTS ?? 2));
  const experimentId = process.env.EXPERIMENT_ID ?? `auto-${task.task_id}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  console.log(`auto: ${alloc.reason}`);
  const results = await Promise.all(
    alloc.policies.map((key, i) =>
      runEpisode(task, policy(key), log(`${task.task_id}/${key}`), { experimentId, episodeId: i === 0 ? process.env.EPISODE_ID : undefined }),
    ),
  );
  for (const r of results) console.log(`${r.episode_id}: ${summarize(r)}`);
  const evaluated = results.filter((r) => r.eval);
  const best = evaluated.length ? evaluated.reduce((a, b) => (b.eval!.reward > a.eval!.reward ? b : a)) : results[0]!;
  console.log(`auto: best ${best.policy} (${best.eval ? `reward ${best.eval.reward.toFixed(2)}` : best.status})`);
  return best;
}

switch (cmd) {
  case "episode": {
    const [taskId, policyKey = "A"] = rest;
    if (!taskId) throw new Error("usage: pnpm episode <task-id> [policy]");
    const task = loadTask(taskId);
    const r = await runEpisode(task, policy(policyKey), log(`${taskId}/${policyKey}`), { episodeId: process.env.EPISODE_ID });
    writeLearned();
    console.log(`\n${r.episode_id}: ${summarize(r)}`);
    if (r.diff) console.log(`\n${r.diff}`);
    break;
  }
  case "issue": {
    const [refText, policyKey = "A"] = rest;
    if (!refText) throw new Error("usage: pnpm issue <owner/repo#N|issue-url> [policy|auto]");
    const ref = parseIssueRef(refText);
    const [task] = await importIssues(ref.slug, [ref.number]);
    const r = policyKey === "auto" ? await autoRollouts(task!) : await runEpisode(task!, policy(policyKey), log(`${task!.task_id}/${policyKey}`), { episodeId: process.env.EPISODE_ID });
    writeLearned();
    console.log(`\n${r.episode_id}: ${summarize(r)}`);
    if (r.diff) console.log(`\n${r.diff}`);
    break;
  }
  case "learn": {
    const l = writeLearned();
    console.log(`${"policy".padEnd(8)} ${"n".padStart(3)} ${"ok".padStart(3)} ${"posterior".padStart(10)} ${"raw".padStart(6)} ${"±".padStart(6)}`);
    for (const p of l.posterior) console.log(`${p.key.padEnd(8)} ${String(p.n).padStart(3)} ${String(p.successes).padStart(3)} ${p.mean.toFixed(3).padStart(10)} ${(p.raw === undefined ? "—" : p.raw.toFixed(2)).padStart(6)} ${p.stderr.toFixed(2).padStart(6)}`);
    console.log(`\nbest: ${l.best ?? "—"}${l.gain ? `  gain vs ${l.gain.baseline}: ${(l.gain.success * 100).toFixed(0)} pp success, ${l.gain.reward >= 0 ? "+" : ""}${l.gain.reward.toFixed(2)} reward` : ""}`);
    console.log(`next: ${l.next.policies.join(",")} — ${l.next.reason}\nsaved ${LEARNED_FILE}`);
    break;
  }
  case "tasks:import": {
    const [slug, numbers] = rest;
    if (!slug || !numbers) throw new Error("usage: pnpm tasks:import <owner/repo> <N,N,...>");
    await importIssues(slug, numbers.split(",").map(Number));
    break;
  }
  case "experiment": {
    const policies = (rest[0] ?? "A,B,C").split(",").map(policy);
    const tasks = (rest[1] ? rest[1].split(",") : listTasks()).map(loadTask);
    await experiment(policies, tasks, process.env.EXPERIMENT_ID);
    break;
  }
  case "smoke": {
    const t0 = Date.now();
    const sb = await bootRepoSandbox({ purpose: "smoke" });
    console.log(`booted ${sb.id} in ${Date.now() - t0}ms`);
    const r = await sb.exec("uname -a && node -v && git --version", "/home/daytona");
    console.log(r);
    await sb.terminate();
    console.log("terminated");
    break;
  }
  default:
    console.log("usage: pnpm episode <task-id> [policy] | pnpm issue <owner/repo#N> [policy|auto] | pnpm learn | pnpm tasks:import <owner/repo> <N,..> | pnpm experiment [policies] [tasks] | pnpm sandbox:smoke");
}
