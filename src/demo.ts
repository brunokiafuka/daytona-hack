import "dotenv/config";

import { mkdirSync, rmSync, writeFileSync } from "node:fs";

import { evaluateEpisode } from "./eval.js";
import { POLICIES } from "./orchestrator.js";
import type { EpisodeResult } from "./orchestrator.js";
import { loadTask } from "./tasks.js";
import { Trajectory } from "./trajectory.js";
import type { AgentName, AgentUsage } from "./trajectory.js";

/**
 * Demo replay: one complete, deterministic episode that closes the loop
 * (plan → implement → test fails → fix → pass → review → hidden oracle → reward)
 * written through the same Trajectory/eval code as a real run, so the
 * dashboard shows exactly what a live episode looks like — without spending
 * model credits or sandboxes. Artifacts are tagged `demo: true` and the UI
 * labels them "Replay".
 *
 *   pnpm demo            seed instantly (one live-run episode + a 6-episode benchmark)
 *   pnpm demo --live     stream the live-run episode over ~90s so the UI updates as it happens
 */
const live = process.argv.includes("--live");
const speed = Number(process.env.DEMO_SPEED ?? 0.4); // 1 = compressed (~35s); 0.4 ≈ 90s demo pace
const sleep = (ms: number) => (live ? new Promise((r) => setTimeout(r, ms / speed)) : Promise.resolve());

const task = loadTask("scribl-15");
const POLICY = POLICIES.A!;
const SB = { planner: "demo-3f1a2c9e-planner-0000-000000000001", coder: "demo-8b7d4e21-coder-0000-000000000002", reviewer: "demo-c5e09a77-review-0000-000000000003" };

const PLAN = {
  diagnosis:
    "The frontend has no document export path. `EditorCore` (packages/frontend/src/components/EditorCore.tsx) renders a Monaco editor and a markdown preview but exposes only edit/split/preview/save actions, and `renderEditor` never propagates Monaco `onChange` back into `content`, so any export would use stale text. No PDF dependency exists in packages/frontend/package.json, so the lowest-risk implementation is a client-side print-to-PDF using the existing markdown preview plus print CSS.",
  files: ["packages/frontend/src/components/EditorCore.tsx", "packages/frontend/src/index.css"],
  plan: [
    "Wire Monaco `onChange` in EditorCore so `content` tracks the edited document.",
    "Add an `Export PDF` toolbar action that switches to preview mode and calls `window.print()`.",
    "Add `@media print` rules in index.css that hide the app chrome and show only the rendered document.",
    "Run `pnpm --filter @scribl/frontend typecheck` and the production build.",
  ],
  confidence: 0.82,
  concerns: ["The issue says 'eg. PDF'; a server-side export (DOCX, HTML) would need a design decision from maintainers."],
};

const DIFF = `diff --git a/packages/frontend/src/components/EditorCore.tsx b/packages/frontend/src/components/EditorCore.tsx
index 3f2c1a0..b91e7d4 100644
--- a/packages/frontend/src/components/EditorCore.tsx
+++ b/packages/frontend/src/components/EditorCore.tsx
@@ -3,7 +3,7 @@
 import { useState, useEffect, useRef } from "react";
 import Editor from "@monaco-editor/react";
 import ReactMarkdown from "react-markdown";
 import remarkGfm from "remark-gfm";
-import { Eye, Edit3, Split, Save } from "lucide-react";
+import { Eye, Edit3, Split, Save, Download } from "lucide-react";
 import { useCollaboration } from "../hooks/useCollaboration";
@@ -41,6 +41,14 @@ export default function EditorCore({ noteId, initialContent = "" }: EditorProps) {
   const [mode, setMode] = useState<"edit" | "split" | "preview">("split");
   const [content, setContent] = useState(initialContent);
 
+  const handleExportPdf = () => {
+    // Print-to-PDF: the print stylesheet hides everything but the rendered document.
+    setMode("preview");
+    requestAnimationFrame(() => window.print());
+  };
+
@@ -88,6 +96,7 @@ export default function EditorCore({ noteId, initialContent = "" }: EditorProps) {
       language="markdown"
       value={content}
       theme="vs-dark"
+      onChange={(value) => setContent(value ?? "")}
       onMount={handleEditorDidMount}
       options={{ minimap: { enabled: false }, wordWrap: "on", fontSize: 14 }}
@@ -121,6 +130,10 @@ export default function EditorCore({ noteId, initialContent = "" }: EditorProps) {
         <button className="toolbar-btn" onClick={handleSave} title="Save">
           <Save size={16} />
         </button>
+        <button className="toolbar-btn" onClick={handleExportPdf} title="Export as PDF">
+          <Download size={16} />
+          <span>Export PDF</span>
+        </button>
       </div>
       <div className="editor-body" data-mode={mode}>
diff --git a/packages/frontend/src/index.css b/packages/frontend/src/index.css
index 7a1f0c2..d40e9b8 100644
--- a/packages/frontend/src/index.css
+++ b/packages/frontend/src/index.css
@@ -212,3 +212,19 @@
 .toolbar-btn:hover {
   background: var(--surface-2);
 }
+
+/* Export PDF: print only the rendered document */
+@media print {
+  .app-sidebar,
+  .app-topbar,
+  .editor-toolbar,
+  .editor-pane {
+    display: none !important;
+  }
+  .preview-pane {
+    display: block !important;
+    width: 100%;
+    max-width: 720px;
+    margin: 0 auto;
+    color: #000;
+  }
+}
`;

