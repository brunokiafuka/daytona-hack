import { loadDashboardData } from "/data.js";

const app = document.querySelector("#app");
const state = { view: "overview", traceFilter: "all", selectedEvent: "e09" };
const icons = { overview: "⌘", episode: "◉", trace: "≡", experiments: "↗", read: "⌕", search: "⌕", plan: "✦", edit: "✎", test: "✓" };
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const title = (word) => word[0].toUpperCase() + word.slice(1);

function navItem(key, label) { return `<button class="nav-item ${state.view === key ? "is-active" : ""}" data-view="${key}"><span>${icons[key]}</span>${label}</button>`; }
function badge(status) { return `<span class="badge badge-${status}"><i></i>${({ passed: "Complete", running: "Running", queued: "Queued", pending: "Pending" })[status] ?? title(status)}</span>`; }

function header(eyebrow, heading, lead, action = "") {
  return `<header class="page-header"><div><p class="eyebrow">${eyebrow}</p><h1>${heading}</h1><p class="lead">${lead}</p></div>${action}</header>`;
}

function pipeline(episode) {
  return `<section class="pipeline panel"><div class="section-heading"><div><p class="eyebrow">Episode pipeline</p><h2>Autonomous change loop</h2></div><span class="sandbox">Daytona sandbox active</span></div><div class="pipeline-track">${episode.agents.map((agent, index) => `<div class="pipeline-node ${agent.state}"><div class="node-number">0${index + 1}</div><div><strong>${agent.label}</strong><span>${agent.detail}</span></div><div class="node-state">${agent.state === "passed" ? "✓" : agent.state === "running" ? "↻" : "·"}</div></div>${index < episode.agents.length - 1 ? `<div class="pipeline-line ${agent.state === "passed" ? "done" : ""}"></div>` : ""}`).join("")}</div></section>`;
}

function metrics(episode) { return `<section class="metrics">${episode.metrics.map((metric) => `<article class="metric-card metric-${metric.tone ?? "default"}"><p>${metric.label}</p><strong>${metric.value}</strong><span>${metric.note}</span></article>`).join("")}</section>`; }

function traceRow(event) {
  const result = event.state === "failed" ? "Test failed" : event.state === "running" ? "In progress" : "Complete";
  return `<button class="trace-row ${state.selectedEvent === event.id ? "selected" : ""}" data-event="${event.id}"><span class="step">${event.step}</span><span class="agent-dot ${event.agent}"></span><span class="trace-title"><b>${icons[event.kind] ?? "·"}</b><span><strong>${escapeHtml(event.title)}</strong><em>${event.agent} · ${event.time} · ${event.duration}</em></span></span><span class="trace-result ${event.state}">${result}</span></button>`;
}

function tracePanel(episode, compact = false) {
  const events = state.traceFilter === "all" ? episode.trace : episode.trace.filter((event) => event.agent === state.traceFilter);
  const selected = episode.trace.find((event) => event.id === state.selectedEvent) ?? events.at(-1);
  const controls = ["all", "planner", "coder", "reviewer"].map((filter) => `<button class="filter ${state.traceFilter === filter ? "selected" : ""}" data-filter="${filter}">${filter === "all" ? "All agents" : title(filter)}</button>`).join("");
  return `<section class="trace-panel panel ${compact ? "compact" : ""}"><div class="section-heading"><div><p class="eyebrow">Agent trace</p><h2>${compact ? "Decision trail" : "Every action, inspectable"}</h2></div>${compact ? `<button class="text-button" data-view="trace">Open full trace →</button>` : ""}</div>${compact ? `<div class="timeline">${events.slice(-5).map(traceRow).join("")}</div>` : `<div class="trace-layout"><div><div class="filter-row">${controls}</div><div class="timeline">${events.map(traceRow).join("")}</div></div><aside class="event-detail"><p class="eyebrow">Step ${selected?.step ?? "—"} · ${selected?.agent ?? "—"}</p><h3>${escapeHtml(selected?.title ?? "Select an event")}</h3><div class="command"><span>Command</span><code>${escapeHtml(selected?.command ?? "")}</code></div><div class="observation"><span>Observation</span><pre>${escapeHtml(selected?.output ?? "")}</pre></div></aside></div>`}</section>`;
}

