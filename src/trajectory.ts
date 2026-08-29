import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every agent action becomes an event (§7 of the plan). Episodes are written
 * as JSONL under .data/episodes/<episode_id>/ — the fundamental RL dataset.
 */
export type AgentName = "planner" | "coder" | "reviewer";

export interface TrajectoryEvent {
  episode_id: string;
  agent: AgentName;
  step: number;
  action: { tool: string; input: unknown };
  observation: { exit_code?: number; output: string };
  timestamp: string;
  duration_ms: number;
}

export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  turns: number;
}

export const DATA_DIR = ".data/episodes";

export class Trajectory {
  readonly dir: string;
  private steps: Record<AgentName, number> = { planner: 0, coder: 0, reviewer: 0 };

  constructor(readonly episodeId: string) {
    this.dir = join(DATA_DIR, episodeId);
    mkdirSync(this.dir, { recursive: true });
  }

  record(agent: AgentName, e: Omit<TrajectoryEvent, "episode_id" | "agent" | "step">): TrajectoryEvent {
    const step = ++this.steps[agent];
    const event: TrajectoryEvent = { episode_id: this.episodeId, agent, step, ...e };
    appendFileSync(join(this.dir, "events.jsonl"), JSON.stringify(event) + "\n");
    return event;
  }

  stepsFor(agent: AgentName): number {
    return this.steps[agent];
  }

  /** Any non-event artifact (plan, review, diff, eval) — one JSON file each. */
  artifact(name: string, value: unknown): void {
    writeFileSync(join(this.dir, `${name}.json`), JSON.stringify(value, null, 2));
  }
}