const TYPECHECK_FAIL = `> @scribl/frontend@0.0.0 typecheck /home/daytona/repo/packages/frontend
> react-router typegen && tsc

src/components/EditorCore.tsx:99:18 - error TS2322: Type '(value: string) => void' is not assignable to type 'OnChange | undefined'.
  Types of parameters 'value' and 'value' are incompatible.
    Type 'string | undefined' is not assignable to type 'string'.

99       onChange={(value: string) => setContent(value)}
                    ~~~~~~~~

Found 1 error in src/components/EditorCore.tsx:99
 ELIFECYCLE  Command failed with exit code 2.`;
const TYPECHECK_OK = `> @scribl/frontend@0.0.0 typecheck /home/daytona/repo/packages/frontend
> react-router typegen && tsc
`;
const BUILD_OK = `> @scribl/frontend@0.0.0 build /home/daytona/repo/packages/frontend
> react-router build

vite v7.1.2 building client environment for production...
✓ 1842 modules transformed.
build/client/assets/root-CkL2q9zX.css        41.20 kB │ gzip:  8.11 kB
build/client/assets/entry.client-Bx3pTmQ1.js 214.63 kB │ gzip: 68.90 kB
✓ built in 3.41s
SPA Mode: Generated build/client/index.html`;

const usage = (i: number, o: number, turns: number): AgentUsage => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: Math.round(i * 0.6), turns });

