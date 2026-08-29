import Anthropic from "@anthropic-ai/sdk";

import type { RepoSandbox } from "./sandbox.js";
import type { AgentName, AgentUsage, Trajectory } from "./trajectory.js";

/**
 * One Claude tool loop over a sandbox. Every tool call is recorded on the
 * trajectory; the loop is bounded by steps, tokens and wall clock so a stuck
 * agent fails loudly instead of running forever. Manual loop (not the beta
 * tool runner) because trajectory capture needs to sit between every call.
 */
export const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5";
const MAX_TOOL_OUTPUT = 8_000; // chars — a test dump can be 50k+ and would sink the context

export interface AgentConfig {
  name: AgentName;
  system: string;
  tools: Anthropic.Beta.BetaTool[];
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxSteps: number;
  maxWallMs: number;
  /** Optional per-tool guard: return a string to refuse the call with that message. */
  guard?: (tool: string, input: Record<string, unknown>) => string | undefined;
}

export interface AgentResult {
  text: string;
  usage: AgentUsage;
  stopped_by: "end_turn" | "max_steps" | "timeout" | "refusal";
}

export type ToolExecutor = (
  name: string,
  input: Record<string, unknown>,
) => Promise<{ exit_code?: number; output: string }>;

const client = new Anthropic();

export async function runAgent(
  cfg: AgentConfig,
  prompt: string,
  execute: ToolExecutor,
  trajectory: Trajectory,
): Promise<AgentResult> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
  const usage: AgentUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, turns: 0 };
  const started = Date.now();
  let text = "";

  while (true) {
    if (trajectory.stepsFor(cfg.name) >= cfg.maxSteps) return { text, usage, stopped_by: "max_steps" };
    if (Date.now() - started > cfg.maxWallMs) return { text, usage, stopped_by: "timeout" };

    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32_000,
      system: [{ type: "text", text: cfg.system, cache_control: { type: "ephemeral" } }],
      tools: cfg.tools,
      thinking: { type: "adaptive" },
      output_config: { effort: cfg.effort ?? "high" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages,
    });
    const response = await stream.finalMessage();

    usage.turns++;
    usage.input_tokens += response.usage.input_tokens;
    usage.output_tokens += response.usage.output_tokens;
    usage.cache_read_input_tokens += response.usage.cache_read_input_tokens ?? 0;

    text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    if (response.stop_reason === "refusal") return { text, usage, stopped_by: "refusal" };
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    if (response.stop_reason !== "tool_use") return { text, usage, stopped_by: "end_turn" };

    messages.push({ role: "assistant", content: response.content });
    const calls = response.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
    );

    // Parallel tool calls: execute together, return all results in ONE user message.
    const results = await Promise.all(
      calls.map(async (call): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        const input = call.input as Record<string, unknown>;
        const t0 = Date.now();
        const refused = cfg.guard?.(call.name, input);
        let obs: { exit_code?: number; output: string };
        let isError = false;
        if (refused) {
          obs = { output: refused };
          isError = true;
        } else {
          try {
            obs = await execute(call.name, input);
            isError = (obs.exit_code ?? 0) !== 0;
          } catch (err) {
            obs = { output: `tool error: ${(err as Error).message}` };
            isError = true;
          }
        }
        const clipped = clip(obs.output);
        trajectory.record(cfg.name, {
          action: { tool: call.name, input },
          observation: { exit_code: obs.exit_code, output: clipped },
          timestamp: new Date(t0).toISOString(),
          duration_ms: Date.now() - t0,
        });
        return { type: "tool_result", tool_use_id: call.id, content: clipped, is_error: isError };
      }),
    );
    messages.push({ role: "user", content: results });
  }
}

function clip(s: string): string {
  if (s.length <= MAX_TOOL_OUTPUT) return s;
  const half = MAX_TOOL_OUTPUT / 2;
  return `${s.slice(0, half)}\n\n… [${s.length - MAX_TOOL_OUTPUT} chars truncated] …\n\n${s.slice(-half)}`;
}

/** The shared sandbox toolset. Agents pick a subset by name. */
export const SANDBOX_TOOLS: Record<string, Anthropic.Beta.BetaTool> = {
  bash: {
    name: "bash",
    description:
      "Run a bash command in the repository root inside the sandbox. Use for git, grep, ls, running tests, installing dependencies. Output is truncated when very long — prefer targeted commands.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  read_file: {
    name: "read_file",
    description: "Read a file from the repository. Path is relative to the repo root.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  write_file: {
    name: "write_file",
    description:
      "Overwrite a file in the repository with new content (creates it if missing). Path is relative to the repo root. Read the file first; write the whole file back.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
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
