/**
 * Agent Atlas — dashboard client. Talks only to /api/* (the versioned read
 * model served by server.mjs); never reads runner files directly.
 */
const app = document.querySelector("#app");
const theme = {
  get: () => {
    try {
      return (
        localStorage.getItem("atlas-theme") ||
        (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      );
    } catch {
      return "light";
    }
  },
  apply(t) {
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem("atlas-theme", t);
    } catch {}
  },
};
theme.apply(theme.get());
const state = {
  view: "home", // home | overview | episodes | episode | experiments | experiment | sandboxes
  tab: "overview", // episode sub-page: overview | traces | logs | sandboxes | diff
  xtab: "results", // experiment sub-page: results | episodes
  episodesFilter: "live", // live | all
  showDemo: false, // include seeded replay episodes/experiments in lists and aggregates
  episodeId: null, // null = follow the most recent episode
  follow: true,
  experimentId: "all",
  traceFilter: "all",
  selectedEvent: null,
  logFilter: "all",
  terminal: null, // sandbox id to isolate in the episode terminal (null = whole episode)
  termFollow: true, // auto-scroll terminals to the newest command
  diffOpen: false,
  trigger: {
    issue: null,
    policy: "A",
    policies: ["A", "B", "C"],
    tasks: [],
    concurrency: 3,
  },
  busy: false,
  notice: null,
};
const cache = {
  config: null,
  issues: [],
  tasks: [],
  episodes: [],
  runs: [],
  sandboxes: null,
  episode: null,
  experiments: [],
  experiment: null,
  overview: null,
  updated_at: null,
  error: null,
};
const svg = (d, extra = "") =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"${extra}>${d}</svg>`;
const icons = {
  overview: svg('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
  home: svg(
    '<path d="M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z"/>',
  ),
  episodes: svg(
    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
  ),
  experiments: svg(
    '<path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2.2h12.4a1.5 1.5 0 0 0 1.3-2.2L14 9V3"/><path d="M7.5 15h9"/>',
  ),
  sandboxes: svg(
    '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
  ),
  terminal: svg('<path d="M4 17l6-5-6-5"/><path d="M12 19h8"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  read: svg(
    '<path d="M4 4h10l6 6v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M14 4v6h6"/>',
  ),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  edit: svg(
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  ),
  test: svg(
    '<path d="M9 3h6M10 3v5.5L5 18a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 18l-5-9.5V3"/>',
  ),
  bash: svg('<path d="m5 7 5 5-5 5"/><path d="M12 19h7"/>'),
  plan: svg(
    '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  ),
  check: svg('<path d="m5 12 4.5 4.5L19 7"/>'),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  spin: svg('<path d="M21 12a9 9 0 1 1-3.2-6.9"/><path d="M21 3v6h-6"/>'),
  sun: svg(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  ),
  moon: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  dash: svg('<path d="M6 12h12"/>'),
  dot: svg('<circle cx="12" cy="12" r="2" fill="currentColor"/>'),
  brand: svg(
    '<path d="M12 2l2.4 7.6H22l-6.2 4.5 2.4 7.6L12 17.2l-6.2 4.5 2.4-7.6L2 9.6h7.6z"/>',
  ),
  arrow: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  external: svg(
    '<path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  ),
};
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>'"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        c
      ],
  );
const title = (w) => (w ? w[0].toUpperCase() + w.slice(1) : "");
const fmtTokens = (n) =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0);
const fmtDuration = (ms) => {
  const s = Math.max(0, Math.round((ms ?? 0) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const ago = (iso) => {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60
    ? `${Math.round(s)}s ago`
    : s < 3600
      ? `${Math.round(s / 60)}m ago`
      : `${(s / 3600).toFixed(1)}h ago`;
};
const stateLabel = {
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  abstained: "Abstained",
  error: "Error",
  done: "Complete",
  queued: "Queued",
  pending: "Pending",
  skipped: "Skipped",
  rejected: "Rejected",
  errored: "Errored",
  stopped: "Stopped",
};

// ---- routing (hash) ----------------------------------------------------------
// #/ · #/overview · #/episodes · #/episodes/<id|live>/<overview|traces|logs|sandboxes|diff>
// #/experiments · #/experiments/<id|all>/<results|episodes> · #/sandboxes
const EP_TABS = ["overview", "traces", "logs", "sandboxes", "diff"];
function readHash() {
  const parts = location.hash
    .replace(/^#\/?/, "")
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  const [view = "home", a, b] = parts;
  if (view === "episodes" && a) {
    state.view = "episode";
    state.follow = a === "live";
    state.episodeId = state.follow ? null : a;
    state.tab = EP_TABS.includes(b) ? b : "overview";
  } else if (view === "episodes") state.view = "episodes";
  else if (view === "experiments" && a) {
    state.view = "experiment";
    state.experimentId = a;
    state.xtab = b === "episodes" ? "episodes" : "results";
  } else if (view === "experiments") state.view = "experiments";
  else if (view === "sandboxes") state.view = "sandboxes";
  else if (view === "overview") state.view = "overview";
  else state.view = "home";
}
function hashFor(st = state) {
  switch (st.view) {
    case "episode":
      return `#/episodes/${encodeURIComponent(st.follow ? "live" : (st.episodeId ?? "live"))}/${st.tab}`;
    case "experiment":
      return `#/experiments/${encodeURIComponent(st.experimentId)}/${st.xtab}`;
    case "home":
      return "#/";
    default:
      return `#/${st.view}`;
  }
}
function writeHash() {
  const h = hashFor();
  if (location.hash !== h) history.replaceState(null, "", h);
}
function go(patch) {
  Object.assign(state, patch);
  writeHash();
  refresh({ force: true });
}

// ---- data ------------------------------------------------------------------
async function get(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
async function post(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
}

const visibleEpisodes = () =>
  cache.episodes.filter((e) => state.showDemo || !e.demo);
const visibleExperiments = () =>
  cache.experiments.filter((x) => state.showDemo || !x.demo);
const visibleRuns = () =>
  cache.runs.filter((r) => state.showDemo || r.kind !== "demo");
function currentEpisodeId() {
  if (state.episodeId && !state.follow) return state.episodeId;
  const eps = visibleEpisodes();
  const running = eps.find((e) => e.state === "running");
  return (running ?? eps[0])?.id ?? null;
}

async function refresh(opts = {}) {
  force = Boolean(opts.force);
  try {
    const [eps, runs] = await Promise.all([
      get("/api/episodes"),
      get("/api/runs"),
    ]);
    cache.episodes = eps.episodes;
    cache.updated_at = eps.updated_at;
    cache.runs = runs.runs;
    if (!cache.config) {
      cache.config = await get("/api/config");
      state.trigger.concurrency = cache.config.concurrency;
    }
    if (!cache.issues.length) {
      try {
        cache.issues = (await get("/api/issues")).issues;
      } catch {}
    }
    if (!cache.tasks.length) {
      cache.tasks = (await get("/api/tasks")).tasks;
      if (!state.trigger.tasks.length)
        state.trigger.tasks = cache.tasks.map((t) => t.task_id);
    }
    if (!state.trigger.issue && cache.issues.length)
      state.trigger.issue = cache.issues[0].ref;
    if (["episode", "home"].includes(state.view)) {
      const id = currentEpisodeId();
      cache.episode = id
        ? (await get(`/api/episodes/${encodeURIComponent(id)}`)).episode
        : null;
    }
    if (["experiment", "experiments", "home"].includes(state.view)) {
      cache.experiments = (await get("/api/experiments")).experiments;
      if (
        state.experimentId !== "all" &&
        !cache.experiments.some((x) => x.id === state.experimentId)
      )
        state.experimentId = "all";
      try {
        cache.experiment = (
          await get(
            `/api/experiments/${encodeURIComponent(state.experimentId)}${state.experimentId === "all" && state.showDemo ? "?demo=1" : ""}`,
          )
        ).experiment;
      } catch {
        cache.experiment = null;
      }
    }
    if (["sandboxes", "home", "episode"].includes(state.view))
      cache.sandboxes = await get("/api/sandboxes");
    if (state.view === "overview")
      cache.overview = (await get("/api/overview")).overview;
    cache.error = null;
  } catch (err) {
    cache.error = err.message;
  }
  // Only touch the DOM when something actually changed — re-rendering identical
  // markup every poll is what makes the page flicker and lose scroll/focus.
  const sig = JSON.stringify([
    state,
    cache.episodes,
    cache.runs,
    cache.episode,
    cache.experiments,
    cache.experiment,
    cache.overview,
    cache.sandboxes?.sandboxes,
    cache.error,
  ]);
  if (sig !== lastSig || force) {
    lastSig = sig;
    try {
      render();
    } catch (err) {
      console.error("[atlas] render failed", err);
      throw err;
    }
  }
}
let lastSig = "";
let force = false;

// ---- shared pieces ---------------------------------------------------------
function navItem(key, label, count) {
  return `<button class="nav-item ${state.view === key ? "is-active" : ""}" data-view="${key}"><span>${icons[key]}</span>${label}${count ? `<em class="nav-count">${count}</em>` : ""}</button>`;
}
function badge(s) {
  return `<span class="badge badge-${s}"><i></i>${stateLabel[s] ?? title(s)}</span>`;
}
const replayTag = (x) =>
  x?.demo
    ? `<span class="badge badge-replay" title="Seeded replay — not a live run">Replay</span>`
    : "";
function header(eyebrow, heading, lead, action = "") {
  return `<header class="page-header"><div><p class="eyebrow">${eyebrow}</p><h1>${heading}</h1><p class="lead">${lead}</p></div>${action}</header>`;
}
function policyKey(p) {
  return `<span class="policy-key ${p.colour}">${p.key}</span>`;
}
function notice() {
  return state.notice
    ? `<div class="notice ${state.notice.kind}">${esc(state.notice.text)}<button class="text-button" data-dismiss>✕</button></div>`
    : "";
}

function pipeline(ep) {
  const sandboxLabel =
    ep.state === "running"
      ? `Daytona · ${ep.phase}${ep.detail ? ` · ${esc(ep.detail)}` : ""}`
      : `${Object.values(ep.sandboxes ?? {}).flat().length} sandboxes used`;
  return `<section class="pipeline panel"><div class="section-heading"><div><p class="eyebrow">Episode pipeline</p><h2>Autonomous change loop</h2></div><span class="sandbox ${ep.state === "running" ? "live" : ""}">${sandboxLabel}</span></div><div class="pipeline-track">${ep.agents.map((a, i) => `<div class="pipeline-node ${a.state}"><div class="node-number">0${i + 1}</div><div><strong>${a.label}</strong><span title="${esc(a.detail)}">${esc(a.detail)}</span></div><div class="node-state">${a.state === "passed" ? icons.check : a.state === "running" ? icons.spin : a.state === "rejected" || a.state === "errored" ? icons.x : a.state === "skipped" ? icons.dash : icons.dot}</div></div>${i < ep.agents.length - 1 ? `<div class="pipeline-line ${a.state === "passed" ? "done" : ""}"></div>` : ""}`).join("")}</div>${ep.attempt ? `<p class="retry-note">Reviewer sent the patch back · retry ${ep.attempt}</p>` : ""}</section>`;
}
function metrics(ep) {
  return `<section class="metrics">${ep.metrics.map((m) => `<article class="metric-card metric-${m.tone ?? "default"}"><p>${m.label}</p><strong>${esc(m.value)}</strong><span title="${esc(m.note)}">${esc(m.note)}</span></article>`).join("")}</section>`;
}

function traceRow(ev) {
  const result = ev.state === "failed" ? `exit ${ev.exit_code}` : "ok";
  return `<button class="trace-row ${state.selectedEvent === ev.id ? "selected" : ""}" data-event="${ev.id}"><span class="step">${ev.step}</span><span class="agent-dot ${ev.agent}"></span><span class="trace-title"><b>${icons[ev.kind] ?? icons.bash}</b><span><strong>${esc(ev.title)}</strong><em>${ev.agent} · ${ev.time} · ${ev.duration}${ev.output_preview ? ` · ${esc(ev.output_preview)}` : ""}</em></span></span><span class="trace-result ${ev.state}">${result}</span></button>`;
}
function tracePanel(ep, compact = false) {
  const all = ep.trace;
  const events =
    state.traceFilter === "all"
      ? all
      : all.filter((e) => e.agent === state.traceFilter);
  const selected =
    all.find((e) => e.id === state.selectedEvent) ?? events.at(-1);
  const controls = ["all", "planner", "coder", "reviewer"]
    .map(
      (f) =>
        `<button class="filter ${state.traceFilter === f ? "selected" : ""}" data-filter="${f}">${f === "all" ? `All (${all.length})` : `${title(f)} (${all.filter((e) => e.agent === f).length})`}</button>`,
    )
    .join("");
  const empty = `<p class="empty">No agent actions recorded yet${ep.state === "running" ? " — sandbox is booting" : ""}.</p>`;
  if (compact)
    return `<section class="trace-panel panel compact"><div class="section-heading"><div><p class="eyebrow">Agent trace</p><h2>Decision trail · ${all.length} actions</h2></div><button class="text-button" data-tab="traces">Open full trace →</button></div><div class="timeline">${events.length ? events.slice(-6).map(traceRow).join("") : empty}</div></section>`;
  return `<section class="trace-panel panel"><div class="section-heading"><div><p class="eyebrow">Agent trace</p><h2>Every action, inspectable</h2></div></div><div class="trace-layout"><div><div class="filter-row">${controls}</div><div class="timeline">${events.length ? events.map(traceRow).join("") : empty}</div></div><aside class="event-detail"><p class="eyebrow">Step ${selected?.step ?? "—"} · ${selected?.agent ?? "—"} · ${selected?.tool ?? ""}</p><h3>${esc(selected?.title ?? "Select an event")}</h3><div class="command"><span>Command</span><code>${esc(selected?.command ?? "")}</code></div>${selected?.tool === "write_file" ? `<div class="observation"><span>Content</span><pre>${esc(selected.input?.content ?? "")}</pre></div>` : ""}<div class="observation"><span>Observation${selected?.exit_code !== undefined ? ` · exit ${selected.exit_code}` : ""}</span><pre>${esc(selected?.output ?? "")}</pre></div></aside></div></section>`;
}

function logsPanel(ep, compact = false) {
  const phases = ["all", ...new Set(ep.logs.map((l) => l.phase))];
  const logs =
    state.logFilter === "all"
      ? ep.logs
      : ep.logs.filter((l) => l.phase === state.logFilter);
  const rows = (compact ? logs.slice(-8) : logs)
    .map(
      (l) =>
        `<details class="log-line ${l.level}" data-key="${l.id}" ${l.output ? "" : "data-empty"}><summary><span class="log-time">${l.time}</span><span class="log-phase ${l.phase}">${l.phase}</span><span class="log-msg">${esc(l.message)}</span>${l.exit_code !== undefined ? `<span class="log-exit ${l.exit_code === 0 ? "ok" : "failed"}">exit ${l.exit_code}</span>` : ""}${l.duration_ms ? `<span class="log-dur">${(l.duration_ms / 1000).toFixed(1)}s</span>` : ""}</summary>${l.output ? `<pre>${esc(l.output)}</pre>` : ""}</details>`,
    )
    .join("");
  return `<section class="logs-panel panel ${compact ? "compact" : ""}"><div class="section-heading"><div><p class="eyebrow">Sandbox log</p><h2>${compact ? "Orchestrator & sandbox" : "Boot, clone, setup, tests, oracle"}</h2></div>${compact ? `<button class="text-button" data-tab="logs">All logs →</button>` : `<div class="filter-row">${phases.map((p) => `<button class="filter ${state.logFilter === p ? "selected" : ""}" data-logfilter="${p}">${p}</button>`).join("")}</div>`}</div><div class="log-list">${rows || `<p class="empty">No log lines yet.</p>`}</div></section>`;
}

function diffPanel(ep) {
  const d = ep.diff;
  if (!d.files.length)
    return `<section class="panel diff-panel"><div class="section-heading"><div><p class="eyebrow">Patch</p><h2>No changes yet</h2></div></div><p class="empty">The coder has not produced a diff${ep.state === "running" ? " yet" : ""}.</p></section>`;
  const lines = d.text
    .split("\n")
    .map((l) => {
      const c =
        l.startsWith("+++") || l.startsWith("---")
          ? "meta"
          : l.startsWith("@@")
            ? "hunk"
            : l.startsWith("diff ")
              ? "file"
              : l.startsWith("+")
                ? "add"
                : l.startsWith("-")
                  ? "del"
                  : "";
      return `<span class="${c}">${esc(l)}</span>`;
    })
    .join("\n");
  return `<section class="panel diff-panel"><div class="section-heading"><div><p class="eyebrow">Patch</p><h2>${d.files.length} file${d.files.length === 1 ? "" : "s"} · <span class="add">+${d.additions}</span> <span class="del">−${d.deletions}</span></h2></div>${state.tab === "diff" ? "" : `<button class="secondary-button" data-tab="diff">Open diff →</button>`}</div><div class="file-chips">${d.files.map((f) => `<code>${esc(f.path)} <span class="add">+${f.additions}</span> <span class="del">−${f.deletions}</span></code>`).join("")}</div>${state.diffOpen || state.tab === "diff" ? `<pre class="diff-view">${lines}</pre>` : ""}</section>`;
}

function evidence(ep) {
  const p = ep.planner;
  const plannerCard = p
    ? `<article class="evidence-card panel"><div class="card-top"><div><p class="eyebrow">Planner output</p><h3>Confidence ${p.confidence?.toFixed(2) ?? "—"}${ep.state === "abstained" ? " · abstained" : ""}</h3></div>${badge(ep.state === "abstained" ? "rejected" : "passed")}</div><p class="diagnosis">${esc(p.diagnosis)}</p><div class="file-chips">${p.files.map((f) => `<code>${esc(f)}</code>`).join("")}</div><ol>${p.plan.map((i) => `<li>${esc(i)}</li>`).join("")}</ol>${p.concerns.length ? `<div class="soft-note">Concerns: ${esc(p.concerns.join(" · "))}</div>` : ""}</article>`
    : `<article class="evidence-card panel"><div class="card-top"><div><p class="eyebrow">Planner output</p><h3>${ep.agents[0].state === "skipped" ? "Planner not in this policy" : ep.agents[0].state === "running" ? "Investigating the repository" : "No plan"}</h3></div>${badge(ep.agents[0].state)}</div><p>${ep.agents[0].state === "skipped" ? "The coder starts directly from the issue text." : "The planner reads the repo read-only and publishes a diagnosis, target files, a plan and a calibrated confidence. Below the policy gate, the episode abstains before any coder sandbox is created."}</p></article>`;
  const r = ep.review;
  const rubric = r
    ? Object.entries(r.rubric)
    : [
        ["resolves_issue"],
        ["no_regressions"],
        ["minimal_change"],
        ["tests_untouched"],
      ];
  const reviewCard = `<article class="evidence-card panel"><div class="card-top"><div><p class="eyebrow">Review gate</p><h3>${r ? (r.verdict === "approve" ? "Approved" : "Rejected") : ep.agents[2].state === "skipped" ? "No reviewer in this policy" : "Waiting for final patch"}</h3></div>${badge(r ? (r.verdict === "approve" ? "passed" : "rejected") : ep.agents[2].state)}</div><p>The reviewer gets a fresh sandbox with only the coder's patch applied and the visible tests already run.</p><ul class="check-list">${rubric.map(([k, v]) => `<li><span class="${v === true ? "passed" : v === false ? "failed" : ""}">${v === true ? "✓" : v === false ? "✕" : "○"}</span>${title(k.replace(/_/g, " "))}</li>`).join("")}</ul>${r?.issues?.length ? `<div class="soft-note">${r.issues.map((i) => `• ${esc(i)}`).join("<br>")}</div>` : ""}</article>`;
  const ev = ep.evaluation;
  const evalCard = `<article class="evidence-card panel"><div class="card-top"><div><p class="eyebrow">Episode evaluation</p><h3>${ev.reward !== undefined ? `Reward ${ev.reward.toFixed(2)} · ${ev.success ? "success" : "not solved"}` : "Reward pending"}</h3></div>${badge(ev.reward !== undefined ? (ev.success ? "passed" : "rejected") : ep.agents[3].state)}</div><ul class="check-list">${ev.checks.map((c) => `<li><span class="${c.state}">${c.state === "passed" ? "✓" : c.state === "failed" ? "✕" : "○"}</span>${c.label}${c.note ? `<small title="${esc(c.note)}">${esc(c.note)}</small>` : ""}</li>`).join("")}</ul>${ev.breakdown.length ? `<div class="reward-breakdown">${ev.breakdown.map((b) => `<div class="${b.ok ? "ok" : "miss"}"><span>${esc(b.label)}</span><b>${b.value >= 0 ? "+" : ""}${b.value.toFixed(2)}</b></div>`).join("")}<div class="total"><span>Reward</span><b>${ev.reward.toFixed(2)}</b></div></div>` : `<div class="reward-note">Success is decided only by the hidden evaluation command. Green visible tests alone never count as solved.</div>`}</article>`;
  return `<section class="evidence-grid">${plannerCard}${reviewCard}${evalCard}</section>`;
}

function context(ep) {
  const sbs = Object.entries(ep.sandboxes ?? {});
  const live = new Set(
    (cache.sandboxes?.sandboxes ?? [])
      .filter((s) => s.state === "started")
      .map((s) => s.id),
  );
  return `<section class="run-context panel"><div class="section-heading"><div><p class="eyebrow">Run context</p><h2>Reproducible by design</h2></div></div><div class="context-item"><span>Repository</span><strong>${esc(ep.issue.repository)}</strong></div><div class="context-item"><span>Base commit</span><code>${esc(ep.issue.base_commit?.slice(0, 12))}</code></div><div class="context-item"><span>Policy</span><strong>${policyKey(ep.policy)} ${esc(ep.policy.label)}</strong></div><div class="context-item"><span>Model</span><strong>${ep.models ? esc([...new Set(Object.values(ep.models))].join(" / ")) : `<span class="muted">unrecorded</span>`}</strong></div>${sbs.length ? sbs.map(([phase, ids]) => ids.map((id, i) => `<div class="context-item"><span>${title(phase)} sandbox${ids.length > 1 ? ` #${i + 1}` : ""}</span><code title="${id}">${live.has(id) ? "● " : ""}${id.slice(0, 13)}</code></div>`).join("")).join("") : `<div class="context-item"><span>Sandboxes</span><strong>none yet</strong></div>`}<div class="context-item"><span>Episode</span><code title="${ep.id}">${esc(ep.id)}</code></div><div class="context-item"><span>Data source</span><strong>${ep.demo ? "Seeded replay" : "Live artifacts"}</strong></div></section>`;
}

function episodePicker() {
  const opts = cache.episodes
    .slice(0, 40)
    .map(
      (e) =>
        `<option value="${e.id}" ${e.id === cache.episode?.id ? "selected" : ""}>${e.state === "running" ? "● " : ""}${e.issue.number ? `#${e.issue.number} ` : ""}${esc(e.issue.title.slice(0, 40))} · ${e.policy.key} · ${stateLabel[e.state]}${e.reward !== undefined ? ` ${e.reward.toFixed(2)}` : ""}</option>`,
    )
    .join("");
  return `<div class="picker"><label>Episode</label><select data-episode-select>${opts}</select><button class="filter ${state.follow ? "selected" : ""}" data-follow title="Automatically switch to the newest running episode">${state.follow ? "Following live" : "Follow live"}</button></div>`;
}

// ---- trigger panel ---------------------------------------------------------
function triggerPanel() {
  const t = state.trigger;
  const policies = cache.config?.policies ?? [];
  const issueOpts = cache.issues
    .map(
      (i) =>
        `<option value="${i.ref}" ${i.ref === t.issue ? "selected" : ""}>#${i.number} · ${esc(i.title)}</option>`,
    )
    .join("");
  const running = visibleRuns().filter((r) => r.state === "running");
  return `<section class="panel trigger-panel"><div class="section-heading"><div><p class="eyebrow">Trigger</p><h2>Run the agent on ${esc(cache.config?.repo ?? "")} <small class="muted">· ${esc(cache.config?.model ?? "")}</small></h2></div>${running.length ? `<span class="sandbox live">${running.length} runner process${running.length > 1 ? "es" : ""} active</span>` : ""}</div>
  <div class="trigger-grid">
    <form class="trigger-form" data-form="issue"><p class="form-title">Single issue <small>live run — iterate on one issue</small></p>
      <label>Issue<select name="issue">${issueOpts || `<option value="">no open issues loaded</option>`}</select></label>
      <label>Policy<select name="policy">${policies.map((p) => `<option value="${p.key}" ${p.key === t.policy ? "selected" : ""}>${p.key} · ${esc(p.label)}</option>`).join("")}<option value="auto" ${t.policy === "auto" ? "selected" : ""}>auto · learned allocation (${cache.config?.rollouts ?? 2} rollouts)</option></select></label>
      <button class="primary-button" type="submit" ${state.busy ? "disabled" : ""}>Run episode <span>${icons.arrow}</span></button>
      <button class="secondary-button" type="button" data-demo ${state.busy ? "disabled" : ""} title="Replays a seeded episode that closes the full loop — no credits, no sandboxes">${icons.plan} Replay loop</button></form>
    <form class="trigger-form" data-form="experiment"><p class="form-title">Experiment <small>benchmark — every task × policy</small></p>
      <div class="check-row"><span>Policies</span>${policies.map((p) => `<label class="chip"><input type="checkbox" name="policies" value="${p.key}" ${t.policies.includes(p.key) ? "checked" : ""}>${policyKey(p)}${esc(p.label)}</label>`).join("")}</div>
      <div class="check-row"><span>Tasks</span>${cache.tasks.map((k) => `<label class="chip"><input type="checkbox" name="tasks" value="${k.task_id}" ${t.tasks.includes(k.task_id) ? "checked" : ""}>${k.issue.number ? `#${k.issue.number}` : k.task_id} ${esc(k.issue.title.slice(0, 28))}</label>`).join("")}</div>
      <div class="inline"><label>Concurrency<input type="number" name="concurrency" min="1" max="8" value="${t.concurrency}"></label><button class="primary-button" type="submit" ${state.busy ? "disabled" : ""}>Run experiment <span>${icons.arrow}</span></button></div></form>
  </div>
  ${
    visibleRuns().length
      ? `<div class="runs-list">${visibleRuns()
          .slice(0, 6)
          .map(
            (r) =>
              `<div class="run-row ${r.state}"><span class="badge badge-${r.state === "running" ? "running" : r.state === "done" ? "passed" : "error"}"><i></i>${stateLabel[r.state] ?? r.state}</span><strong>${r.kind === "issue" ? `${esc(r.issue)} · policy ${r.policy}` : r.kind === "demo" ? `replay · ${esc(r.issue ?? "")} · policy ${r.policy ?? "A"}` : `experiment · ${(r.policies ?? []).join(",")} × ${r.tasks === "all" || !Array.isArray(r.tasks) ? "all tasks" : `${r.tasks.length} tasks`}`}</strong><span class="muted">${ago(r.started_at)}</span>${r.episode_id ? `<button class="text-button" data-open-episode="${r.episode_id}">open →</button>` : ""}${r.experiment_id ? `<button class="text-button" data-open-experiment="${r.experiment_id}">results →</button>` : ""}${r.state === "running" ? `<button class="text-button danger" data-stop-run="${r.id}">stop</button>` : ""}</div>`,
          )
          .join("")}</div>`
      : ""
  }</section>`;
}

function sandboxPanel(compact = false) {
  const s = cache.sandboxes;
  if (!s) return "";
  const items = (s.sandboxes ?? [])
    .slice()
    .sort(
      (a, b) =>
        (a.state === "started" ? -1 : 1) - (b.state === "started" ? -1 : 1) ||
        (b.created_at ?? "").localeCompare(a.created_at ?? ""),
    );
  const shown = compact
    ? items.filter((x) => x.state === "started").slice(0, 6)
    : items;
  const rows = shown
    .map(
      (x) =>
        `<div class="sandbox-row ${x.state}"><span class="sb-dot"></span><code title="${x.id}">${x.id.slice(0, 13)}</code><span class="sb-state">${esc(x.state)}</span><span class="sb-labels">${x.labels.phase ? `<b class="log-phase ${esc(x.labels.phase)}">${esc(x.labels.phase)}</b>` : ""}${x.labels.task ? `<em>${esc(x.labels.task)}</em>` : ""}${x.labels.episode ? `<button class="text-button" data-open-episode="${esc(x.labels.episode)}">${esc(x.labels.episode.slice(-8))} →</button>` : x.labels.purpose ? `<em>${esc(x.labels.purpose)}</em>` : ""}</span><span class="muted">${x.cpu ? `${x.cpu} vCPU · ${x.memory} GB` : ""}</span><span class="muted">${ago(x.created_at)}</span></div>`,
    )
    .join("");
  return `<section class="panel sandbox-panel"><div class="section-heading"><div><p class="eyebrow">Daytona</p><h2>${s.available ? `${items.filter((x) => x.state === "started").length} sandbox${items.filter((x) => x.state === "started").length === 1 ? "" : "es"} running` : "Sandboxes unavailable"}</h2></div>${compact ? `<button class="text-button" data-view="sandboxes">All sandboxes →</button>` : `<span class="muted">${items.length} total · refreshed ${ago(s.updated_at)}</span>`}</div>${s.available ? rows || `<p class="empty">No ${compact ? "running " : ""}sandboxes. Trigger a run to boot one per agent phase.</p>` : `<p class="empty">${esc(s.reason)}</p>`}</section>`;
}

// ---- views ------------------------------------------------------------------
function episodeHeader(ep) {
  const status = `${ep.state === "running" ? `<span class="status-running"><i></i> ${title(ep.phase)}${ep.detail ? ` — ${esc(ep.detail)}` : ""}</span>` : `<span>${badge(ep.state)}</span>`}${ep.demo ? ` <span>${replayTag(ep)}</span>` : ""}`;
  const issueTitle = ep.issue.number
    ? `Issue #${ep.issue.number}: ${esc(ep.issue.title)}`
    : esc(ep.issue.title);
  const link = ep.issue.url
    ? `<a class="issue-link" href="${esc(ep.issue.url)}" target="_blank" rel="noreferrer">GitHub ${icons.external}</a>`
    : "";
  return header(
    `${esc(ep.issue.repository)} · ${esc(ep.task_id)} ${link}`,
    issueTitle,
    `${status} <span>Policy ${ep.policy.key} · ${esc(ep.policy.label)}</span> <span>Base ${esc(ep.issue.base_commit?.slice(0, 10))}</span> <span>Started ${ago(ep.started_at)}</span>`,
    `<div class="header-actions"><a class="secondary-button" href="#/episodes">← Episodes</a></div>`,
  );
}

function episodeTabs(ep) {
  const sbCount = Object.values(ep.sandboxes ?? {}).flat().length;
  const tabs = [
    ["overview", "Overview"],
    ["traces", `Traces · ${ep.trace.length}`],
    ["logs", `Logs · ${ep.logs.length}`],
    ["sandboxes", `Sandboxes · ${sbCount}`],
    [
      "diff",
      ep.diff.files.length ? `Diff · ${ep.diff.files.length} files` : "Diff",
    ],
  ];
  return `<nav class="tabs">${tabs.map(([k, l]) => `<a class="tab ${state.tab === k ? "is-active" : ""}" href="${hashFor({ ...state, view: "episode", tab: k })}">${l}</a>`).join("")}</nav>`;
}
function episodeSandboxes(ep) {
  const live = new Map(
    (cache.sandboxes?.sandboxes ?? []).map((s) => [s.id, s]),
  );
  const boxes = Object.entries(ep.sandboxes ?? {}).flatMap(([phase, ids]) =>
    ids.map((id, i) => {
      const s = live.get(id);
      const logs = ep.logs.filter((l) => l.message.includes(id));
      const booted = logs.find((l) => /booted/.test(l.message)),
        released = logs.find((l) => /released/.test(l.message));
      const active = s?.state === "started" || (ep.state === "running" && !released && !s);
      const st = s?.state ?? (released ? "released" : active ? "active" : "gone");
      return { id, phase, attempt: i, count: ids.length, s, st, booted, released, active };
    }),
  );
  if (!boxes.length)
    return `<section class="panel sandbox-panel"><div class="section-heading"><div><p class="eyebrow">Daytona</p><h2>Sandboxes used by this episode</h2></div><span class="muted">one machine per phase · handoff by plan JSON and git patch</span></div><p class="empty">No sandbox booted yet.</p></section>`;
  const selected = boxes.find((b) => b.id === state.terminal) ?? null;
  const rows = boxes
    .map(
      (b) =>
        `<button type="button" class="sandbox-row ${b.st} ${b === selected ? "is-selected" : ""}" data-terminal="${b.id}" title="${b === selected ? "Show whole episode" : "Isolate this sandbox in the terminal"}"><span class="sb-dot"></span><code title="${b.id}">${b.id.slice(0, 13)}</code><span class="sb-state">${b.st}</span><span class="sb-labels"><b class="log-phase ${b.phase}">${b.phase}</b>${b.count > 1 ? `<em>attempt ${b.attempt + 1}</em>` : ""}<em>${b.booted ? `booted ${b.booted.time}` : ""}${b.released ? ` · released ${b.released.time}` : ""}</em></span><span class="muted">${b.s?.cpu ? `${b.s.cpu} vCPU · ${b.s.memory} GB` : ""}</span><span class="muted">${(ep.terminals?.[b.id] ?? []).filter((r) => r.source !== "note").length} cmds</span></button>`,
    )
    .join("");
  return `<section class="panel sandbox-panel"><div class="section-heading"><div><p class="eyebrow">Daytona</p><h2>Sandboxes used by this episode</h2></div><span class="muted">one machine per phase · handoff by plan JSON and git patch</span></div><div class="sandbox-list">${rows}</div></section>${terminalPanel(ep, boxes, selected)}`;
}
function terminalPanel(ep, boxes, only) {
  const shown = only ? [only] : boxes;
  const rows = shown
    .flatMap((b) => (ep.terminals?.[b.id] ?? []).map((r) => ({ ...r, box: b })))
    .sort((x, y) => Date.parse(x.t) - Date.parse(y.t));
  let lastBox = null;
  const lines = rows
    .map((r, i) => {
      const sep = r.box !== lastBox ? `<div class="term-sep"><span class="log-phase ${r.box.phase}">${r.box.phase}</span><code>${r.box.id.slice(0, 13)}</code>${r.box.count > 1 ? `<em>attempt ${r.box.attempt + 1}</em>` : ""}</div>` : "";
      lastBox = r.box;
      if (r.source === "note")
        return `${sep}<div class="term-note ${r.level ?? ""}"><span class="term-time">${r.time}</span># ${esc(r.cmd)}</div>`;
      const failed = r.exit_code !== undefined && r.exit_code !== 0;
      const open = r.output && (failed || i >= rows.length - 3);
      return `${sep}<details class="term-cmd ${failed ? "failed" : ""}" data-key="t-${r.id}" ${open ? "open" : ""} ${r.output ? "" : "data-empty"}><summary><span class="term-time">${r.time}</span><span class="term-prompt ${r.source}">${r.source === "agent" ? `${r.box.phase} $` : "~ $"}</span><span class="term-cmdline">${esc(r.cmd)}</span>${r.meta ? `<span class="term-meta">${esc(r.meta)}</span>` : ""}${r.exit_code !== undefined ? `<span class="term-exit ${failed ? "failed" : "ok"}">${failed ? `exit ${r.exit_code}` : "✓"}</span>` : ""}${r.duration_ms ? `<span class="term-dur">${(r.duration_ms / 1000).toFixed(1)}s</span>` : ""}</summary>${r.output ? `<pre>${esc(r.output)}</pre>` : ""}</details>`;
    })
    .join("");
  const cmds = rows.filter((r) => r.source !== "note");
  const failed = cmds.filter((r) => r.exit_code !== undefined && r.exit_code !== 0).length;
  const live = shown.find((b) => b.active);
  const transcript = cmds.map((r) => `[${r.box.phase}] $ ${r.cmd}\n${r.output}`).join("\n\n");
  const status = live ? `live · ${live.phase} is driving ${live.id.slice(0, 13)}` : ep.state === "running" ? "waiting for the next sandbox…" : `${ep.state} · ${shown.length} machine${shown.length === 1 ? "" : "s"} · transcript`;
  return `<section class="panel terminal-panel"><div class="section-heading"><div><p class="eyebrow">Terminal · read-only</p><h2>${only ? `${esc(only.phase)} sandbox <code>${only.id.slice(0, 13)}</code>` : "Episode session"}</h2></div><span class="term-tools"><span class="muted">${cmds.length} commands · ${failed} failed</span>${only ? `<button class="filter" data-terminal="${only.id}" type="button">Show all</button>` : ""}<button class="filter ${state.termFollow ? "selected" : ""}" data-term-follow type="button">Follow</button><button class="icon-button" data-term-copy type="button" title="Copy transcript">${icons.copy} Copy</button></span></div><div class="terminal"><div class="term-head"><span>${icons.terminal}</span> ${status}</div><div class="term-body">${lines || `<div class="term-note">Waiting for the first command…</div>`}${live ? `<div class="term-cursor"><span class="term-prompt agent">${live.phase} $</span><i></i></div>` : ""}</div><textarea class="term-clip" aria-hidden="true" tabindex="-1">${esc(transcript)}</textarea></div></section>`;
}
function episodeView() {
  const ep = cache.episode;
  if (!ep)
    return `<main class="page">${header("Episode", "No episodes yet", "Trigger a run from Home to see the agent work an issue inside a Daytona sandbox.", `<a class="primary-button" href="#/">Go home <span>${icons.arrow}</span></a>`)}</main>`;
  const body =
    state.tab === "traces"
      ? tracePanel(ep)
      : state.tab === "logs"
        ? logsPanel(ep)
        : state.tab === "sandboxes"
          ? episodeSandboxes(ep)
          : state.tab === "diff"
            ? diffPanel(ep)
            : `${metrics(ep)}<div class="split-view">${tracePanel(ep, true)}${context(ep)}</div>${evidence(ep)}`;
  return `<main class="page episode-page">${episodeHeader(ep)}${ep.error ? `<div class="notice error">${esc(ep.error)}</div>` : ""}${pipeline(ep)}${episodeTabs(ep)}${body}</main>`;
}

function episodeRow(e, { showExperiment = false, compact = false } = {}) {
  const outcome =
    e.state === "running"
      ? `<span class="status-running"><i></i>${esc(e.phase)}${e.detail ? ` · ${esc(e.detail.slice(0, 40))}` : ""}</span>`
      : e.reward !== undefined
        ? `reward <b>${e.reward.toFixed(2)}</b>`
        : e.state === "abstained"
          ? `confidence ${e.confidence?.toFixed(2) ?? "—"}`
          : esc((e.detail ?? "").slice(0, 60));
  return `<div class="episode-row" data-open-episode="${e.id}">${badge(e.state)}<div class="ep-title"><strong>${e.issue.number ? `#${e.issue.number} ` : ""}${esc(e.issue.title)} ${replayTag(e)}</strong><small class="muted">${esc(e.id)}${showExperiment && e.experiment_id ? ` · ${esc(e.experiment_id)}` : ""}</small></div>${policyKey(e.policy)}<span class="ep-outcome muted">${outcome}</span><span class="muted">${e.events} actions</span><span class="muted">${fmtTokens(e.tokens)} tok</span><span class="muted">${fmtDuration(e.wall_ms)}</span><span class="muted">${ago(e.started_at)}</span><span class="ep-links">${compact ? "" : ["traces", "logs", "sandboxes", "diff"].map((t) => `<a class="text-button" href="#/episodes/${encodeURIComponent(e.id)}/${t}">${t}</a>`).join("")}</span></div>`;
}

function expRow(x) {
  const t = x.started_at
    ? new Date(x.started_at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
  return `<div class="episode-row exp-row" data-open-experiment="${x.id}">${badge(x.state === "running" ? "running" : "done")}<div class="ep-title"><strong>Policies ${x.policies.join(", ")} × ${x.tasks.length} task${x.tasks.length === 1 ? "" : "s"} · ${t} ${replayTag(x)}</strong><small class="muted">${esc(x.id)} · ${x.tasks.join(", ")}</small></div><span class="muted">${x.episodes} episodes</span><span class="muted">${ago(x.started_at)}</span><span class="ep-links"><a class="text-button" href="#/experiments/${encodeURIComponent(x.id)}/results">results</a><a class="text-button" href="#/experiments/${encodeURIComponent(x.id)}/episodes">episodes</a></span></div>`;
}
function homeView() {
  const running = visibleEpisodes().filter((e) => e.state === "running");
  const live = visibleEpisodes()
    .filter((e) => !e.experiment_id)
    .slice(0, 5);
  const exps = visibleExperiments().slice(0, 4);
  return `<main class="page runs-page">${header("Home", "Every decision leaves evidence.", `${running.length ? `<span class="status-running"><i></i>${running.length} episode${running.length === 1 ? "" : "s"} running</span>` : "<span>Idle</span>"} <span>${visibleEpisodes().length} episodes</span> <span>${visibleExperiments().length} experiments</span>`)}${notice()}${triggerPanel()}
  ${running.length ? `<section class="panel episodes-panel"><div class="section-heading"><div><p class="eyebrow">Running now</p><h2>Active episodes</h2></div></div><div class="episode-list">${running.map((e) => episodeRow(e, { showExperiment: true })).join("")}</div></section>` : ""}
  <div class="overview-grid"><section class="panel episodes-panel"><div class="section-heading"><div><p class="eyebrow">Live episodes</p><h2>Recent single-issue runs</h2></div><a class="text-button" href="#/episodes">All episodes →</a></div><div class="episode-list compact">${live.map((e) => episodeRow(e, { compact: true })).join("") || `<p class="empty">No live runs yet.</p>`}</div></section>
  <section class="panel episodes-panel"><div class="section-heading"><div><p class="eyebrow">Experiments</p><h2>Recent benchmarks</h2></div><a class="text-button" href="#/experiments">All experiments →</a></div><div class="episode-list">${exps.map(expRow).join("") || `<p class="empty">No experiments yet.</p>`}</div></section></div>
  ${sandboxPanel(true)}</main>`;
}
// ---- organisation overview (replay) ----------------------------------------
function overviewMetric(m) {
  return `<article class="overview-metric overview-metric-${esc(m.tone)}"><p>${esc(m.label)}</p><strong>${esc(m.value)}</strong><span>${esc(m.note)}</span></article>`;
}
function organisationPipeline(p) {
  const stages = p.stages
    .map(
      (st, i) =>
        `<article class="flow-stage flow-stage-${esc(st.key)}"><p class="flow-index">0${i + 1}</p><h3>${esc(st.label)}</h3><strong>${esc(st.value)}</strong><span>${esc(st.detail)}</span>${st.score ? `<div class="success-score"><b>${esc(st.score.value)}</b><em>${esc(st.score.label)}</em></div>` : ""}</article>${i < p.stages.length - 1 ? '<span class="flow-arrow" aria-hidden="true">→</span>' : ""}`,
    )
    .join("");
  const resolved = p.stages.find((st) => st.key === "resolved");
  return `<section class="organisation-pipeline panel"><div class="section-heading"><div><p class="eyebrow">Autonomous delivery pipeline</p><h2>From ticket intake to verified resolution</h2></div><div class="pipeline-utilities">${resolved?.score ? `<span class="pipeline-success">${esc(resolved.score.value)} ${esc(resolved.score.label)}</span>` : ""}<span class="badge badge-replay">Replay data</span></div></div><p class="section-context">${esc(p.period)}</p><div class="flow-track">${stages}</div></section>`;
}
function priorityQueue(tickets) {
  const row = (t) => {
    const body = `<div class="queue-ticket"><span class="queue-id">${esc(t.id)}</span><div><h3>${esc(t.title)}</h3><p>${esc(t.repository)}</p></div></div><span class="priority priority-${esc(t.priority.toLowerCase())}">${esc(t.priority)}</span><span class="queue-age">${esc(t.age)}</span><span class="queue-stage">${esc(t.stage)}</span>`;
    return t.episode_id
      ? `<a class="queue-row" href="#/episodes/${encodeURIComponent(t.episode_id)}/overview">${body}</a>`
      : `<article class="queue-row">${body}</article>`;
  };
  return `<section class="priority-queue panel"><div class="section-heading"><div><p class="eyebrow">Priority queue</p><h2>Work needing attention now</h2></div><span class="queue-count">${tickets.length} highlighted</span></div><div class="queue-list">${tickets.map(row).join("")}</div></section>`;
}
function learningCurve(curve) {
  if (curve.length < 2) return "";
  const w = 240, h = 48, n = curve.length;
  const x = (i) => (i / (n - 1)) * w, y = (r) => h - 4 - r * (h - 8);
  const pts = curve.map((c, i) => `${x(i).toFixed(1)},${y(c.reward).toFixed(1)}`).join(" ");
  const dots = curve.map((c, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(c.reward).toFixed(1)}" r="2.5" class="curve-${c.success ? "ok" : "fail"}"><title>${esc(c.policy)} · ${esc(c.task_id)} · ${c.reward.toFixed(2)}</title></circle>`).join("");
  return `<div class="learning-curve"><p>Reward per evaluated episode</p><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="learning curve"><polyline points="${pts}"/>${dots}</svg></div>`;
}
function learnedState(ls) {
  if (!ls) return "";
  const rows = ls.posterior.map((p) => `<span class="posterior-row ${ls.best === p.key ? "is-best" : ""}"><b>${esc(p.key)}</b><i style="width:${Math.round(p.mean * 100)}%"></i><em>${p.mean.toFixed(2)}${p.n ? ` · n=${p.n}` : ""}</em></span>`).join("");
  return `<div class="posterior"><p>Policy posterior <small>prior ${ls.prior.mean} × ${ls.prior.weight}</small></p>${rows}<small>Next auto run: ${esc(ls.next.policies.join(", "))} — ${esc(ls.next.reason)}</small></div>${learningCurve(ls.curve)}`;
}
function learningEvidence(l) {
  return `<section class="learning-evidence panel"><div class="section-heading"><div><p class="eyebrow">Reinforcement evidence</p><h2>Each outcome strengthens the next decision</h2></div><span class="learning-mark">↗</span></div><p class="section-context">${esc(l.period)}</p><div class="learning-metrics">${l.metrics.map((m) => `<article><p>${esc(m.label)}</p><strong>${esc(m.value)}</strong><span>${esc(m.note)}</span></article>`).join("")}</div><div class="policy-gain"><p>Measured policy gain</p><h3>${esc(l.policy.name)}</h3><div><strong>${esc(l.policy.success_gain)}</strong><span>success</span><strong>${esc(l.policy.reward_gain)}</strong><span>reward</span></div><small>${esc(l.policy.baseline)}</small></div>${learnedState(l.learned)}<p class="learning-note">${esc(l.note)}</p><a class="text-button" href="#/experiments/all/results">Inspect policy evidence →</a></section>`;
}
function overviewView() {
  const o = cache.overview;
  if (!o) return `<main class="page overview-page">${header("Overview", "Autonomous engineering capacity, visible.", "Loading replay…")}${notice()}</main>`;
  const action = `<div class="header-actions"><a class="primary-button" href="#/episodes/live/overview">Open active episode <span>${icons.arrow}</span></a></div>`;
  return `<main class="page overview-page">${header(`Organisation-wide operations · ${esc(o.snapshot_label)}`, "Autonomous engineering capacity, visible.", "A deterministic replay of an engineering organisation where every ticket, agent handoff, and evaluated outcome remains inspectable.", action)}${notice()}${organisationPipeline(o.pipeline)}<section class="backlog-health panel"><div class="section-heading"><div><p class="eyebrow">Backlog health</p><h2>Demand is high. The work is moving.</h2></div><span class="backlog-period">${esc(o.backlog.period)}</span></div><div class="overview-metrics">${o.backlog.metrics.map(overviewMetric).join("")}</div></section><section class="overview-lower">${priorityQueue(o.priority_queue)}${learningEvidence(o.learning)}</section></main>`;
}
function episodesView() {
  const base = visibleEpisodes();
  const all =
    state.episodesFilter === "all"
      ? base
      : base.filter((e) => !e.experiment_id);
  const filters =
    [
      ["live", "Live runs"],
      ["all", "All episodes"],
    ]
      .map(
        ([k, l]) =>
          `<button class="filter ${state.episodesFilter === k ? "selected" : ""}" data-episodes-filter="${k}">${l} (${k === "all" ? base.length : base.filter((e) => !e.experiment_id).length})</button>`,
      )
      .join("") + demoToggle();
  return `<main class="page">${header("Episodes", "Live episodes", "One episode = one issue × one policy, each phase on its own Daytona sandbox. Open a row for its overview, or jump to traces, logs, sandboxes or diff.", `<div class="filter-row">${filters}</div>`)}${notice()}<section class="panel episodes-panel"><div class="episode-list">${all.map((e) => episodeRow(e, { showExperiment: state.episodesFilter === "all" })).join("") || `<p class="empty">Nothing here yet — trigger a run from Home.</p>`}</div></section></main>`;
}
const demoToggle = () =>
  `<button class="filter ${state.showDemo ? "selected" : ""}" data-demo-toggle title="Seeded replay episodes are hidden by default">${state.showDemo ? "Hiding replays" : "Include replays"}</button>`;
function experimentsView() {
  return `<main class="page">${header("Experiments", "Benchmark runs", 'Each experiment runs every selected task × policy. Open one for the policy comparison, or <a href="#/experiments/all/results">compare every evaluated episode</a>.', `<div class="header-actions">${demoToggle()}<a class="primary-button" href="#/experiments/all/results${state.showDemo ? "" : ""}">Benchmark across all runs <span>${icons.arrow}</span></a></div>`)}${notice()}<section class="panel episodes-panel"><div class="episode-list">${visibleExperiments().map(expRow).join("") || `<p class="empty">No experiments yet — trigger one from Home.</p>`}</div></section></main>`;
}

function experimentView() {
  const x = cache.experiment;
  const picker = `<div class="picker"><label>Experiment</label><select data-experiment-select><option value="all" ${state.experimentId === "all" ? "selected" : ""}>All episodes (benchmark)</option>${visibleExperiments()
    .map(
      (e) =>
        `<option value="${e.id}" ${e.id === state.experimentId ? "selected" : ""}>${e.state === "running" ? "● " : ""}${esc(e.id)} · ${e.policies.join(",")} × ${e.tasks.length} tasks</option>`,
    )
    .join("")}</select></div>`;
  const xtabs = `<nav class="tabs">${[
    ["results", "Results"],
    ["episodes", `Episodes · ${x?.episodes?.length ?? 0}`],
  ]
    .map(
      ([k, l]) =>
        `<a class="tab ${state.xtab === k ? "is-active" : ""}" href="${hashFor({ ...state, view: "experiment", xtab: k })}">${l}</a>`,
    )
    .join("")}</nav>`;
  if (!x || !x.policies.length)
    return `<main class="page experiments-page">${header("Experiment", "No evaluated data yet", "Results appear here as episodes finish.", picker)}${notice()}</main>`;
  const best = x.policies.find((p) => p.key === x.best);
  const pts = x.points;
  const maxTok = Math.max(1, ...pts.map((p) => p.tokens));
  const points = pts
    .map(
      (p) =>
        `<button class="plot-point ${p.policy.toLowerCase()}" data-open-episode="${p.id}" style="left:${(p.tokens / maxTok) * 86 + 7}%;bottom:${p.reward * 78 + 10}%" title="${esc(p.task_id)} · policy ${p.policy}: reward ${p.reward.toFixed(2)}, ${fmtTokens(p.tokens)} tokens">${p.policy}</button>`,
    )
    .join("");
  const table = `<div class="table-scroll"><table><thead><tr><th>Policy</th><th>Episodes</th><th>Success</th><th>Reward</th><th>Median duration</th><th>Avg tokens</th><th>Coder steps</th><th>Reviewer approval</th></tr></thead><tbody>${x.policies.map((p) => `<tr class="${p.key === x.best ? "best-row" : ""}"><td>${policyKey(p)}<strong>${esc(p.label)}</strong>${p.key === x.best ? "<small>Best overall</small>" : ""}</td><td>${p.episodes}${p.running ? ` <span class="status-running"><i></i>${p.running}</span>` : ""}${p.abstained ? ` <span class="muted">· ${p.abstained} abstained</span>` : ""}${p.errors ? ` <span class="muted">· ${p.errors} errors</span>` : ""}</td><td><b>${p.evaluated ? `${p.successes}/${p.evaluated} (${Math.round(p.success_rate * 100)}%)` : "—"}</b></td><td><b>${p.reward !== null ? p.reward.toFixed(2) : "—"}</b></td><td>${p.evaluated ? fmtDuration(p.duration_ms) : "—"}</td><td>${p.tokens !== null ? fmtTokens(p.tokens) : "—"}</td><td>${p.steps !== null ? p.steps.toFixed(0) : "—"}</td><td>${p.reviewer_approval !== null ? `${Math.round(p.reviewer_approval * 100)}%` : "—"}</td></tr>`).join("")}</tbody></table></div>`;
  const cell = (cells) =>
    cells.length
      ? cells
          .map(
            (c) =>
              `<button class="cell ${c.state}" data-open-episode="${c.id}" title="${c.id}">${c.state === "running" ? "●" : c.reward !== undefined ? c.reward.toFixed(2) : c.state === "abstained" ? "abst" : "err"}</button>`,
          )
          .join("")
      : `<span class="cell empty">–</span>`;
  const matrix = `<div class="table-scroll"><table class="matrix"><thead><tr><th>Task</th>${x.policies.map((p) => `<th>${policyKey(p)}</th>`).join("")}</tr></thead><tbody>${x.tasks.map((t) => `<tr><td><strong>${t.issue?.number ? `#${t.issue.number} ` : ""}${esc(t.issue?.title ?? t.task_id)}</strong><small class="muted">${esc(t.task_id)}</small></td>${x.policies.map((p) => `<td>${cell(t.cells[p.key] ?? [])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  const callout = best
    ? `<div class="winner-callout"><span>Best overall</span><strong>Policy ${best.key}</strong><em>${Math.round(best.success_rate * 100)}% success · ${best.reward.toFixed(2)} reward</em></div>`
    : "";
  return `<main class="page experiments-page">${header(`${esc(x.id === "all" ? "Benchmark" : x.id)} · ${x.tasks.length} task${x.tasks.length === 1 ? "" : "s"} · ${x.episodes.length} episodes${x.state === "running" ? " · running" : ""}${x.hidden_infra ? ` · ${x.hidden_infra} infra failures hidden` : ""}`, "Compare policy trade-offs.", "Success (hidden oracle) decides the winner. Reward separates efficient successes from expensive ones.", `<div class="header-actions">${picker}${callout}</div>`)}${notice()}${xtabs}${state.xtab === "episodes" ? `<section class="panel episodes-panel"><div class="episode-list">${x.episodes.map((e) => episodeRow(e, { showExperiment: x.id === "all" })).join("")}</div></section></main>` : ""}${state.xtab === "episodes" ? "" : `<section class="experiment-summary"><article class="panel plot-panel"><div class="section-heading"><div><p class="eyebrow">Episode distribution</p><h2>Reward vs. token cost</h2></div><div class="legend">${x.policies.map((p) => `<span class="${p.key.toLowerCase()}">${p.key}</span>`).join("")}</div></div><div class="plot"><span class="axis-y">Reward →</span><span class="axis-x">Total tokens (max ${fmtTokens(maxTok)}) →</span><div class="grid-line h1"></div><div class="grid-line h2"></div><div class="grid-line v1"></div><div class="grid-line v2"></div>${points || `<p class="empty plot-empty">No evaluated episodes yet.</p>`}</div></article><article class="panel experiment-note"><p class="eyebrow">Task × policy</p><h2>Who solved what</h2>${matrix}</article></section><section class="panel results-table"><div class="section-heading"><div><p class="eyebrow">Experiment results</p><h2>Policy comparison</h2></div><span class="data-chip"><i></i> ${x.episodes.some((e) => e.demo) ? "Includes replay data" : "Live artifacts"}</span></div>${table}</section></section><p class="muted" style="margin-top:14px">Click a point or a matrix cell to open that episode; the <a href="${hashFor({ ...state, xtab: "episodes" })}">Episodes</a> tab lists them all.</p></main>`}`;
}

function sandboxesView() {
  return `<main class="page">${header("Daytona", "Sandboxes", "One isolated machine per agent phase. Labels show which episode and phase owns each sandbox; they auto-stop after 10 idle minutes and are deleted after 30.")}${sandboxPanel(false)}</main>`;
}

// ---- render & events ---------------------------------------------------------
function render() {
  const views = {
    home: homeView,
    overview: overviewView,
    episodes: episodesView,
    episode: episodeView,
    experiments: experimentsView,
    experiment: experimentView,
    sandboxes: sandboxesView,
  };
  const running = visibleEpisodes().filter((e) => e.state === "running").length;
  const liveSb = (cache.sandboxes?.sandboxes ?? []).filter(
    (s) => s.state === "started",
  ).length;
  const ae = document.activeElement;
  if (ae && ae.matches("select, input, textarea") && !force) {
    pendingRender = true;
    return;
  }
  pendingRender = false;
  const scroll = window.scrollY;
  const termEl = document.querySelector(".term-body");
  const termScroll = termEl ? termEl.scrollTop : null;
  const open = new Set(
    [...document.querySelectorAll("details[open]")].map((d) => d.dataset.key),
  );
  const seen = new Set(
    [...document.querySelectorAll("details[data-key]")].map((d) => d.dataset.key),
  );
  writeHash();
  const active = (k) =>
    state.view === k ||
    (k === "episodes" && state.view === "episode") ||
    (k === "experiments" && state.view === "experiment");
  const nav = (k, l, c) =>
    `<a class="nav-item ${active(k) ? "is-active" : ""}" href="#/${k === "home" ? "" : k}"><span>${icons[k]}</span>${l}${c ? `<em class="nav-count">${c}</em>` : ""}</a>`;
  app.innerHTML = `<div class="app-shell"><aside class="sidebar"><a class="brand" href="#/"><span>${icons.brand}</span><strong>Agent Atlas</strong></a><div class="workspace"><span class="workspace-dot ${running ? "" : "idle"}"></span><span>${esc(cache.config?.repo ?? "…")}</span></div><nav>${nav("home", "Home")}${nav("overview", "Overview")}${nav("episodes", "Episodes", running)}${nav("experiments", "Experiments")}<p class="nav-section">Infrastructure</p>${nav("sandboxes", "Sandboxes", liveSb)}</nav><div class="sidebar-footer"><span class="data-chip"><i></i> Live data</span><p>schema 1.1 · ${esc(cache.config?.model ?? "")}</p>${cache.error ? `<p class="danger">${esc(cache.error)}</p>` : ""}</div></aside><section class="content"><div class="topbar"><span>${crumbs()}</span><span class="topbar-right"><span class="muted">updated ${cache.updated_at ? ago(cache.updated_at) : "—"}</span><button class="icon-button" data-refresh>${icons.spin} Refresh</button><button class="icon-button" data-theme-toggle title="Toggle theme">${document.documentElement.dataset.theme === "dark" ? icons.sun : icons.moon}</button></span></div>${views[state.view]()}</section></div>`;
  window.scrollTo(0, scroll);
  document.querySelectorAll("details[data-key]").forEach((d) => {
    if (open.has(d.dataset.key)) d.open = true;
    else if (seen.has(d.dataset.key) && d.dataset.key.startsWith("t-")) d.open = false; // keep user-collapsed commands collapsed; new ones use their default
  });
  const term = document.querySelector(".term-body");
  if (term) {
    const to = () => (term.scrollTop = state.termFollow || termScroll === null ? term.scrollHeight : termScroll);
    to();
    requestAnimationFrame(to); // fonts/pre blocks can settle after first paint
  }
  bind();
}
let pendingRender = false;
document.addEventListener("focusout", () => {
  if (pendingRender)
    setTimeout(() => {
      if (!document.activeElement?.matches("select, input, textarea")) render();
    }, 50);
});
function crumbs() {
  const ep = cache.episode;
  const sep = ' <span class="muted">›</span> ';
  if (state.view === "episode" && ep)
    return `<a href="#/episodes">Episodes</a>${sep}<a href="${hashFor({ ...state, tab: "overview" })}">${ep.issue.number ? `#${ep.issue.number}` : esc(ep.task_id)} · ${ep.policy.key}</a>${sep}${title(state.tab)}`;
  if (state.view === "experiment")
    return `<a href="#/experiments">Experiments</a>${sep}${state.experimentId === "all" ? "All" : esc(state.experimentId)}${sep}${title(state.xtab)}`;
  return title(state.view);
}

function bind() {
  const on = (sel, ev, fn) =>
    document.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, fn));
  on("[data-view]", "click", (e) => go({ view: e.currentTarget.dataset.view }));
  on("[data-tab]", "click", (e) =>
    go({ view: "episode", tab: e.currentTarget.dataset.tab }),
  );
  on("[data-terminal]", "click", (e) => {
    const id = e.currentTarget.dataset.terminal;
    state.terminal = state.terminal === id ? null : id;
    render();
  });
  on("[data-term-follow]", "click", () => {
    state.termFollow = !state.termFollow;
    render();
  });
  on("[data-term-copy]", "click", async (e) => {
    const ta = document.querySelector(".term-clip");
    try { await navigator.clipboard.writeText(ta?.value ?? ""); } catch { ta?.select(); document.execCommand("copy"); }
    e.currentTarget.textContent = "Copied";
    setTimeout(() => render(), 1200);
  });
  on("[data-demo-toggle]", "click", () => {
    state.showDemo = !state.showDemo;
    refresh({ force: true });
  });
  on("[data-episodes-filter]", "click", (e) => {
    state.episodesFilter = e.currentTarget.dataset.episodesFilter;
    render();
  });
  on("[data-filter]", "click", (e) => {
    state.traceFilter = e.currentTarget.dataset.filter;
    render();
  });
  on("[data-logfilter]", "click", (e) => {
    state.logFilter = e.currentTarget.dataset.logfilter;
    render();
  });
  on("[data-event]", "click", (e) => {
    state.selectedEvent = e.currentTarget.dataset.event;
    render();
  });
  on("[data-toggle-diff]", "click", () => {
    state.diffOpen = !state.diffOpen;
    render();
  });
  on("[data-refresh]", "click", () => refresh({ force: true }));
  on("[data-theme-toggle]", "click", () => {
    theme.apply(
      document.documentElement.dataset.theme === "dark" ? "light" : "dark",
    );
    render();
  });
  on("[data-demo]", "click", async () => {
    state.busy = true;
    render();
    try {
      const { run } = await post("/api/runs/demo", { live: true });
      state.notice = {
        kind: "info",
        text: `Replaying demo episode ${run.episode_id} — plan → implement → fail → fix → review → oracle, ~90s.`,
      };
      state.episodeId = run.episode_id;
      state.follow = false;
      state.view = "episode";
      state.tab = "overview";
    } catch (err) {
      state.notice = { kind: "error", text: err.message };
    }
    state.busy = false;
    writeHash();
    refresh({ force: true });
  });
  on("[data-dismiss]", "click", () => {
    state.notice = null;
    render();
  });
  on("[data-follow]", "click", () =>
    go({
      follow: !state.follow,
      episodeId: state.follow ? state.episodeId : null,
    }),
  );
  on("[data-episode-select]", "change", (e) =>
    go({ episodeId: e.target.value, follow: false, selectedEvent: null }),
  );
  on("[data-experiment-select]", "change", (e) =>
    go({ experimentId: e.target.value }),
  );
  on("[data-open-episode]", "click", (e) => {
    if (e.target.closest("a")) return;
    e.stopPropagation();
    go({
      episodeId: e.currentTarget.dataset.openEpisode,
      follow: false,
      selectedEvent: null,
      view: "episode",
      tab: "overview",
    });
  });
  on("[data-open-tab]", "click", (e) => {
    e.stopPropagation();
    go({
      episodeId: e.currentTarget.dataset.id,
      follow: false,
      selectedEvent: null,
      view: "episode",
      tab: e.currentTarget.dataset.openTab,
    });
  });
  on("[data-open-experiment]", "click", (e) => {
    if (e.target.closest("a")) return;
    e.stopPropagation();
    go({
      experimentId: e.currentTarget.dataset.openExperiment,
      view: "experiment",
      xtab: "results",
    });
  });
  on("[data-stop-run]", "click", async (e) => {
    const id = e.currentTarget.dataset.stopRun;
    try {
      await post(`/api/runs/${id}/stop`, {});
      state.notice = {
        kind: "info",
        text: `Stopped ${id}. Sandboxes auto-stop after 10 idle minutes.`,
      };
    } catch (err) {
      state.notice = { kind: "error", text: err.message };
    }
    refresh();
  });
  on("form[data-form]", "submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    state.busy = true;
    render();
    try {
      if (form.dataset.form === "issue") {
        state.trigger.issue = fd.get("issue");
        state.trigger.policy = fd.get("policy");
        const { run } = await post("/api/runs/issue", {
          issue: state.trigger.issue,
          policy: state.trigger.policy,
        });
        state.notice = {
          kind: "info",
          text: `Started ${run.episode_id} (policy ${run.policy}). Booting the planner sandbox…`,
        };
        state.episodeId = run.episode_id;
        state.follow = false;
        state.view = "episode";
        state.tab = "overview";
      } else {
        state.trigger.policies = fd.getAll("policies");
        state.trigger.tasks = fd.getAll("tasks");
        state.trigger.concurrency = Number(fd.get("concurrency")) || 3;
        const { run } = await post("/api/runs/experiment", {
          policies: state.trigger.policies,
          tasks: state.trigger.tasks,
          concurrency: state.trigger.concurrency,
        });
        state.notice = {
          kind: "info",
          text: `Started experiment ${run.experiment_id}: ${run.policies.join(",")} × ${run.tasks === "all" ? "all tasks" : run.tasks.length + " tasks"}.`,
        };
        state.experimentId = run.experiment_id;
        state.view = "experiment";
        state.xtab = "episodes";
      }
    } catch (err) {
      state.notice = { kind: "error", text: err.message };
    }
    state.busy = false;
    writeHash();
    refresh();
  });
}

readHash();
window.addEventListener("hashchange", () => {
  readHash();
  refresh({ force: true });
});
refresh({ force: true });
(function poll() {
  const busy =
    cache.episodes.some((e) => e.state === "running") ||
    cache.runs.some((r) => r.state === "running");
  setTimeout(
    async () => {
      try {
        if (!document.hidden) await refresh();
      } catch (err) {
        console.error("[atlas] refresh failed", err);
      } finally {
        poll();
      }
    },
    busy ? 3000 : 10000,
  );
})();
