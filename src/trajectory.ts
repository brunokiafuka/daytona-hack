import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every agent action becomes an event (§7 of the plan). Episodes are written
 * as JSONL under .data/episodes/<episode_id>/ — the fundamental RL dataset.
 *
 * Besides the agent trace, an episode directory carries:
 *   status.json  — live orchestrator state (phase, sandboxes, timestamps); rewritten on every change
 *   log.jsonl    — orchestrator/sandbox log lines (boot, clone, setup, test runs, hidden eval)
 *   <name>.json  — artifacts: plan, review, diff, eval, result
 * The dashboard adapter reads these; nothing else should depend on the layout.
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

export interface LogLine {
  timestamp: string;
  phase: string;
  level: "info" | "warn" | "error";
  message: string;
  /** Raw command output when the line records a sandbox command. */
  output?: string;
  exit_code?: number;
  duration_ms?: number;
}

export interface EpisodeStatus {
  episode_id: string;
  task_id: string;
  policy: string;
  state: "running" | "done" | "abstained" | "error";
  phase: string;
  detail?: string;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  attempt: number;
  sandboxes: Partial<Record<AgentName, string[]>>;
  usage: AgentUsage[];
  experiment_id?: string;
  models?: Record<AgentName, string>;
  /** Seeded replay, not a real run. The dashboard labels these. */
  demo?: boolean;
}

export const DATA_DIR = ".data/episodes";

export class Trajectory {
  readonly dir: string;
  private steps: Record<AgentName, number> = { planner: 0, coder: 0, reviewer: 0 };
  private current?: EpisodeStatus;

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

  /** Orchestrator-level log line (not an agent action). Appended to log.jsonl. */
  log(phase: string, message: string, extra: Partial<Omit<LogLine, "timestamp" | "phase" | "message">> = {}): void {
    const line: LogLine = { timestamp: new Date().toISOString(), phase, level: extra.level ?? "info", message, ...extra };
    appendFileSync(join(this.dir, "log.jsonl"), JSON.stringify(line) + "\n");
  }

  /** Live status, rewritten atomically-enough on every change so a poller sees progress. */
  status(patch: Partial<EpisodeStatus> & Pick<EpisodeStatus, "task_id" | "policy"> | Partial<EpisodeStatus>): EpisodeStatus {
    const now = new Date().toISOString();
    const prev: EpisodeStatus = this.current ?? {
      episode_id: this.episodeId,
      task_id: "",
      policy: "",
      state: "running",
      phase: "init",
      started_at: now,
      updated_at: now,
      attempt: 0,
      sandboxes: {},
      usage: [],
    };
    this.current = { ...prev, ...patch, updated_at: now };
    writeFileSync(join(this.dir, "status.json"), JSON.stringify(this.current, null, 2));
    return this.current;
  }
}
