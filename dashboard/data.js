/**
 * Versioned dashboard read model. Replace loadDashboardData with a fetch to
 * the runner adapter when it exists; the UI never imports runner internals.
 */
export const dashboardData = {
  schema_version: "1.1",
  source: "replay",
  updated_at: "2026-08-29T14:23:08Z",
  episode: {
    id: "fix-session-ttl-D-7f42c9",
    task_id: "fix-session-ttl",
    issue: { number: 1842, title: "Refresh sessions before they expire", repository: "acme/auth-service", base_commit: "a91f3ce" },
    policy: { key: "D", name: "Planner + Coder + Reviewer + Retry" },
    status: "running",
    sandboxes: { planner: "sbx-plan-18e", coder: "sbx-code-512" },
    agents: [
      { key: "planner", label: "Planner", state: "passed", detail: "Confidence 0.84" },
      { key: "coder", label: "Coder", state: "running", detail: "Iteration 3" },
      { key: "reviewer", label: "Reviewer", state: "queued", detail: "Awaiting patch" },
      { key: "evaluation", label: "Evaluation", state: "pending", detail: "Hidden oracle" },
    ],
    metrics: [
      { label: "Tests", value: "44 / 47", tone: "warn", note: "3 failures remaining" },
      { label: "Actions", value: "17", note: "across 2 agents" },
      { label: "Iterations", value: "3", note: "coder test runs" },
      { label: "Reward", value: "—", tone: "muted", note: "pending evaluation" },
      { label: "Tokens", value: "28.4k", note: "input + output" },
      { label: "Elapsed", value: "04:06", note: "sandbox active" },
    ],
    planner: {
      diagnosis: "The refresh path uses the original session expiry instead of the rotated token’s TTL.",
      files: ["src/auth/session.ts", "src/auth/refresh.ts", "src/auth/types.ts"],
      plan: ["Trace refresh-token creation and expiry calculation.", "Derive the new expiry from configured session TTL.", "Run focused auth tests, then the full suite."],
    },
    evaluation: [
      { label: "Visible test command", state: "pending" }, { label: "Hidden evaluation command", state: "pending" },
      { label: "Tests untouched", state: "passed" }, { label: "Meaningful diff", state: "passed" },
    ],
    trace: [
      { id: "e01", step: "01", agent: "planner", kind: "read", title: "Read task and repository structure", command: "read_file README.md", output: "Found auth service conventions and test commands.", time: "14:19:09", duration: "0.3s", state: "ok" },
      { id: "e02", step: "02", agent: "planner", kind: "search", title: "Locate refresh-token flow", command: "search_repository refreshSession", output: "3 relevant source files found.", time: "14:19:13", duration: "0.8s", state: "ok" },
      { id: "e03", step: "03", agent: "planner", kind: "plan", title: "Publish implementation plan", command: "emit_plan", output: "Confidence 0.84 — cleared policy gate 0.60.", time: "14:19:31", duration: "1.2s", state: "ok" },
      { id: "e04", step: "01", agent: "coder", kind: "read", title: "Inspect expiry calculation", command: "read_file src/auth/refresh.ts", output: "Existing code reuses the original session expiration.", time: "14:20:04", duration: "0.5s", state: "ok" },
      { id: "e05", step: "02", agent: "coder", kind: "edit", title: "Update rotated-token TTL", command: "write_file src/auth/refresh.ts", output: "Changed one production file.", time: "14:20:43", duration: "0.9s", state: "ok" },
      { id: "e06", step: "03", agent: "coder", kind: "test", title: "Run focused auth tests", command: "pnpm test auth", output: "3 tests failed: expiry uses local time in one code path.", time: "14:21:07", duration: "18.4s", state: "failed" },
      { id: "e07", step: "04", agent: "coder", kind: "read", title: "Inspect failing path", command: "read_file src/auth/session.ts", output: "Expiry is converted before the configured duration is applied.", time: "14:21:29", duration: "0.4s", state: "ok" },
      { id: "e08", step: "05", agent: "coder", kind: "edit", title: "Apply UTC-safe expiry calculation", command: "write_file src/auth/session.ts", output: "Changed one production file.", time: "14:22:01", duration: "0.7s", state: "ok" },
      { id: "e09", step: "06", agent: "coder", kind: "test", title: "Run focused auth tests", command: "pnpm test auth", output: "44 / 47 passed. Agent is investigating the remaining edge cases.", time: "14:22:28", duration: "19.1s", state: "running" },
    ],
  },
  overview: {
    snapshot_label: "Deterministic replay snapshot",
    backlog: {
      period: "Current organisation snapshot",
      metrics: [
        { label: "Open backlog", value: "12,847", note: "Across 38 engineering services", tone: "backlog" },
        { label: "Created today", value: "428", note: "18 new issues per hour", tone: "intake" },
        { label: "Urgent", value: "238", note: "Critical and high-priority work", tone: "urgent" },
        { label: "Aging tickets", value: "1,109", note: "Open for more than 7 days", tone: "aging" },
      ],
    },
    pipeline: {
      period: "Current work in progress · resolved output over the last 30 days",
      stages: [
        { key: "backlog", label: "Incoming backlog", value: "12,847", detail: "428 created today" },
        { key: "planner", label: "Planner", value: "1,284", detail: "Triaging scope and risk" },
        { key: "coder", label: "Coder", value: "742", detail: "Implementing tested fixes" },
        { key: "reviewer", label: "Reviewer", value: "186", detail: "Independent quality gates" },
        { key: "resolved", label: "Resolved", value: "6,482", detail: "Verified in the last 30 days", score: { value: "86%", label: "verified success score" } },
      ],
    },
    priority_queue: [
      { id: "#6911", title: "Prevent duplicate invoice captures after payment retries", repository: "acme/payments-api", priority: "Critical", age: "8m", stage: "Planner" },
      { id: "#1842", title: "Refresh sessions before they expire", repository: "acme/auth-service", priority: "High", age: "17m", stage: "Coder" },
      { id: "#8247", title: "Preserve audit events during shard failover", repository: "acme/event-platform", priority: "High", age: "24m", stage: "Reviewer" },
      { id: "#3574", title: "Stop stale inventory reservations after cancelled orders", repository: "acme/fulfilment-core", priority: "High", age: "41m", stage: "Planner" },
    ],
    learning: {
      period: "Evidence captured from evaluated episodes",
      metrics: [
        { label: "Evaluated trajectories", value: "7,263", note: "Tool actions, observations, and outcomes retained" },
        { label: "Validated patterns", value: "184", note: "Reusable, evidence-backed engineering strategies" },
      ],
      policy: { name: "Policy D", success_gain: "+16 pp", reward_gain: "+0.16", baseline: "versus Policy A across the replay benchmark" },
      note: "Evaluation signals and preserved trajectories inform policy selection and future improvement. This replay does not claim live model training or fine-tuning.",
    },
  },
  experiments: [
    { key: "A", name: "Planner + Coder + Reviewer", success: 70, reward: 0.71, duration: "6m 12s", tokens: "41.2k", steps: 26, review: 83, colour: "blue" },
    { key: "B", name: "Planner + Coder", success: 63, reward: 0.66, duration: "5m 08s", tokens: "34.5k", steps: 22, review: null, colour: "slate" },
    { key: "C", name: "Coder + Reviewer", success: 78, reward: 0.79, duration: "5m 44s", tokens: "37.8k", steps: 24, review: 81, colour: "violet" },
    { key: "D", name: "Planner + Coder + Reviewer + Retry", success: 86, reward: 0.87, duration: "7m 19s", tokens: "49.1k", steps: 31, review: 92, colour: "mint" },
  ],
  points: [{ policy: "A", reward: .74, tokens: 38 }, { policy: "A", reward: .68, tokens: 43 }, { policy: "A", reward: .71, tokens: 42 }, { policy: "B", reward: .63, tokens: 31 }, { policy: "B", reward: .69, tokens: 36 }, { policy: "B", reward: .65, tokens: 37 }, { policy: "C", reward: .82, tokens: 39 }, { policy: "C", reward: .75, tokens: 35 }, { policy: "C", reward: .8, tokens: 40 }, { policy: "D", reward: .91, tokens: 52 }, { policy: "D", reward: .85, tokens: 48 }, { policy: "D", reward: .86, tokens: 47 }],
};

export async function loadDashboardData() { return dashboardData; }
