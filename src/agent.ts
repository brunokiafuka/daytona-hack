import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";

import type { RepoSandbox } from "./sandbox.js";
import type { AgentName, AgentUsage, Trajectory } from "./trajectory.js";

/**
 * One tool loop over a sandbox, on the Vercel AI SDK. The SDK drives the
 * request → tool → request cycle; we sit inside every tool's `execute` to
 * guard, run and record it on the trajectory. Bounded by steps and wall
 * clock so a stuck agent fails loudly instead of running forever.
 */
export const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.5";
const MAX_TOOL_OUTPUT = 8_000; // chars — a test dump can be 50k+ and would sink the context

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentConfig {
  name: AgentName;
  system: string;
  tools: string[]; // keys of SANDBOX_TOOLS
  effort?: Effort;
  maxSteps: number;
  maxWallMs: number;
  /** Optional per-tool guard: return a string to refuse the call with that message. */
  guard?: (tool: string, input: Record<string, unknown>) => string | undefined;
}

export interface AgentResult {
  text: string;
  usage: AgentUsage;
  stopped_by: "end_turn" | "max_steps" | "timeout" | "error";
}

export type ToolExecutor = (
  name: string,
  input: Record<string, unknown>,
) => Promise<{ exit_code?: number; output: string }>;

export async function runAgent(
  cfg: AgentConfig,
  prompt: string,
  execute: ToolExecutor,
  trajectory: Trajectory,
): Promise<AgentResult> {
  const usage: AgentUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, turns: 0 };
  const abort = AbortSignal.timeout(cfg.maxWallMs);

  // Wrap each sandbox tool so guard → execute → record happens per call.
  const tools: ToolSet = Object.fromEntries(
    cfg.tools.map((name) => {
      const def = SANDBOX_TOOLS[name];
      if (!def) throw new Error(`unknown tool ${name}`);
      return [
        name,
        tool({
          description: def.description,
          inputSchema: def.schema,
          execute: async (input: Record<string, unknown>) => {
            const t0 = Date.now();
            const refused = cfg.guard?.(name, input);
            let obs: { exit_code?: number; output: string };
            if (refused) obs = { exit_code: 1, output: refused };
            else {
              try {
                obs = await execute(name, input);
              } catch (err) {
                obs = { exit_code: 1, output: `tool error: ${(err as Error).message}` };
              }
            }
            const clipped = clip(obs.output);
            trajectory.record(cfg.name, {
              action: { tool: name, input },
              observation: { exit_code: obs.exit_code, output: clipped },
              timestamp: new Date(t0).toISOString(),
              duration_ms: Date.now() - t0,
            });
            return obs.exit_code !== undefined ? `exit ${obs.exit_code}\n${clipped}` : clipped;
          },
        }),
      ];
    }),
  );

  try {
    const result = await generateText({
      model: openai(MODEL),
      system: cfg.system,
      prompt,
      tools,
      stopWhen: stepCountIs(cfg.maxSteps),
      abortSignal: abort,
      providerOptions: { openai: { reasoningEffort: cfg.effort ?? "high" } },
      onStepFinish: ({ usage: u }) => {
        usage.turns++;
        usage.input_tokens += u.inputTokens ?? 0;
        usage.output_tokens += u.outputTokens ?? 0;
        usage.cache_read_input_tokens += u.inputTokenDetails?.cacheReadTokens ?? 0;
      },
    });
    const hitCap = result.steps.length >= cfg.maxSteps && result.finishReason === "tool-calls";
    return { text: result.text, usage, stopped_by: hitCap ? "max_steps" : "end_turn" };
  } catch (err) {
    if (abort.aborted) return { text: "", usage, stopped_by: "timeout" };
    throw err;
  }
}

function clip(s: string): string {
  if (s.length <= MAX_TOOL_OUTPUT) return s;
  const half = MAX_TOOL_OUTPUT / 2;
  return `${s.slice(0, half)}\n\n… [${s.length - MAX_TOOL_OUTPUT} chars truncated] …\n\n${s.slice(-half)}`;
}

/** The shared sandbox toolset. Agents pick a subset by name. */
export const SANDBOX_TOOLS: Record<string, { description: string; schema: z.ZodObject<z.ZodRawShape> }> = {
  bash: {
    description:
      "Run a bash command in the repository root inside the sandbox. Use for git, grep, ls, running tests, installing dependencies. Output is truncated when very long — prefer targeted commands.",
    schema: z.object({ command: z.string() }),
  },
  read_file: {
    description: "Read a file from the repository. Path is relative to the repo root.",
    schema: z.object({ path: z.string() }),
  },
  write_file: {
    description:
      "Overwrite a file in the repository with new content (creates it if missing). Path is relative to the repo root. Read the file first; write the whole file back.",
    schema: z.object({ path: z.string(), content: z.string() }),
  },
};

export function sandboxExecutor(sandbox: RepoSandbox): ToolExecutor {
  return async (name, input) => {
    switch (name) {
      case "bash":
        return sandbox.exec(String(input.command));
      case "read_file":
        return { output: await sandbox.readFile(String(input.path)) };
      case "write_file":
        await sandbox.writeFile(String(input.path), String(input.content));
        return { output: `wrote ${input.path}` };
      default:
        return { exit_code: 1, output: `unknown tool ${name}` };
    }
  };
}

/** Pull the last fenced/bare JSON object out of an agent's final text. */
export function parseJson<T>(text: string): T | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/g);
  const candidates = fenced ? fenced.map((f) => f.replace(/```(?:json)?/g, "").trim()) : [];
  const brace = text.lastIndexOf("{");
  if (brace >= 0) candidates.push(text.slice(brace));
  for (const c of candidates.reverse()) {
    try {
      return JSON.parse(c) as T;
    } catch {
      /* try next */
    }
  }
  return undefined;
}