function evidence(episode) {
  return `<section class="evidence-grid"><article class="evidence-card panel"><div class="card-top"><div><p class="eyebrow">Planner output</p><h3>Investigation complete</h3></div>${badge("passed")}</div><p class="diagnosis">${escapeHtml(episode.planner.diagnosis)}</p><div class="file-chips">${episode.planner.files.map((file) => `<code>${escapeHtml(file)}</code>`).join("")}</div><ol>${episode.planner.plan.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol></article><article class="evidence-card panel"><div class="card-top"><div><p class="eyebrow">Review gate</p><h3>Waiting for final patch</h3></div>${badge("pending")}</div><p>The Reviewer receives a fresh sandbox with only the Coder patch applied.</p><ul class="check-list"><li><span>○</span>Resolves issue</li><li><span>○</span>No regressions</li><li><span>○</span>Minimal change</li><li><span>○</span>Tests untouched</li></ul><div class="soft-note">Policy D sends a rejection back to Coder for a bounded retry.</div></article><article class="evidence-card panel"><div class="card-top"><div><p class="eyebrow">Episode evaluation</p><h3>Reward pending</h3></div>${badge("pending")}</div><ul class="check-list">${episode.evaluation.map((item) => `<li><span class="${item.state}">${item.state === "passed" ? "✓" : "○"}</span>${item.label}</li>`).join("")}</ul><div class="reward-note">Reward is calculated only after the hidden evaluation completes.</div></article></section>`;
}

function context(episode) { return `<section class="run-context panel"><div class="section-heading"><div><p class="eyebrow">Run context</p><h2>Reproducible by design</h2></div></div><div class="context-item"><span>Repository</span><strong>${episode.issue.repository}</strong></div><div class="context-item"><span>Planner sandbox</span><code>${episode.sandboxes.planner}</code></div><div class="context-item"><span>Coder sandbox</span><code>${episode.sandboxes.coder}</code></div><div class="context-item"><span>Data source</span><strong>Replay fixture</strong></div></section>`; }

function episodeView(data) {
  const episode = data.episode;
  const action = `<div class="header-actions"><button class="secondary-button" data-view="experiments">View experiment</button><button class="primary-button" data-view="trace">Inspect trace <span>→</span></button></div>`;
  return `<main class="page episode-page">${header(`${episode.issue.repository} · ${episode.task_id}`, `Issue #${episode.issue.number}: ${escapeHtml(episode.issue.title)}`, `<span class="status-running"><i></i> Episode running</span> <span>Policy ${episode.policy.key}</span> <span>Base ${episode.issue.base_commit}</span>`, action)}${pipeline(episode)}${metrics(episode)}<div class="split-view">${tracePanel(episode, true)}${context(episode)}</div>${evidence(episode)}</main>`;
}

function overviewMetric(metric) {
  return `<article class="overview-metric overview-metric-${metric.tone}"><p>${escapeHtml(metric.label)}</p><strong>${escapeHtml(metric.value)}</strong><span>${escapeHtml(metric.note)}</span></article>`;
}

function organisationPipeline(pipelineData) {
  const stages = pipelineData.stages.map((stage, index) => `<article class="flow-stage flow-stage-${stage.key}"><p class="flow-index">0${index + 1}</p><h3>${escapeHtml(stage.label)}</h3><strong>${escapeHtml(stage.value)}</strong><span>${escapeHtml(stage.detail)}</span>${stage.score ? `<div class="success-score"><b>${escapeHtml(stage.score.value)}</b><em>${escapeHtml(stage.score.label)}</em></div>` : ""}</article>${index < pipelineData.stages.length - 1 ? '<span class="flow-arrow" aria-hidden="true">→</span>' : ""}`).join("");
  const resolved = pipelineData.stages.find((stage) => stage.key === "resolved");
  return `<section class="organisation-pipeline panel"><div class="section-heading"><div><p class="eyebrow">Autonomous delivery pipeline</p><h2>From ticket intake to verified resolution</h2></div><div class="pipeline-utilities">${resolved?.score ? `<span class="pipeline-success">${escapeHtml(resolved.score.value)} ${escapeHtml(resolved.score.label)}</span>` : ""}<span class="replay-label">Replay data</span></div></div><p class="section-context">${escapeHtml(pipelineData.period)}</p><div class="flow-track">${stages}</div></section>`;
}

