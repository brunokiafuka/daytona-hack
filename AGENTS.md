# Project guidance for coding agents

Before making architecture, scope, data-model, orchestration, evaluation, or dashboard decisions, read:

1. [Technical plan](docs/TECHNICAL_PLAN.md) — the project’s authoritative product and hackathon-scope intent.
2. [Dashboard proposal](DASHBOARD_PROPOSAL.md) — the dashboard’s contract-first design and delivery plan.

Key constraints:

- Keep the hackathon implementation focused: benchmarked GitHub issues, Daytona sandboxes, Planner/Coder/Reviewer, trajectories, evaluations, rewards, and policy comparison.
- The dashboard must be independently buildable before agents exist. It consumes a versioned read model through an adapter; never couple the UI directly to internal runner files or an assumed storage format.
- Preserve raw trajectory/evaluation evidence. Presentation summaries must not replace the data needed to inspect a run.
- Treat optional dashboard fields as normal for partial runs and policies that skip an agent.
- Do not expand into generic agent-building, full RL training, arbitrary repository support, or production orchestration unless the user explicitly reprioritises the project.
