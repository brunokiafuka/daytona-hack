# daytona-hack

TypeScript ESM, pnpm, `tsx` for running. No build step. `pnpm typecheck` must stay green.

- Sandboxes are Daytona (`@daytonaio/sdk`); model calls are `@anthropic-ai/sdk` (`claude-opus-5`, adaptive thinking,
  manual tool loop in `src/agent.ts` so every call lands on the trajectory).
- Agents never commit/push; the orchestrator owns git. Agents never receive `evaluation_command`.
- New benchmark tasks go in `tasks/<id>.json` — schema in `src/tasks.ts`.
- `.data/` is generated output and gitignored.