function priorityQueue(tickets) {
  return `<section class="priority-queue panel"><div class="section-heading"><div><p class="eyebrow">Priority queue</p><h2>Work needing attention now</h2></div><span class="queue-count">${tickets.length} highlighted</span></div><div class="queue-list">${tickets.map((ticket) => `<article class="queue-row"><div class="queue-ticket"><span class="queue-id">${escapeHtml(ticket.id)}</span><div><h3>${escapeHtml(ticket.title)}</h3><p>${escapeHtml(ticket.repository)}</p></div></div><span class="priority priority-${ticket.priority.toLowerCase()}">${escapeHtml(ticket.priority)}</span><span class="queue-age">${escapeHtml(ticket.age)}</span><span class="queue-stage">${escapeHtml(ticket.stage)}</span></article>`).join("")}</div></section>`;
}

function learningEvidence(learning) {
  return `<section class="learning-evidence panel"><div class="section-heading"><div><p class="eyebrow">Reinforcement evidence</p><h2>Each outcome strengthens the next decision</h2></div><span class="learning-mark">↗</span></div><p class="section-context">${escapeHtml(learning.period)}</p><div class="learning-metrics">${learning.metrics.map((metric) => `<article><p>${escapeHtml(metric.label)}</p><strong>${escapeHtml(metric.value)}</strong><span>${escapeHtml(metric.note)}</span></article>`).join("")}</div><div class="policy-gain"><p>Measured policy gain</p><h3>${escapeHtml(learning.policy.name)}</h3><div><strong>${escapeHtml(learning.policy.success_gain)}</strong><span>success</span><strong>${escapeHtml(learning.policy.reward_gain)}</strong><span>reward</span></div><small>${escapeHtml(learning.policy.baseline)}</small></div><p class="learning-note">${escapeHtml(learning.note)}</p><button class="text-button" data-view="experiments">Inspect policy evidence →</button></section>`;
}

function overviewView(data) {
  const overview = data.overview;
  const action = `<button class="primary-button" data-view="episode">Open active episode <span>→</span></button>`;
  return `<main class="page overview-page">${header(`Organisation-wide operations · ${overview.snapshot_label}`, "Autonomous engineering capacity, visible.", "A deterministic replay of an engineering organisation where every ticket, agent handoff, and evaluated outcome remains inspectable.", action)}${organisationPipeline(overview.pipeline)}<section class="backlog-health panel"><div class="section-heading"><div><p class="eyebrow">Backlog health</p><h2>Demand is high. The work is moving.</h2></div><span class="backlog-period">${escapeHtml(overview.backlog.period)}</span></div><div class="overview-metrics">${overview.backlog.metrics.map(overviewMetric).join("")}</div></section><section class="overview-lower">${priorityQueue(overview.priority_queue)}${learningEvidence(overview.learning)}</section></main>`;
}

