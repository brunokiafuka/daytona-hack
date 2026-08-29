# daytona-hack

Autonomous engineering agent: **GitHub issue → plan → implement → tests → review → eval → reward**, with every run
inside a [Daytona](https://daytona.io) sandbox and every agent action recorded as a trajectory event.

Structure follows the [technical plan](https://docs.google.com/document/d/1KAVbx_shjXag1OA8HArvU0Iq6HZzxM1bU7X0bvCX7gA/edit).
The sandbox/tool-loop shape is lifted from compass's `apps/slack-server` (Modal → Daytona; the raw OpenAI fetch loop → Vercel AI SDK).

## Project plans

- [Technical plan](docs/TECHNICAL_PLAN.md) — versioned project intent, architecture, scope, and definition of done.
- [Dashboard proposal](DASHBOARD_PROPOSAL.md) — contract-first demo dashboard design, data boundary, and delivery plan.
- [Agent guidance](AGENTS.md) — decision-making constraints for coding agents working in this repository.

```
src/
  sandbox.ts        Daytona sandbox: boot → clone@commit → exec/read/write → terminate
  agent.ts          bounded tool loop on the Vercel AI SDK; records every call on the trajectory
  agents/planner.ts read-only investigation → {diagnosis, files, plan}
  agents/coder.ts   closed loop implement→test→fix; test paths are write-protected
  agents/reviewer.ts read-only gate with a 4-item rubric → approve/reject
  orchestrator.ts   one episode: planner sandbox → confidence gate → coder sandbox → reviewer sandbox(es) → eval
  eval.ts           hard/soft signals → success (hidden oracle only) + reward
  trajectory.ts     JSONL events + JSON artifacts under .data/episodes/<id>/
  tasks.ts          benchmark task loader (tasks/*.json)
  index.ts          CLI
```

## Setup

```sh
pnpm install
cp .env.example .env     # DAYTONA_API_KEY, OPENAI_API_KEY
pnpm sandbox:smoke       # boots a sandbox, runs a command, tears it down
```

## Dashboard

The fixture-backed dashboard is ready to demo before agent runs are available. It uses a versioned read model and is
designed to switch to a runner-backed adapter without coupling the UI to internal artifact files.

```sh
pnpm dashboard
```

Open [http://localhost:4173](http://localhost:4173). The initial replay includes an active episode, an inspectable
agent trace, and policy comparison. Its data contract lives in `dashboard/data.js`.

## Run

```sh
pnpm episode <task-id> [A|B|C|D]     # one episode; prints reward + diff
pnpm experiment A,B,D                # every task × each policy, then the comparison table
CONCURRENCY=5 pnpm experiment        # sandboxes are the unit of parallelism
```

Policies (`src/orchestrator.ts`): **A** planner+coder+reviewer · **B** planner+coder · **C** coder+reviewer ·
**D** A + reviewer→coder retry loop.

Outputs land in `.data/episodes/<episode_id>/` (`events.jsonl`, `plan.json`, `review.json`, `diff.json`, `eval.json`,
`result.json`) and `.data/experiments/<timestamp>.json`.

## Design decisions worth knowing

- **One sandbox per phase, handed off by artifact.** The planner runs read-only on its own machine and returns a
  `confidence`; the coder sandbox is only created if it clears the policy's `minConfidence` (otherwise the episode is
  `abstained` — no execution spend). The reviewer gets a fresh clone with only the coder's patch `git apply`'d, so it
  reviews exactly what the PR would contain.
- **Success = hidden `evaluation_command` passes AND no test file was touched.** The visible test command is what the
  coder iterates against; it does not decide success on its own.
- **Coder cannot write under test paths** (`protected_paths`, plus `*.test.*` / `test_*.py`). Reward otherwise pays for
  deleting the failing test.
- **Every agent is budgeted** (steps, wall clock) and tool output is clipped to 8k chars so one test dump doesn't
  sink the context.
- **Reviewer gates, doesn't score.** It emits a boolean rubric; it is not part of the reward.
- **Learning is a bandit over policies, not weights.** `src/learn.ts` turns every evaluated episode's reward into a
  shrunk per-policy posterior (prior 0.5 × 3 pseudo-episodes; infra failures excluded). `pnpm issue <ref> auto`
  exploits the best policy and Thompson-samples the remaining `ROLLOUTS` slots, runs them as parallel Daytona
  sandboxes on the same issue, and keeps the best-rewarded patch. Each rollout is itself an episode, so the posterior
  updates from it. `.data/learned.json` is the artifact; the overview's "Reinforcement evidence" panel reads it.
- **Planner is graded against `reference_files`** when the task has them — precision/recall on file identification,
  no LLM judge needed.

## Dashboard & live runs

```bash
pnpm dashboard                                  # http://localhost:4173 — live UI + API over .data/
pnpm issue uselucerna/scribl#15 A               # live run: import the issue as a task, run one episode
pnpm issue uselucerna/scribl#15 auto            # learning loop: ROLLOUTS parallel sandboxes allocated from the posterior, best reward wins
pnpm learn                                      # recompute .data/learned.json (policy posterior, next allocation) and print it
pnpm tasks:import uselucerna/scribl 5,6,7,15     # import issues as benchmark tasks (tasks/scribl-<N>.json)
pnpm experiment A,B,C scribl-15,scribl-5         # benchmark; EXPERIMENT_ID/CONCURRENCY optional
```

The dashboard's **Trigger** panel runs the same commands (`POST /api/runs/issue`, `POST /api/runs/experiment`)
as child processes and follows them live. Per-repository setup/test/oracle commands live in `REPO_PROFILES`
(`src/github.ts`); scribl has no test suite, so the visible signal is `typecheck` and the hidden oracle is
`typecheck && build`.

Each episode directory now also carries `status.json` (live phase/sandboxes), `log.jsonl` (boot, clone, setup,
test and oracle output) and `task.json` (the task minus `evaluation_command`). `dashboard/adapter.mjs` maps these
into the read model (`/api/episodes`, `/api/episodes/:id`, `/api/experiments[/:id]`, `/api/sandboxes`, `/api/runs`).
The API key is re-read from `.env` on every trigger, so rotating it needs no restart.
