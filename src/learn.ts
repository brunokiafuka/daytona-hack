import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EpisodeResult } from "./orchestrator.js";
import { POLICIES } from "./orchestrator.js";
import type { Policy } from "./orchestrator.js";

/**
 * §10 — the minimal learning loop. Policies are the action space, the episode
 * reward is the signal, Daytona is what makes rollouts cheap enough to sample
 * several per issue. Nothing here touches model weights: the "policy update"
 * is a running posterior over which agent configuration earns reward, and the
 * "action" is how the next issue's sandboxes are allocated across policies.
 *
 * Every evaluated episode under .data/episodes is a training example; this
 * module never writes there. Its own artifact is .data/learned.json, which the
 * dashboard reads (contract: `Learned` below) — never the episode dirs.
 */
const EPISODES_DIR = ".data/episodes";
export const LEARNED_FILE = ".data/learned.json";

/** Pseudo-observations pulling every policy toward the prior mean — one lucky episode must not decide the allocation. */
const PRIOR_MEAN = 0.5;
const PRIOR_WEIGHT = 3;

export interface PolicyPosterior {
  key: string;
  name: string;
  /** Evaluated episodes counted (infra failures excluded). */
  n: number;
  successes: number;
  /** Shrunk mean reward — the posterior mean under the prior above. */
  mean: number;
  /** Raw mean reward, undefined until the policy has an evaluated episode. */
  raw?: number;
  /** Std. error of the mean; wide until n grows, which is what drives exploration. */
  stderr: number;
}

export interface Allocation {
  /** Policy keys, one rollout each; the first is the exploit choice. */
  policies: string[];
  reason: string;
}

export interface Learned {
  schema_version: "1.1";
  updated_at: string;
  prior: { mean: number; weight: number };
  posterior: PolicyPosterior[];
  /** Best policy by posterior mean, undefined until any policy has data. */
  best?: string;
  /** Posterior gap between best and policy A, the baseline: the real "measured policy gain". */
  gain?: { policy: string; baseline: string; success: number; reward: number };
  /** Reward of each evaluated episode in start order — the learning curve. */
  curve: { episode_id: string; policy: string; task_id: string; started_at: string; reward: number; success: boolean }[];
  /** What the next `auto` run would do, for the dashboard to show before it happens. */
  next: Allocation;
}

interface Sample {
  episode_id: string;
  policy: string;
  task_id: string;
  started_at: string;
  reward: number;
  success: boolean;
}

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};

/** Infrastructure failures say nothing about the policy — same filter the dashboard applies. */
const INFRA = /rate limit|credits|status code 50\d|stopped by user|ECONNRESET|fetch failed/i;

/** Every evaluated, non-demo episode with its reward. */
export function samples(): Sample[] {
  if (!existsSync(EPISODES_DIR)) return [];
  const out: Sample[] = [];
  for (const id of readdirSync(EPISODES_DIR)) {
    if (/demo/.test(id)) continue;
    const dir = join(EPISODES_DIR, id);
    const result = readJson<EpisodeResult>(join(dir, "result.json"));
    const status = readJson<{ demo?: boolean }>(join(dir, "status.json"));
    if (!result?.eval || status?.demo || INFRA.test(result.error ?? "")) continue;
    out.push({ episode_id: id, policy: result.policy, task_id: result.task_id, started_at: result.started_at ?? "", reward: result.eval.reward, success: result.eval.success });
  }
  return out.sort((a, b) => a.started_at.localeCompare(b.started_at));
}

export function posterior(data = samples()): PolicyPosterior[] {
  return Object.entries(POLICIES).map(([key, p]) => {
    const rs = data.filter((s) => s.policy === p.name).map((s) => s.reward);
    const n = rs.length;
    const sum = rs.reduce((a, r) => a + r, 0);
    const mean = (sum + PRIOR_MEAN * PRIOR_WEIGHT) / (n + PRIOR_WEIGHT);
    const variance = n > 1 ? rs.reduce((a, r) => a + (r - sum / n) ** 2, 0) / (n - 1) : 0.25;
    return {
      key,
      name: p.name,
      n,
      successes: data.filter((s) => s.policy === p.name && s.success).length,
      mean,
      raw: n ? sum / n : undefined,
      stderr: Math.sqrt(variance / (n + PRIOR_WEIGHT)),
    };
  });
}

/**
 * Choose which policies get a sandbox for the next issue. Slot 1 exploits the
 * posterior mean; the rest are Thompson samples (mean + gaussian noise scaled by
 * the policy's uncertainty), so an under-tested policy can still win a slot.
 */
export function allocate(n: number, post = posterior(), rng = gaussian): Allocation {
  const byMean = [...post].sort((a, b) => b.mean - a.mean);
  const exploit = byMean[0]!;
  const chosen = [exploit.key];
  const rest = post.filter((p) => p.key !== exploit.key);
  while (chosen.length < Math.min(n, post.length)) {
    const draws = rest.filter((p) => !chosen.includes(p.key)).map((p) => ({ key: p.key, draw: p.mean + p.stderr * rng() }));
    draws.sort((a, b) => b.draw - a.draw);
    chosen.push(draws[0]!.key);
  }
  const hasData = post.some((p) => p.n > 0);
  const reason = hasData
    ? `exploit ${exploit.key} (posterior ${exploit.mean.toFixed(2)} over ${exploit.n} episodes)${chosen.length > 1 ? `, explore ${chosen.slice(1).join(",")} by Thompson sampling` : ""}`
    : `no evaluated episodes yet — uniform prior, sampled ${chosen.join(",")}`;
  return { policies: chosen, reason };
}

export function policyFor(key: string): Policy {
  const p = POLICIES[key];
  if (!p) throw new Error(`unknown policy ${key}`);
  return p;
}

/** Recompute the artifact from every evaluated episode and persist it. Cheap; call after each episode. */
export function writeLearned(nextN = Number(process.env.ROLLOUTS ?? 2)): Learned {
  const data = samples();
  const post = posterior(data);
  const withData = post.filter((p) => p.n > 0);
  const best = withData.length ? [...withData].sort((a, b) => b.mean - a.mean)[0] : undefined;
  const baseline = post.find((p) => p.key === "A");
  const rate = (p: PolicyPosterior) => (p.n ? p.successes / p.n : 0);
  const learned: Learned = {
    schema_version: "1.1",
    updated_at: new Date().toISOString(),
    prior: { mean: PRIOR_MEAN, weight: PRIOR_WEIGHT },
    posterior: post,
    best: best?.key,
    gain: best && baseline && baseline.n > 0 && best.key !== baseline.key ? { policy: best.key, baseline: baseline.key, success: rate(best) - rate(baseline), reward: best.mean - baseline.mean } : undefined,
    curve: data,
    next: allocate(nextN, post),
  };
  mkdirSync(".data", { recursive: true });
  writeFileSync(LEARNED_FILE, JSON.stringify(learned, null, 2) + "\n");
  return learned;
}

function gaussian(): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
