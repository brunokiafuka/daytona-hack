import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Task } from "./tasks.js";

const run = promisify(execFile);

/**
 * Turn a live GitHub issue into a benchmark task (§11). Uses the `gh` CLI so
 * private repos work with the user's existing auth.
 */
export interface IssueRef {
  slug: string; // owner/repo
  number: number;
}

export function parseIssueRef(input: string): IssueRef {
  // Accepts: owner/repo#12, https://github.com/owner/repo/issues/12
  const url = input.match(/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/);
  const short = input.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
  const m = url ?? short;
  if (!m) throw new Error(`cannot parse issue reference: ${input} (use owner/repo#N or an issue URL)`);
  return { slug: m[1]!, number: Number(m[2]) };
}

export interface IssueDetails {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  head_commit: string;
  default_branch: string;
}

export async function fetchIssue(ref: IssueRef): Promise<IssueDetails> {
  const { stdout } = await run("gh", ["issue", "view", String(ref.number), "-R", ref.slug, "--json", "number,title,body,url,labels"]);
  const issue = JSON.parse(stdout) as { number: number; title: string; body: string; url: string; labels: { name: string }[] };
  const repo = JSON.parse((await run("gh", ["repo", "view", ref.slug, "--json", "defaultBranchRef"])).stdout) as { defaultBranchRef: { name: string } };
  const branch = repo.defaultBranchRef.name;
  const head = (await run("gh", ["api", `repos/${ref.slug}/commits/${branch}`, "--jq", ".sha"])).stdout.trim();
  return { number: issue.number, title: issue.title, body: issue.body ?? "", url: issue.url, labels: issue.labels.map((l) => l.name), head_commit: head, default_branch: branch };
}

/** Per-repository harness: how to install, what counts as green, what the oracle checks. */
export interface RepoProfile {
  setup_command: string;
  test_command: string;
  evaluation_command: string;
  protected_paths?: string[];
}

export const REPO_PROFILES: Record<string, RepoProfile> = {
  // Turborepo + pnpm workspace, no test suite: the frontend typecheck is the visible
  // signal, the hidden oracle additionally requires a production build.
  "uselucerna/scribl": {
    setup_command: "npm i -g pnpm@10.11.1 >/dev/null 2>&1 && pnpm install --frozen-lockfile",
    test_command: "pnpm --filter @scribl/frontend typecheck",
    evaluation_command: "pnpm --filter @scribl/frontend typecheck && pnpm --filter @scribl/frontend build",
  },
};

export function profileFor(slug: string): RepoProfile {
  const p = REPO_PROFILES[slug];
  if (!p) throw new Error(`no repo profile for ${slug}; add one to REPO_PROFILES in src/github.ts (setup/test/evaluation commands)`);
  return p;
}

export function taskFromIssue(ref: IssueRef, issue: IssueDetails, profile = profileFor(ref.slug)): Task {
  const repoName = ref.slug.split("/")[1]!;
  return {
    task_id: `${repoName}-${issue.number}`,
    repository: ref.slug,
    base_commit: issue.head_commit,
    issue: `Title: ${issue.title}\n\n${issue.body}`.trim(),
    ...profile,
    // Dashboard-facing metadata; ignored by the agents.
    meta: { issue_number: issue.number, issue_title: issue.title, issue_url: issue.url, labels: issue.labels, imported_at: new Date().toISOString() },
  };
}

export function saveTask(task: Task, dir = "tasks"): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${task.task_id}.json`);
  writeFileSync(file, JSON.stringify(task, null, 2) + "\n");
  return file;
}
