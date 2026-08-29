import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** A benchmark task (§11): a GitHub issue pinned to a commit with a test oracle. */
export interface Task {
  task_id: string;
  repository: string; // owner/repo
  base_commit: string;
  issue: string; // full issue text (title + body)
  /** Runs the repo's test suite; exit 0 = green. */
  test_command: string;
  /** Hidden oracle run after the agent's sandbox is frozen; exit 0 = solved. */
  evaluation_command: string;
  /** Command to install deps before the agent starts. */
  setup_command?: string;
  /** Paths the coder must not touch (tests). Prefix match. */
  protected_paths?: string[];
  /** Files the reference fix touched — free planner ground truth. */
  reference_files?: string[];
}

const TASKS_DIR = "tasks";

export function loadTask(id: string): Task {
  return JSON.parse(readFileSync(join(TASKS_DIR, `${id}.json`), "utf8")) as Task;
}

export function listTasks(): string[] {
  return readdirSync(TASKS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}
