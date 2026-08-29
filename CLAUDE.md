# daytona-hack

TypeScript ESM, pnpm, `tsx` for running. No build step. `pnpm typecheck` must stay green.

Before making product, architecture, data-model, orchestration, evaluation, or dashboard decisions, read
[`docs/TECHNICAL_PLAN.md`](docs/TECHNICAL_PLAN.md) and
[`DASHBOARD_PROPOSAL.md`](DASHBOARD_PROPOSAL.md). The dashboard is contract-first so it can be built before the
runner; do not couple it directly to internal artifact files or storage.

- Sandboxes are Daytona (`@daytonaio/sdk`); model calls go through the Vercel AI SDK (`ai` + `@ai-sdk/openai`,
  default `gpt-5.4-mini`, `OPENAI_MODEL` or `OPENAI_MODEL_<AGENT>` to override). Trajectory capture lives inside each tool's `execute` in `src/agent.ts`.
- Agents never commit/push; the orchestrator owns git. Agents never receive `evaluation_command`.
- New benchmark tasks go in `tasks/<id>.json` — schema in `src/tasks.ts`.
- `.data/` is generated output and gitignored. Episode dirs carry `status.json`, `log.jsonl`, `task.json` + artifacts;
  `dashboard/adapter.mjs` is the only reader. `dashboard/server.mjs` also spawns runs (`POST /api/runs/*`).
- Real issues come from `pnpm issue`/`pnpm tasks:import`; per-repo commands live in `REPO_PROFILES` (`src/github.ts`).
- Learning loop lives in `src/learn.ts`: reward → per-policy posterior → sandbox allocation for `pnpm issue <ref> auto`. It
  writes `.data/learned.json` (read by the dashboard via `/api/policy`); episode dirs stay read-only to it.
