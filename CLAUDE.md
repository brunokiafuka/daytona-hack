# daytona-hack

TypeScript ESM, pnpm, `tsx` for running. No build step. `pnpm typecheck` must stay green.

- Sandboxes are Daytona (`@daytonaio/sdk`); model calls go through the Vercel AI SDK (`ai` + `@ai-sdk/openai`,
  default `gpt-5.5`, `OPENAI_MODEL` to override). Trajectory capture lives inside each tool's `execute` in `src/agent.ts`.
- Agents never commit/push; the orchestrator owns git. Agents never receive `evaluation_command`.
- New benchmark tasks go in `tasks/<id>.json` — schema in `src/tasks.ts`.
- `.data/` is generated output and gitignored.