function experimentsView(data) {
  const best = data.experiments.reduce((leader, item) => item.reward > leader.reward ? item : leader, data.experiments[0]);
  const points = data.points.map((point) => `<button class="plot-point ${point.policy.toLowerCase()}" style="left:${((point.tokens - 28) / 28) * 86 + 7}%;bottom:${((point.reward - .55) / .42) * 78 + 10}%" title="Policy ${point.policy}: reward ${point.reward}, ${point.tokens}k tokens">${point.policy}</button>`).join("");
  return `<main class="page experiments-page">${header("Engineering-v1 · 10 benchmark tasks", "Compare policy trade-offs.", "Success decides the winner. Reward separates efficient successes from expensive ones.", `<div class="winner-callout"><span>Best overall</span><strong>Policy ${best.key}</strong><em>${best.success}% success · ${best.reward.toFixed(2)} reward</em></div>`)}<section class="experiment-summary"><article class="panel plot-panel"><div class="section-heading"><div><p class="eyebrow">Episode distribution</p><h2>Reward vs. token cost</h2></div><div class="legend"><span class="a">A</span><span class="b">B</span><span class="c">C</span><span class="d">D</span></div></div><div class="plot"><span class="axis-y">Reward →</span><span class="axis-x">Total tokens (k) →</span><div class="grid-line h1"></div><div class="grid-line h2"></div><div class="grid-line v1"></div><div class="grid-line v2"></div>${points}</div></article><article class="panel experiment-note"><p class="eyebrow">Read the chart</p><h2>Policy D pays more, then earns it back.</h2><p>The Reviewer retry loop increases token use and duration, but produces the highest success rate and reward across the replay benchmark.</p><div class="signal"><b>+16 pp</b><span>success vs. Planner + Coder</span></div><div class="signal"><b>+0.21</b><span>reward vs. Planner + Coder</span></div></article></section><section class="panel results-table"><div class="section-heading"><div><p class="eyebrow">Experiment results</p><h2>Policy comparison</h2></div><span class="replay-label">Replay data</span></div><div class="table-scroll"><table><thead><tr><th>Policy</th><th>Success</th><th>Reward</th><th>Median duration</th><th>Avg. tokens</th><th>Coder steps</th><th>Reviewer approval</th></tr></thead><tbody>${data.experiments.map((item) => `<tr class="${item.key === best.key ? "best-row" : ""}"><td><span class="policy-key ${item.colour}">${item.key}</span><strong>${item.name}</strong>${item.key === best.key ? "<small>Best overall</small>" : ""}</td><td><b>${item.success}%</b></td><td><b>${item.reward.toFixed(2)}</b></td><td>${item.duration}</td><td>${item.tokens}</td><td>${item.steps}</td><td>${item.review ? `${item.review}%` : "—"}</td></tr>`).join("")}</tbody></table></div></section></main>`;
}

function render(data) {
  const views = { overview: overviewView, episode: episodeView, trace: (source) => `<main class="page trace-page">${header(`${source.episode.issue.repository} · Replay episode`, "Agent trace", "Inspect the decisions, tool calls, and observations that led to this outcome.", `<button class="secondary-button" data-view="episode">← Episode overview</button>`)}${tracePanel(source.episode)}</main>`, experiments: experimentsView };
  app.innerHTML = `<div class="app-shell"><aside class="sidebar"><a class="brand" href="#"><span>✦</span><strong>Agent Atlas</strong></a><div class="workspace"><span class="workspace-dot"></span><span>Engineering-v1</span><button>⌄</button></div><nav>${navItem("overview", "Overview")}${navItem("episode", "Live episode")}${navItem("trace", "Agent trace")}${navItem("experiments", "Experiments")}</nav><div class="sidebar-footer"><span class="data-chip"><i></i> Replay data</span><p>schema ${data.schema_version}</p></div></aside><section class="content"><div class="topbar"><span>Autonomous engineering agent</span><span>Updated ${new Date(data.updated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>${views[state.view](data)}</section></div>`;
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => { state.view = button.dataset.view; render(data); }));
  document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => { state.traceFilter = button.dataset.filter; render(data); }));
  document.querySelectorAll("[data-event]").forEach((button) => button.addEventListener("click", () => { state.selectedEvent = button.dataset.event; render(data); }));
}

loadDashboardData().then(render).catch((error) => { app.innerHTML = `<main class="fatal"><h1>Dashboard data unavailable</h1><p>${escapeHtml(error.message)}</p></main>`; });
