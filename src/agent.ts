import { createOpenAI } from "@ai-sdk/openai";

/**
 * 429s are retried by the SDK, which is right for rate limits but wrong for an
 * empty balance — that would silently back off for minutes. Surface quota
 * errors immediately as a non-retryable failure.
 */
const openai = createOpenAI({
  fetch: async (input, init) => {
    const res = await fetch(input, init);
    if (res.status === 429) {
      const body = await res.clone().text();
      if (/insufficient_quota|credit_balance_exhausted|no credits/i.test(body)) throw new Error("OpenAI quota exhausted: add credits at platform.openai.com/settings/organization/billing");
    }
    return res;
  },
});
import { generateText, stepCountIs, tool } from "ai";
import type { ModelMessage } from "ai";
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
/** Default model; override globally with OPENAI_MODEL or per agent with OPENAI_MODEL_PLANNER/CODER/REVIEWER. */
export const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
export const modelFor = (agent: string): string => process.env[`OPENAI_MODEL_${agent.toUpperCase()}`] ?? MODEL;
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
      model: openai(modelFor(cfg.name)),
      system: cfg.system,
      prompt,
      tools,
      stopWhen: stepCountIs(cfg.maxSteps),
      prepareStep: ({ messages }) => ({ messages: compactHistory(messages) }),
      // Org-level TPM limits are shared by every concurrent agent; exponential
      // backoff (2s, 4s, … capped by the wall clock) beats failing the episode.
      maxRetries: Number(process.env.MODEL_MAX_RETRIES ?? 8),
      abortSignal: abort,
      providerOptions: { openai: { reasoningEffort: cfg.effort ?? "medium" } },
      onStepFinish: ({ usage: u }) => {
        usage.turns++;
        usage.input_tokens += u.inputTokens ?? 0;
        usage.output_tokens += u.outputTokens ?? 0;
        usage.cache_read_input_tokens += u.inputTokenDetails?.cacheReadTokens ?? 0;
      },
    });
    const hitCap = result.steps.length >= cfg.maxSteps && result.finishReason === "tool-calls";
    let text = result.text;
    if (hitCap && !text.trim()) {
      // Step budget exhausted mid-exploration: one tool-less turn to force the
      // final answer from what was learned, instead of returning nothing.
      const final = await generateText({
        model: openai(modelFor(cfg.name)),
        system: cfg.system,
        messages: [
          { role: "user", content: prompt },
          ...result.response.messages,
          { role: "user", content: "Your tool budget is exhausted. Produce your final answer now, in exactly the format the instructions require, based on what you have already seen. If you are unsure, say so through the format (e.g. low confidence / reject) rather than omitting the answer." },
        ],
        maxRetries: Number(process.env.MODEL_MAX_RETRIES ?? 8),
        abortSignal: abort,
        providerOptions: { openai: { reasoningEffort: "low" } },
      });
      text = final.text;
      usage.turns++;
      usage.input_tokens += final.usage.inputTokens ?? 0;
      usage.output_tokens += final.usage.outputTokens ?? 0;
      usage.cache_read_input_tokens += final.usage.inputTokenDetails?.cacheReadTokens ?? 0;
    }
    return { text, usage, stopped_by: hitCap ? "max_steps" : "end_turn" };
  } catch (err) {
    if (abort.aborted) return { text: "", usage, stopped_by: "timeout" };
    throw err;
  }
}

/**
 * Keep the last KEEP_RECENT tool results verbatim and shrink older ones to a
 * one-line stub. The agent already acted on old observations; carrying 8k-char
 * file dumps for 60 steps is what pushes a step past 50k tokens and trips org
 * TPM limits. The trajectory on disk keeps the full outputs.
 */
const KEEP_RECENT = Number(process.env.AGENT_KEEP_RECENT ?? 8);
const STUB_CHARS = 300;
function compactHistory(messages: ModelMessage[]): ModelMessage[] {
  const toolIdx = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  const cutoff = toolIdx.length > KEEP_RECENT ? toolIdx[toolIdx.length - KEEP_RECENT]! : -1;
  return messages.map((m, i) => {
    if (m.role !== "tool" || i >= cutoff || typeof m.content === "string") return m;
    return {
      ...m,
      content: m.content.map((part) => {
        if (part.type !== "tool-result") return part;
        const out = part.output;
        if (out.type !== "text" || out.value.length <= STUB_CHARS) return part;
        return { ...part, output: { type: "text" as const, value: `${out.value.slice(0, STUB_CHARS)}\n… [earlier output elided; ${out.value.length} chars]` } };
      }),
    };
  });
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