async function runDemoEpisode(episodeId: string, experimentId?: string): Promise<EpisodeResult> {
  const t = new Trajectory(episodeId);
  const started = Date.now();
  const { evaluation_command: _h, ...visible } = task;
  t.artifact("task", visible);
  t.status({ task_id: task.task_id, policy: POLICY.name, phase: "init", experiment_id: experimentId, models: { planner: "gpt-5.4-mini", coder: "gpt-5.4-mini", reviewer: "gpt-5.4-mini" }, demo: true } as never);
  const usages: AgentUsage[] = [];
  const sandboxes: EpisodeResult["sandboxes"] = {};

  async function boot(phase: AgentName) {
    t.status({ phase, detail: "boot sandbox" }); t.log(phase, "boot sandbox"); await sleep(600);
    (sandboxes[phase] ??= []).push(SB[phase]);
    t.log(phase, `sandbox ${SB[phase]} booted`, { duration_ms: 1184 });
    t.status({ sandboxes, detail: `sandbox ${SB[phase].slice(0, 8)} · clone ${task.repository}@${task.base_commit.slice(0, 10)}` }); await sleep(700);
    t.log(phase, `cloned ${task.repository}@${task.base_commit}`, { duration_ms: 2171 });
    t.status({ detail: `sandbox ${SB[phase].slice(0, 8)} · setup` }); await sleep(1200);
    t.log(phase, `setup: ${task.setup_command}`, { output: "Scope: all 3 workspace projects\nLockfile is up to date, resolution step is skipped\nPackages: +612\n\nDone in 14.8s using pnpm v10.11.1", exit_code: 0, duration_ms: 14931 });
  }
  async function act(agent: AgentName, tool: string, input: Record<string, unknown>, output: string, exit_code: number | undefined, ms: number) {
    await sleep(Math.min(ms, 2500));
    t.record(agent, { action: { tool, input }, observation: exit_code === undefined ? { output } : { exit_code, output }, timestamp: new Date().toISOString(), duration_ms: ms });
  }
  const release = (phase: AgentName) => t.log(phase, `sandbox ${SB[phase]} released`);

  // ---- planner
  await boot("planner");
  t.status({ phase: "planner", detail: "investigating" }); t.log("planner", "investigating");
  await act("planner", "bash", { command: "find . -path ./node_modules -prune -o -type f -name '*.ts*' -print | head -80" }, "./packages/frontend/src/app/root.tsx\n./packages/frontend/src/app/routes.ts\n./packages/frontend/src/app/dashboard/layout.tsx\n./packages/frontend/src/components/EditorCore.tsx\n./packages/frontend/src/components/Sidebar.tsx\n./packages/frontend/src/hooks/useCollaboration.ts\n./packages/frontend/vite.config.ts", 0, 210);
  await act("planner", "read_file", { path: "packages/frontend/package.json" }, '{\n  "name": "@scribl/frontend",\n  "scripts": { "build": "react-router build", "typecheck": "react-router typegen && tsc" },\n  "dependencies": { "@monaco-editor/react": "^4.7.0", "react-markdown": "^10.1.0", "lucide-react": "^0.543.0", ... }\n}', undefined, 60);
  await act("planner", "read_file", { path: "packages/frontend/src/components/EditorCore.tsx" }, '"use client";\n\nimport { useState, useEffect, useRef } from "react";\nimport Editor from "@monaco-editor/react";\nimport ReactMarkdown from "react-markdown";\n…\n  const [mode, setMode] = useState<"edit" | "split" | "preview">("split");\n  const [content, setContent] = useState(initialContent);\n…\n      <Editor height="100%" language="markdown" value={content} theme="vs-dark" onMount={handleEditorDidMount} />\n…\n        <button className="toolbar-btn" onClick={handleSave} title="Save"><Save size={16} /></button>', undefined, 80);
  await act("planner", "bash", { command: "grep -rn \"print\\|pdf\\|export\" packages/frontend/src --include=*.tsx --include=*.css | head" }, "", 1, 90);
  await act("planner", "bash", { command: "sed -n '180,230p' packages/frontend/src/index.css" }, ".editor-toolbar { display:flex; gap:8px; }\n.toolbar-btn { padding:6px 8px; border-radius:6px; }\n.toolbar-btn:hover { background: var(--surface-2); }", 0, 40);
  usages.push(usage(41_230, 1_960, 6)); t.status({ usage: usages });
  t.artifact("plan", { plan: PLAN, stopped_by: "end_turn", usage: usages[0] });
  release("planner");
  t.status({ phase: "planner", detail: `confidence ${PLAN.confidence.toFixed(2)} (gate ${POLICY.minConfidence})` }); t.log("planner", `confidence ${PLAN.confidence.toFixed(2)} (gate ${POLICY.minConfidence})`);
  await sleep(800);

  // ---- coder: implement → typecheck fails → fix → passes
  await boot("coder");
  t.status({ phase: "coder", detail: "implementing", attempt: 0 }); t.log("coder", "implementing");
  await act("coder", "read_file", { path: "packages/frontend/src/components/EditorCore.tsx" }, '"use client";\n…(142 lines)…', undefined, 70);
  await act("coder", "write_file", { path: "packages/frontend/src/components/EditorCore.tsx", content: '"use client";\n// … full file with Download import, handleExportPdf, onChange={(value: string) => setContent(value)} and the Export PDF button …' }, "wrote 4,812 bytes", 0, 55);
  await act("coder", "write_file", { path: "packages/frontend/src/index.css", content: "/* … existing … */\n@media print { .app-sidebar, .app-topbar, .editor-toolbar, .editor-pane { display:none !important; } .preview-pane { display:block !important; width:100%; max-width:720px; margin:0 auto; color:#000; } }" }, "wrote 6,244 bytes", 0, 48);
  await act("coder", "bash", { command: task.test_command }, TYPECHECK_FAIL, 2, 21_400);
  await act("coder", "bash", { command: "sed -n '95,102p' packages/frontend/src/components/EditorCore.tsx" }, '      language="markdown"\n      value={content}\n      theme="vs-dark"\n      onChange={(value: string) => setContent(value)}\n      onMount={handleEditorDidMount}', 0, 40);
  await act("coder", "write_file", { path: "packages/frontend/src/components/EditorCore.tsx", content: '"use client";\n// … same file; onChange={(value) => setContent(value ?? "")} …' }, "wrote 4,818 bytes", 0, 52);
  await act("coder", "bash", { command: task.test_command }, TYPECHECK_OK, 0, 19_800);
  await act("coder", "bash", { command: "pnpm --filter @scribl/frontend build 2>&1 | tail -8" }, BUILD_OK, 0, 33_100);
  await act("coder", "bash", { command: "git status --short && git diff --stat" }, " M packages/frontend/src/components/EditorCore.tsx\n M packages/frontend/src/index.css\n 2 files changed, 30 insertions(+), 1 deletion(-)", 0, 60);
  usages.push(usage(58_910, 4_120, 10)); t.status({ usage: usages });
  t.artifact("diff", { diff: DIFF, attempt: 0 }); t.log("coder", `patch captured (${DIFF.length} bytes, stopped by end_turn)`);

  // ---- reviewer on a fresh sandbox with the patch applied
  await boot("reviewer");
  t.status({ detail: "running visible tests on patched sandbox" }); await sleep(1500);
  t.log("reviewer", `tests: ${task.test_command}`, { output: TYPECHECK_OK, exit_code: 0, duration_ms: 20_112 });
  t.status({ phase: "reviewer", detail: "reviewing patch" }); t.log("reviewer", "reviewing patch");
  await act("reviewer", "bash", { command: "git diff --stat" }, " packages/frontend/src/components/EditorCore.tsx | 12 ++++++++++-\n packages/frontend/src/index.css                | 16 ++++++++++++++\n 2 files changed, 27 insertions(+), 1 deletion(-)", 0, 50);
  await act("reviewer", "read_file", { path: "packages/frontend/src/components/EditorCore.tsx" }, '"use client";\n…(151 lines)…', undefined, 60);
  await act("reviewer", "bash", { command: "grep -rn 'window.print' packages/frontend/src" }, "packages/frontend/src/components/EditorCore.tsx:48:    requestAnimationFrame(() => window.print());", 0, 45);
  const review = { verdict: "approve" as const, issues: ["Print-to-PDF depends on the browser dialog; a follow-up could add a server-side export for headless use."], rubric: { resolves_issue: true, no_regressions: true, minimal_change: true, tests_untouched: true } };
  usages.push(usage(22_480, 910, 4)); t.status({ usage: usages });
  t.artifact("review", { review, stopped_by: "end_turn", usage: usages[2] });
  release("reviewer");
  t.status({ phase: "reviewer", detail: "approve" }); t.log("reviewer", "approve");
  await sleep(800);

  // ---- freeze the coder sandbox and measure it
  t.status({ phase: "eval", detail: "visible tests" }); t.log("eval", "visible tests"); await sleep(1500);
  t.log("eval", `tests: ${task.test_command}`, { output: TYPECHECK_OK, exit_code: 0, duration_ms: 19_640 });
  t.status({ phase: "eval", detail: "hidden evaluation" }); t.log("eval", "hidden evaluation"); await sleep(2000);
  t.log("eval", "hidden evaluation", { output: `${TYPECHECK_OK}\n${BUILD_OK}`, exit_code: 0, duration_ms: 52_300 });
  t.log("eval", "changed files: git status --porcelain", { output: " M packages/frontend/src/components/EditorCore.tsx\n M packages/frontend/src/index.css", exit_code: 0, duration_ms: 40 });
  release("coder");
  const wallMs = live ? Date.now() - started : 6 * 60_000 + 12_000;
  const ev = evaluateEpisode({ task, testsPass: true, hiddenPass: true, testsUntouched: true, diff: DIFF, review, plan: PLAN, coderSteps: t.stepsFor("coder"), coderTestRuns: 2, usage: usages, wallMs });
  t.artifact("eval", ev);
  t.status({ phase: "eval", detail: `success reward ${ev.reward.toFixed(2)}` }); t.log("eval", `success reward ${ev.reward.toFixed(2)}`);
  const finishedAt = new Date().toISOString();
  const result: EpisodeResult = { episode_id: episodeId, task_id: task.task_id, policy: POLICY.name, status: "done", sandboxes, eval: ev, diff: DIFF, review, plan: PLAN, started_at: new Date(started).toISOString(), finished_at: finishedAt, wall_ms: wallMs, usage: usages, experiment_id: experimentId };
  t.artifact("result", result);
  t.status({ state: "done", phase: "finished", finished_at: finishedAt, usage: usages });
  return result;
}

