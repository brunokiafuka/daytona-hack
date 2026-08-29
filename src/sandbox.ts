import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Daytona } from "@daytonaio/sdk";
import type { Sandbox } from "@daytonaio/sdk";

const run = promisify(execFile);

/**
 * The agent's machine: a Daytona sandbox that clones the task repository at
 * its base commit and runs every tool call in the cloud. Ported from the
 * Modal version in compass (apps/slack-server/src/sandbox.ts) — same shape,
 * different provider. The GitHub token travels as an env var only, never in
 * a command line the provider could log.
 */
const CLONE_DIR = "/home/daytona/repo";
const SANDBOX_TTL_MIN = 30; // hard cap on an episode's machine
const AUTO_STOP_MIN = 10; // idle safety net if we crash before terminate()
const EXEC_TIMEOUT_S = 180;

/** Reuse the local `gh` login unless a token is provided explicitly. */
export async function githubToken(): Promise<string> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const { stdout } = await run("gh", ["auth", "token"]);
    return stdout.trim();
  } catch {
    return "";
  }
}

export interface ExecResult {
  exitCode: number;
  output: string;
}

export interface RepoSandbox {
  id: string;
  repoDir: string;
  /** Clone `owner/repo` at a commit into the sandbox. */
  clone(slug: string, commit: string): Promise<void>;
  /** Run a bash command in the repo; never throws on non-zero exit. */
  exec(cmd: string, cwd?: string): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  terminate(): Promise<void>;
}

export async function bootRepoSandbox(labels: Record<string, string> = {}): Promise<RepoSandbox> {
  const token = await githubToken();
  const daytona = new Daytona();
  const sandbox: Sandbox = await daytona.create({
    language: "typescript",
    labels: { app: "daytona-hack", ...labels },
    envVars: { GH_TOKEN: token, GIT_TOKEN: token },
    autoStopInterval: AUTO_STOP_MIN,
    autoDeleteInterval: SANDBOX_TTL_MIN,
  });

  async function exec(cmd: string, cwd: string = CLONE_DIR): Promise<ExecResult> {
    const res = await sandbox.process.executeCommand(
      `bash -lc ${JSON.stringify(cmd)}`,
      cwd,
      undefined,
      EXEC_TIMEOUT_S,
    );
    return { exitCode: res.exitCode, output: res.result };
  }

  return {
    id: sandbox.id,
    repoDir: CLONE_DIR,
    clone: async (slug, commit) => {
      // Token stays out of the command string — bash expands $GIT_TOKEN in-sandbox.
      const url = token
        ? `https://x-access-token:$GIT_TOKEN@github.com/${slug}.git`
        : `https://github.com/${slug}.git`;
      const r = await exec(`git clone --quiet ${url} ${CLONE_DIR} && cd ${CLONE_DIR} && git checkout --quiet ${commit}`, "/home/daytona");
      if (r.exitCode !== 0) throw new Error(`clone failed: ${r.output.slice(0, 500)}`);
      await exec(`git config user.email agent@daytona-hack.local && git config user.name "daytona-hack agent"`);
    },
    exec,
    readFile: async (path) => {
      const buf = await sandbox.fs.downloadFile(`${CLONE_DIR}/${path}`);
      return buf.toString("utf8");
    },
    writeFile: async (path, content) => {
      await sandbox.fs.uploadFile(Buffer.from(content, "utf8"), `${CLONE_DIR}/${path}`);
    },
    terminate: async () => {
      await daytona.delete(sandbox);
    },
  };
}
