import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";

import { POLICIES, runEpisode } from "./orchestrator.js";
import type { EpisodeResult } from "./orchestrator.js";
import { bootRepoSandbox } from "./sandbox.js";
import { listTasks, loadTask } from "./tasks.js";

/**
 * CLI.
 *   pnpm episode <task-id> [policy]        one episode (default policy A)
 *   pnpm experiment [policies] [tasks]      e.g. `pnpm experiment A,B,D` or `A,D fix-greeting,other`
 *   pnpm sandbox:smoke                      boot a sandbox, run a command, tear down
 */
const [cmd, ...rest] = process.argv.slice(2);

const log = (episode: string) => (phase: string, detail?: string) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${episode}  ${phase}${detail ? `  ${detail}` : ""}`);

function policy(key: string) {
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

switch (cmd) {
  case "episode": {
    const [taskId, policyKey = "A"] = rest;
    if (!taskId) throw new Error("usage: pnpm episode <task-id> [policy]");
    const task = loadTask(taskId);
    const r = await runEpisode(task, policy(policyKey), log(`${taskId}/${policyKey}`));
    console.log(`\n${r.episode_id}: ${summarize(r)}`);
    if (r.diff) console.log(`\n${r.diff}`);
    break;
  }
  case "experiment": {
    const policies = (rest[0] ?? "A,B,C").split(",").map(policy);
    const tasks = (rest[1] ? rest[1].split(",") : listTasks()).map(loadTask);
    const concurrency = Number(process.env.CONCURRENCY ?? 3);
    const jobs = policies.flatMap((p) => tasks.map((t) => ({ p, t })));
    const results: EpisodeResult[] = [];
    // Simple worker pool — Daytona sandboxes are the unit of parallelism.
    await Promise.all(
      Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
        for (let j = jobs.shift(); j; j = jobs.shift()) {
          const r = await runEpisode(j.t, j.p, log(`${j.t.task_id}/${j.p.name}`));
          console.log(`${r.episode_id}: ${summarize(r)}`);
          results.push(r);
        }
      }),
    );
    mkdirSync(".data/experiments", { recursive: true });
    const file = `.data/experiments/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
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
    console.log("usage: pnpm episode <task-id> [policy] | pnpm experiment [policies] [tasks] | pnpm sandbox:smoke");
}