/** A small mocked benchmark so the Experiments page has a comparison to show. */
function seedBenchmark(): void {
  const experimentId = "demo-benchmark";
  const rows: Array<{ task: string; policy: keyof typeof POLICIES; status: "done" | "abstained"; hidden: boolean; tests: boolean; steps: number; iters: number; tokens: number; review?: "approve" | "reject"; confidence: number; wall: number }> = [
    { task: "scribl-15", policy: "A", status: "done", hidden: true, tests: true, steps: 10, iters: 2, tokens: 128_000, review: "approve", confidence: 0.82, wall: 372_000 },
    { task: "scribl-15", policy: "B", status: "done", hidden: true, tests: true, steps: 14, iters: 3, tokens: 101_000, confidence: 0.79, wall: 298_000 },
    { task: "scribl-15", policy: "C", status: "done", hidden: false, tests: true, steps: 27, iters: 6, tokens: 176_000, review: "reject", confidence: 0, wall: 611_000 },
    { task: "scribl-5", policy: "A", status: "done", hidden: true, tests: true, steps: 18, iters: 3, tokens: 154_000, review: "approve", confidence: 0.71, wall: 455_000 },
    { task: "scribl-5", policy: "B", status: "done", hidden: false, tests: false, steps: 23, iters: 5, tokens: 149_000, confidence: 0.66, wall: 520_000 },
    { task: "scribl-5", policy: "C", status: "done", hidden: true, tests: true, steps: 31, iters: 7, tokens: 219_000, review: "approve", confidence: 0, wall: 702_000 },
    { task: "scribl-16", policy: "A", status: "abstained", hidden: false, tests: false, steps: 0, iters: 0, tokens: 38_000, confidence: 0.31, wall: 96_000 },
    { task: "scribl-16", policy: "B", status: "abstained", hidden: false, tests: false, steps: 0, iters: 0, tokens: 35_000, confidence: 0.28, wall: 91_000 },
    { task: "scribl-16", policy: "C", status: "done", hidden: false, tests: true, steps: 40, iters: 9, tokens: 268_000, review: "reject", confidence: 0, wall: 840_000 },
  ];
  const results: EpisodeResult[] = [];
  rows.forEach((r, i) => {
    const pol = POLICIES[r.policy]!;
    const tk = loadTask(r.task);
    const id = `${r.task}-${pol.name}-demo${String(i).padStart(3, "0")}`;
    const t = new Trajectory(id);
    const { evaluation_command: _h, ...visible } = tk;
    t.artifact("task", visible);
    const startedAt = new Date(Date.now() - (rows.length - i) * 7 * 60_000 - r.wall).toISOString();
    const finishedAt = new Date(Date.parse(startedAt) + r.wall).toISOString();
    const u = [usage(r.tokens * 0.94, r.tokens * 0.06, Math.max(1, r.steps))];
    t.status({ task_id: r.task, policy: pol.name, phase: "init", experiment_id: experimentId, started_at: startedAt, models: { planner: "gpt-5.4-mini", coder: "gpt-5.4-mini", reviewer: "gpt-5.4-mini" }, demo: true } as never);
    const plan = pol.planner ? { ...PLAN, confidence: r.confidence, diagnosis: r.status === "abstained" ? "The issue is underspecified: it does not say whether upvotes are per user, per workspace, or anonymous, and there is no data model for votes. Implementing it would require product decisions." : PLAN.diagnosis, concerns: r.status === "abstained" ? ["Needs a decision on vote identity and persistence (Supabase table? Yjs-shared?)", "No acceptance criteria in the issue"] : PLAN.concerns } : undefined;
    if (plan) t.artifact("plan", { plan, stopped_by: "end_turn", usage: u[0] });
    for (let s = 0; s < Math.min(r.steps, 4); s++) t.record("coder", { action: { tool: "bash", input: { command: s % 2 ? tk.test_command : "grep -rn 'EditorCore' packages/frontend/src | head" } }, observation: { exit_code: 0, output: s % 2 ? TYPECHECK_OK : "packages/frontend/src/components/EditorCore.tsx" }, timestamp: startedAt, duration_ms: 1200 });
    t.log("planner", `demo benchmark episode (${r.status})`);
    const sandboxes: EpisodeResult["sandboxes"] = pol.planner ? { planner: [`demo-${i}-planner`] } : {};
    if (r.status === "abstained") {
      const res: EpisodeResult = { episode_id: id, task_id: r.task, policy: pol.name, status: "abstained", sandboxes, plan, started_at: startedAt, finished_at: finishedAt, wall_ms: r.wall, usage: u, experiment_id: experimentId };
      t.artifact("result", res); t.status({ state: "abstained", phase: "finished", finished_at: finishedAt, sandboxes, usage: u }); results.push(res); return;
    }
    sandboxes.coder = [`demo-${i}-coder`]; if (pol.reviewer) sandboxes.reviewer = [`demo-${i}-reviewer`];
    const review = r.review ? { verdict: r.review, issues: r.review === "reject" ? ["Patch edits the preview component but leaves the editor state stale; export uses initial content."] : [], rubric: { resolves_issue: r.review === "approve", no_regressions: r.tests, minimal_change: r.steps < 30, tests_untouched: true } } : undefined;
    if (review) t.artifact("review", { review, stopped_by: "end_turn", usage: u[0] });
    const diff = r.hidden ? DIFF : DIFF.split("diff --git a/packages/frontend/src/index.css")[0]!;
    t.artifact("diff", { diff, attempt: 0 });
    const ev = evaluateEpisode({ task: tk, testsPass: r.tests, hiddenPass: r.hidden, testsUntouched: true, diff, review, plan, coderSteps: r.steps, coderTestRuns: r.iters, usage: u, wallMs: r.wall });
    t.artifact("eval", ev);
    const res: EpisodeResult = { episode_id: id, task_id: r.task, policy: pol.name, status: "done", sandboxes, eval: ev, diff, review, plan, started_at: startedAt, finished_at: finishedAt, wall_ms: r.wall, usage: u, experiment_id: experimentId };
    t.artifact("result", res); t.status({ state: "done", phase: "finished", finished_at: finishedAt, sandboxes, usage: u }); results.push(res);
  });
  mkdirSync(".data/experiments", { recursive: true });
  writeFileSync(`.data/experiments/${experimentId}.json`, JSON.stringify(results, null, 2));
  console.log(`seeded benchmark ${experimentId}: ${results.length} episodes`);
}

const episodeId = process.env.EPISODE_ID ?? `scribl-15-planner+coder+reviewer-demo${live ? "live" : "seed"}`;
// A replay always re-plays the same episode id: wipe it so the UI starts from an empty trajectory.
rmSync(`.data/episodes/${episodeId}`, { recursive: true, force: true });
if (!live) seedBenchmark();
const r = await runDemoEpisode(episodeId);
console.log(`${r.episode_id}: ✓ reward=${r.eval!.reward.toFixed(2)} hidden=${r.eval!.hard.hidden_eval_pass} tests=${r.eval!.hard.tests_pass} reviewer=${r.eval!.soft.reviewer_approved} steps=${r.eval!.soft.coder_steps}`);
