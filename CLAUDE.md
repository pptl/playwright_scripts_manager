# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**FlowTest** is an Electron desktop app that records user interactions as a visual branching flow graph, then generates Playwright `.spec.ts` test suites. The core innovation is "branch recording": silently replay to any previously-recorded node, then continue recording from that exact browser state — turning a 30-step flow into 5 new steps when testing a different path.

Beyond recording, the app is a full visual flow editor: drag-to-reposition, drag-to-connect/disconnect nodes, multi-select, undo/redo, collapsible visual groups, sub-flow extraction/embedding, environment profiles, and project-level environment overrides.

## Commands

```bash
npm run dev       # Start Electron app with hot-reload (electron-vite dev)
npm run build     # electron-vite build (main + preload + renderer)
npm run preview   # Preview production build
npm run dist      # Build + create platform installers (electron-builder)
```

No lint or test scripts are defined. TypeScript checking happens via the compiler during dev. Generated specs run under `npx playwright test` (config in `playwright.config.ts`: `testDir: './exports'`, headless: false).

## Architecture

This is an **Electron multi-process app** with three distinct bundles (built by `electron-vite`):

```
Main Process (Node.js)         Preload Bridge         Renderer (React)
──────────────────────         ──────────────         ────────────────
ipcHandlers.ts                 preload/index.ts       App.tsx
  ├── BrowserController          contextBridge          Zustand store (flowStore.ts)
  ├── Recorder                   window.electronAPI     React Flow canvas
  ├── Replayer                                          Hooks (usePlaywright, usePlaywrightEvents,
  ├── CodegenCapture                                          useUndoRedo, useFlowStore, useRecording)
  ├── FlowStorage                                       Canvas utils (treeLayout, groups, subflowExtraction)
  ├── ProjectStorage
  └── ScriptExporter
```

`src/main/index.ts` is the Electron entry point: creates the BrowserWindow (1280×800, contextIsolation on, nodeIntegration off) and calls `registerIpcHandlers(win)`.

### IPC as the central seam

`src/main/ipc/ipcHandlers.ts` is the **only file** that coordinates Main process modules. All Renderer ↔ Main communication goes through `IPC_CHANNELS` constants defined in `src/shared/types.ts`. The preload bridge (`src/preload/index.ts`) exposes `window.electronAPI` with typed wrappers for every channel.

Renderer → Main: `window.electronAPI.<method>()` → `ipcMain.handle(channel, ...)`
Main → Renderer: `win.webContents.send(channel, payload)` → `usePlaywrightEvents` / `Toolbar` hooks

Singletons `browserController`, `recorder`, `replayer` are module-level in `ipcHandlers.ts`. Recording **always relaunches the browser** (Playwright's `_enableRecorder` can only be called once per context).

### Key data types (`src/shared/types.ts`)

- **`ActionType`** — 13 variants: `goto | click | fill | selectOption | check | uncheck | press | upload | wait | assertVisible | assertText | assertValue | callFlow`
- **`Action`** — one browser interaction: `type`, `locatorExpr` (high-quality Playwright locator), `selector` (CSS fallback), `value`, `captureAs` (optional session variable name), `description`, `url`, `isPageNavigation`, optional `assertion`. For `callFlow` actions: `subFlowId`, `subFlowExitNodeId`, `subFlowProfileMapping?: Record<parentProfileId, subFlowProfileId | null>`, legacy `subFlowProfileId` / `subFlowProfileName` (for single-parent badge display). `isCallFlowAction(action)` is a type guard.
- **`Assertion`** — `type` (`text|visible|url|count`), optional `target` selector, `expected` value
- **`FlowNode`** — `Action` + canvas `position` + `parentId` + `childIds[]` + optional `branchLabel` + optional `groupId` (membership in a visual group)
- **`FlowGroup`** — `{ id, name, collapsed }` — an in-place collapsible group of contiguous nodes (single entry, single exit). **Pure canvas-display construct** — never creates a separate Flow, never enters the flow list. Membership recorded via `FlowNode.groupId`.
- **`ProfileVariable`** — `{ key, value, description?, envValues?: Record<envId, string> }`. `value` is the fallback; `envValues[activeEnvId] ?? value` is the per-environment resolution.
- **`FlowProfile`** — `{ id, name, vars: ProfileVariable[] }` — a named environment configuration
- **`ProjectEnvironment`** — `{ id, name }`
- **`Project`** — `{ id, name, environments: ProjectEnvironment[], createdAt, updatedAt }` — stored separately under `projects/`
- **`Flow`** — `nodes: FlowNode[]`, `rootNodeId`, `baseURL`, `profiles?: FlowProfile[]`, `groups?: FlowGroup[]`, `projectId?` (project membership), `positionsFinalized?` (true once layout is materialized / first manual drag), metadata. `domains?: string[]` is deprecated (migrated to profiles on load)
- **`FlowListItem`** — lightweight summary from `FLOW_LIST` with `refCount` (how many callFlow nodes across all other flows reference this flow as a sub-flow; >0 = it's a reusable sub-flow, 0 = top-level test case) and `projectId`
- **`ReplaySpeed`** — `'fast' | 'normal' | 'slow'` mapped to 100 / 500 / 1000 ms (`REPLAY_SPEED_MS`)
- **`RecordingStartPayload`** — `baseURL`, optional branch-recording fields (`branchFromNodeId`, `branchNodes`, `replaySpeed`), `profileVars?`, `activeProfileId?`, `activeEnvironmentId?`
- **`ExportConfig`** — `outputDir`, `helperFunctions`, `useTestStep`, `profileVars?` (active profile's flat key-value map), `activeProfileId?`, `activeEnvironmentId?`
- **`ReplayToNodePayload`** — `nodes`, `targetNodeId`, `speed`, `baseURL?`, `profileVars?`, `activeProfileId?`, `activeEnvironmentId?`
- **`LocatorOption` / `LocatorPickPayload`** — Cell-vs-Row locator alternatives for repeated table/list items

### IPC channels (`src/shared/types.ts` → `IPC_CHANNELS`)

**Renderer → Main (21):** `BROWSER_LAUNCH`, `BROWSER_CLOSE`, `RECORDING_START`, `RECORDING_STOP`, `REPLAY_TO_NODE`, `REPLAY_STOP`, `FLOW_SAVE`, `FLOW_LOAD`, `FLOW_LIST`, `FLOW_DELETE`, `FLOW_GET` (one flow JSON by ID), `FLOW_CHECK_CYCLE` (validate adding a callFlow won't create a circular reference — recursively walks the sub-flow's callFlow graph), `EXPORT_SCRIPTS`, `RUN_TESTS`, `SHOW_REPORT` (spawn `npx playwright show-report`; kills any process on port 9323 first), `PROJECT_SAVE`, `PROJECT_LOAD`, `PROJECT_LIST`, `PROJECT_DELETE`, `START_ASSERTION_PICK`, `LOCATOR_PICK_RESOLVED`

**Main → Renderer (9):** `ACTION_CAPTURED`, `REPLAY_NODE_START`, `REPLAY_NODE_COMPLETE`, `REPLAY_FINISHED`, `REPLAY_ERROR`, `TEST_OUTPUT`, `TEST_FINISHED`, `ASSERTION_PICK_CANCELLED`, `LOCATOR_PICK_NEEDED` (legacy — the locator picker now renders in-browser)

### Recording pipeline

1. `Recorder.start()` → `CodegenCapture.start()` extracts Playwright's `InjectedScript` from `playwright-core/lib/coreBundle.js` at runtime (parses the `source3` string literal via `captureShared.ts`) and injects it with `page.addInitScript()` **plus an immediate `page.evaluate()`** so listeners are active even when the page is already loaded (branch recording). Exposes `__flowtest_report`, `__flowtest_assert_report`, `__flowtest_assert_cancel`, `__flowtest_locator_resolved` via `page.exposeFunction()`.
2. Browser JS calls `__flowtest_report(rawEvent)` on click/fill/selectOption/check/uncheck/press
3. `captureShared.ts` builds Actions with high-quality locators via `window.__ftGetLocator(el)` (Playwright's own `generateSelectorSimple` + `asLocator`), falling back to a CSS selector builder
4. Navigation suppression: events within `NAV_SUPPRESSION_MS = 5000` after a click/press/fill are not re-recorded as `goto` (redirect side-effects). A 50 ms delay lets pending IPC settle so SPA navigations are also suppressed.
5. Each captured action fires `ACTION_CAPTURED` → `usePlaywrightEvents` → `flowStore.addActionNode()` (appended to `recordingHeadId`) → auto-saves JSON

#### DOM event filtering in `getDOMCaptureScript()` (matches Playwright's `RecordActionTool`)

- **Click** — **blacklist** approach: records any click except `SELECT`, `OPTION`, `INPUT[date/range]`, `html`, `body`, and any FlowTest-injected UI (ids starting `__ft_`). Bubbles up to nearest `<button>`/`<a>` only for better locator quality. Uses `event.composedPath()[0]` to pierce Shadow DOM. Text-input clicks get an `isInputClick` flag so a following fill can suppress them; checkbox/radio clicks become `check`/`uncheck`.
- **Fill** — `focus`/`blur` pair captures final value on text inputs **and `contentEditable`** elements.
- **SelectOption** — native `<select>` `change` event; captures `value` and display text.
- **Press** — mirrors Playwright's `_shouldGenerateKeyPressFor`: records `Tab`, `Enter` (outside textarea/contentEditable), `Escape`, arrow/function keys, modifier+char combos. Skips `Backspace`, `Delete`, paste shortcuts, bare modifier keys, and single printable chars without modifiers.
- **Table cell detection** — when a click lands inside a `<tr>`, two `alternativeLocators` are offered (Cell-by-content vs Row-by-nth-position, scoped to the right `<table>`/section), triggering the in-browser locator picker (see below).

`CodegenCapture` buffers `isInputClick` clicks and discards them if a fill on the same element follows (`flushPendingInputClick`).

### In-browser locator picker (Cell vs Row)

When a recorded click hits a repeated table/list item with `alternativeLocators`, `CodegenCapture.showLocatorPicker()` pauses recording and renders a "選擇 Locator 方式" modal **inside the recorded browser** (`getLocatorPickerScript`). On confirm, `__flowtest_locator_resolved(index)` finalizes the Action with the chosen locator. The renderer-side `LocatorPickerModal` component / `LOCATOR_PICK_NEEDED` channel / `pendingLocatorPick` store field are **legacy** (the picker is fully in-browser now).

### Assertion-picking pipeline

Assertion picking is driven by an **in-browser dock** injected during recording (`getAssertionToolbarScript`), not by Toolbar buttons:

1. A fixed dock on the right edge of the recorded browser shows 👁 可見 / T 文字 / = 值 buttons (dock id `__ft_assert_toolbar`, so its clicks are blacklisted from recording)
2. Clicking a button runs `window.__ft_startAssertPick(type)` — a transparent overlay highlights the element under the cursor and shows its locator in a tooltip
3. On click, `__flowtest_assert_report` emits an assertion action (`assertVisible` / `assertText` / `assertValue`) via `ACTION_CAPTURED`; Escape cancels via `__flowtest_assert_cancel`
4. The legacy `START_ASSERTION_PICK` IPC path still exists and re-triggers the same in-page overlay

### Replay pipeline

`Replayer.replayToNode()` walks `parentId` pointers from the target node up to the root (cycle-guarded) to build an ordered path, then executes each `Action` sequentially. A yellow cursor-highlight dot is injected (`getCursorHighlightScript`). Assertions support `text`, `visible`, `url`, `count` with a 10 s timeout. Each step fires `REPLAY_NODE_START` / `REPLAY_NODE_COMPLETE` to drive canvas status badges.

`Replayer` constructor: `(page, baseURL = '', profileVars?, activeProfileId?, activeEnvironmentId?)`. The `domain` profile variable drives goto URL origin substitution — if a goto URL's origin matches `baseURL`'s origin, it is replaced with `profileVars['domain']`. `activeProfileId` + `activeEnvironmentId` let the replayer resolve `subFlowProfileMapping` and `envValues` on `callFlow` nodes at any nesting depth. `executeCallFlow()` loads the sub-flow, resolves its profile, builds a nested `Replayer`, and merges captured session vars back up.

### Branch recording pipeline

When the user picks "從此節點分支錄製" from node N's context menu:
1. `startBranchRecording(N)` sets `recordingHeadId = N`, passes `branchFromNodeId: N` + `branchNodes` + active `profileVars`/`activeProfileId`/`activeEnvironmentId` in `RecordingStartPayload`
2. Main process relaunches the browser, then silently replays from root → N using a `Replayer` (200 ms/step default, no UI events)
3. `Recorder.start()` begins WITHOUT navigating to `baseURL` — browser is already at N's page state
4. New actions append as children of N; `recordingHeadId` tracks the last-added node so subsequent actions chain correctly

### Test execution pipeline

1. User clicks "▶ 執行所有測試" → `RUN_TESTS` IPC (with `ExportConfig`, `useTestStep: true`)
2. Main runs `ScriptExporter.export()` to write `.spec.ts`, then spawns `npx playwright test <file> --reporter=list,html` as a child process (cwd = `process.cwd()` in dev, `userData` when packaged)
3. stdout/stderr stream line-by-line via `TEST_OUTPUT` → `TestOutputModal` shows live output
4. On exit, `TEST_FINISHED` fires. The HTML report is opened separately via `SHOW_REPORT` (`showReport()`), which kills any process on port 9323 first.

### Variable system (`src/shared/variableResolver.ts`)

Three kinds of `{{...}}` placeholders, resolved in priority order **session > profile > built-in**:

1. **Session variables** (highest) — any action node can set `action.captureAs = "varName"`. `Replayer` captures the resolved value into `this.sessionVars`; `ScriptExporter` emits a `const varName = ...` declaration.
2. **Environment profile variables** — the active `FlowProfile`'s `vars[]` resolved by key, with `envValues[activeEnvId] ?? value`. The `domain` key also substitutes goto URL origins matching `flow.baseURL`'s origin.
3. **Built-in variables** (5): `{{randomText}}` (8-char string), `{{randomNumber}}` (8-digit), `{{randomOneText}}` (one A–Z letter), `{{randomOneNumber}}` (one 0–9 digit), `{{timestamp}}` (`yyyyMMddHHmmssSSS`).

`resolveValue` / `resolveValueWithSession` resolve at runtime. For codegen: `valueToCodeExpr(value, profileVarKeys?)` → TS literal (profile keys become `${_ftProf_key}`); `sessionAwareValueToCodeExpr()` additionally treats session vars as bare identifiers; `locatorExprToCode()` rewrites `{{...}}` inside locator expression string arguments; `emitProfileVarDecls()` emits `const _ftProf_key = '...'`; `VARIABLE_HELPERS_CODE` injects `_ftRandomText` / `_ftRandomNumber` / `_ftRandomOneLetter` / `_ftRandomOneDigit` / `_ftTimestamp` when needed.

#### Session variable hoisting in `useTestStep` mode

With `useTestStep`, each action is wrapped in its own `test.step('…', async () => {…})` closure, so a `captureAs` declared with `const` in one closure is invisible to later closures. `generateSpec()` collects all `captureAs` names into `hoistedVars`, emits `let varName = ''` at the test-function scope, and passes `hoistedVars` to `actionToCode()` which then emits plain assignment (`varName = expr`) instead of `const`.

#### `assertText` session-variable locator fix

If an `assertText` node's `value` is a pure session-var reference (`{{varName}}`, with `varName` already defined) and `action.selector` exists, `actionToCode()` emits `page.locator(selector).filter({ hasText: valueExpr })` instead of the stale recording-time `locatorExpr` (which embedded the captured text). `assertValue` is unaffected.

### Environment Profiles system

Each flow has `profiles?: FlowProfile[]`. A profile is a named set of `ProfileVariable` entries. Switching the active profile swaps all `{{key}}` resolutions at once.

**Key invariant:** all profiles within a flow share the same variable keys — only `value`/`description`/`envValues` differ per profile. The store enforces this with three cross-profile mutation actions: `addVarToAllProfiles()`, `updateVarKeyInAllProfiles(index, newKey)`, `deleteVarFromAllProfiles(index)`. Per-profile mutations (`value`, `description`, `name`) use `updateProfile(id, updates)`.

A new flow starts with one profile named `錄製` holding `{ key: 'domain', value: <baseURL origin> }`.

**Migration:** old flows with `domains?: string[]` but no `profiles` are migrated in memory on load (`migrateDomainsToProfiles()`), no disk write.

**Code generation:** profile vars emit as `const _ftProf_key = '...'` at top of spec. Goto URLs with domain substitution emit parameterized: `` `${_ftProf_domain}/path` `` (parent flow) or baked-in literals (inlined sub-flows).

**UI:** Toolbar `⚙` profile selector → dropdown → "管理配置…" opens `ProfileEditorModal`. Right sidebar `ProfileVarList` (amber) shows the active profile's vars; click to copy `{{key}}`.

### Projects & Environments system

Projects add a layer **above** flows for managing environment-specific variable values. A `Project` has named `environments`; a `Flow` joins a project via `projectId`.

- A `ProfileVariable` can carry `envValues: Record<envId, string>` — per-environment overrides of its base `value`. Resolution everywhere is `envValues[activeEnvironmentId] ?? value`.
- The **active environment** (`activeEnvironmentId` in the store) is threaded through replay, branch recording, and export as `activeEnvironmentId`, and is used by `Replayer`/`ScriptExporter`/`usePlaywright`/`Toolbar` when building `profileVars`.
- Storage: projects live as `projects/{id}.json` (`ProjectStorage`), separate from flows.
- Store actions: `createProject`, `addEnvironmentToProject`, `renameEnvironment`, `deleteEnvironment`, `deleteProject`, `assignFlowToProject`, `setActiveEnvironment`, `setCurrentProject`. `openFlow` loads the owning project and picks a sensible active environment.
- **UI:** `FlowList` groups flows by project (📁 headers + "未分類"), with a per-flow right-click menu to move between projects, rename, duplicate (建立副本), delete, or "加入當前流程中" (embed as sub-flow). The Toolbar shows a 🌐 environment selector whenever the current flow belongs to a project.

### Sub-flow system

A `callFlow` action node embeds another flow inline. Two ways to create one:

1. **Reference an existing flow** — `CallFlowModal` (2–3 steps): pick sub-flow (+ edit description, with cycle check via `FLOW_CHECK_CYCLE`) → pick exit node (a leaf) → profile mapping (only when the sub-flow has >1 profiles). Inserted via `insertCallFlowBefore` / `appendCallFlowAfter` (context menu) or appended as a new root (FlowList "加入當前流程中").
2. **Extract from selection** — multi-select contiguous nodes (single entry, single exit, fully connected per `validateExtraction`) → "另存為子流程" → `extractSubflow()` builds a new sub-flow, replaces the selection with a `callFlow` node, rewires parent/child references, and saves both flows.

#### Sub-flow Profile Mapping

**`subFlowProfileMapping: Record<parentProfileId, subFlowProfileId | null>`** on the `callFlow` action. `null` means "use the sub-flow's first profile".

**N-level nesting:** each `Replayer` / `ScriptExporter` pass receives the *resolved sub-flow profile ID* as its own `activeProfileId`; nested callFlows resolve `subFlowProfileMapping[activeProfileId]` to chain to the next level. Resolution order: `subFlowProfileMapping[activeProfileId]` → legacy `subFlowProfileId` → first profile.

**ScriptExporter** threads `activeProfileId`/`activeEnvironmentId` through `generateSpec` → `buildStepSequence` → `getSubFlowPath` recursively, calling `resolveSubFlowProfileId()` + `resolveProfileVars()` at each callFlow node. Sub-flow nodes are inlined with `inlineVars: true` — their profile var placeholders are baked into literal values at codegen time (so they don't reference the parent's `_ftProf_*`).

**Migration:** legacy `callFlow` nodes with `subFlowProfileId` but no mapping are auto-migrated in memory on load (`migrateCallFlowProfiles()`). `addProfile`/`deleteProfile` keep all callFlow mappings in sync.

**ActionNode badge:** mapping with >1 entries → indigo `⚙ 動態配置`; otherwise amber `⚙ <profileName>`.

### Canvas layout & node graph editing

- **Layout** (`src/renderer/utils/treeLayout.ts`): `computeTreeLayout` lays out one tree (subtree-centered, `NODE_WIDTH=200`, `NODE_HEIGHT=70`); `computeAllRootsLayout` lays out every root tree side-by-side; both accept a `SizeOf` callback so expanded groups can reserve their full box footprint.
- **`positionsFinalized`**: `fn.position` is the single source of truth for rendering. On first load of a flow whose positions were never finalized, `FlowCanvas` calls `materializeLayout()` (writes computed positions into the store, marks finalized, persists). `relayoutAll()` ("🧹 整理節點") recomputes unconditionally. Manual drags update `position` via `updateNode` with **debounced** disk save, run through `runWithoutHistory` so repositioning doesn't flood undo history.
- **Editing**: drag node handles to `connectNodes` (rejects if target already has a parent); delete edges to `disconnectNodes`; context-menu `disconnectNode` detaches a node from both parent and children (each becomes a floating root); `deleteNode` removes a node + subtree; `deleteNodesOnly` removes nodes but re-parents survivors as floating roots. Multi-select (Shift) drives extract/group/bulk-delete/bulk-disconnect.

### Visual groups (in-place, canvas-only)

`FlowGroup` collapses a contiguous, single-entry/single-exit selection into one canvas node — **without** creating a separate Flow. Membership is `FlowNode.groupId`. `src/renderer/utils/groups.ts`:
- `getGroupBoundary()` resolves member set + entry/exit; `groupBoxRect()` computes the drawn frame.
- `computeGroupAwareLayout()` treats each group as one synthetic node in the outer tree (sized to its box footprint when expanded), then positions members inside the reserved box (expanded) or at the entry's slot (collapsed).
- Store: `createGroup`, `toggleGroupCollapsed`, `ungroupGroup` (each re-runs group-aware layout and persists). Rendered by `GroupNode` (collapsed pill) and `GroupBox` (expanded frame). Edges into a collapsed group are routed through its `group:<id>` node.

### Undo/Redo

`flowStore` keeps `past[]` / `future[]` snapshots of `currentFlow` (cap `HISTORY_LIMIT = 50`). A single `useFlowStore.subscribe` records a snapshot whenever an edit replaces `currentFlow` with a new object — skipping when `isTimeTraveling`, `suppressHistory` (drags), a flow switch, or live recording/replay. `undo`/`redo` swap snapshots and persist. `useUndoRedo` binds Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (ignored while typing in inputs or during recording/replay). Toolbar exposes ↶ 復原 / ↷ 重做 buttons.

### Storage

- Flows: `flows/{flowId}.json` (dev: `process.cwd()/flows`; prod: `app.getPath('userData')/flows`). `FlowStorage.list()` also computes each flow's `refCount` by scanning all callFlow nodes.
- Projects: `projects/{projectId}.json` (`ProjectStorage`).
- Exports: `ScriptExporter` computes all root-to-leaf paths and emits one `test()` block per path into `exports/{flowId}.spec.ts`; optionally extracts a shared prefix (≥3 common leading nodes, ≥2 paths) into `exports/helpers/{flowId}-helpers.ts`.

### Path aliases (tsconfig + vite config)

| Alias | Resolves to |
|-------|-------------|
| `@shared/*` | `src/shared/*` |
| `@renderer/*` | `src/renderer/*` |

## File Reference

| File | Role |
|------|------|
| `src/main/index.ts` | Electron entry — creates BrowserWindow, registers IPC handlers, opens external links in default browser |
| `src/main/ipc/ipcHandlers.ts` | Central orchestrator — all 21 Renderer→Main channel handlers; holds singleton BrowserController/Recorder/Replayer; `hasCallFlowCycle()` + `killProcessOnPort()` |
| `src/main/playwright/browserController.ts` | Wraps playwright-core chromium: launch, context, page, auto-cleanup on disconnect |
| `src/main/playwright/recorder.ts` | Thin wrapper around CodegenCapture; tracks recording state; pause/resume; assertion-pick entry |
| `src/main/playwright/codegenCapture.ts` | Multi-page recorder: injects scripts (initScript + DOM capture + cursor + assertion dock), exposes report/assert/locator-resolved functions, filters navigation, buffers input clicks, drives in-browser locator picker |
| `src/main/playwright/actionCapture.ts` | Single-page variant of CodegenCapture (supports stop/restart without re-injection; not active in main flow) |
| `src/main/playwright/captureShared.ts` | Shared utilities: extracts InjectedScript from coreBundle.js, DOM event capture (blacklist, Shadow DOM-aware), locator builder, nav-suppression logic, assertion dock + pick overlay scripts, in-browser locator-picker script, cursor highlight, `buildAction` |
| `src/main/playwright/replayer.ts` | Action/assertion execution; parentId-chain path traversal; fires REPLAY_NODE_* events; constructor `(page, baseURL, profileVars?, activeProfileId?, activeEnvironmentId?)`; resolves subFlowProfileMapping + envValues for callFlow at any depth |
| `src/main/storage/flowStorage.ts` | Flow CRUD; `list()` computes `refCount`; sorts by updatedAt |
| `src/main/storage/projectStorage.ts` | Project CRUD under `projects/` |
| `src/main/storage/scriptExporter.ts` | Path computation + `.spec.ts` / `-helpers.ts` codegen; emits `_ftProf_*` decls; threads activeProfileId/activeEnvironmentId through recursive sub-flow expansion; hoists captureAs vars in useTestStep mode; `filter({ hasText })` for session-var assertText |
| `src/shared/types.ts` | All shared types + `IPC_CHANNELS`; `isCallFlowAction` guard; `REPLAY_SPEED_MS` |
| `src/shared/variableResolver.ts` | Variable system: 5 built-ins, `resolveValue(WithSession)`, `valueToCodeExpr`, `sessionAwareValueToCodeExpr`, `locatorExprToCode`, `emitProfileVarDecls`, `VARIABLE_HELPERS_CODE` |
| `src/preload/index.ts` | contextBridge — exposes typed `window.electronAPI` (incl. project + report + locator-pick wrappers) |
| `src/renderer/App.tsx` | Root — calls `usePlaywrightEvents()` + `useUndoRedo()`; renders Toolbar + FlowList + FlowCanvas + PropertyPanel + right sidebar (VariableList / ProfileVarList / SessionVarList) |
| `src/renderer/stores/flowStore.ts` | Zustand store — flow/node/profile/project/environment state + actions; undo/redo history subscription; group actions; layout actions; domain + callFlow-profile migrations |
| `src/renderer/components/Toolbar/Toolbar.tsx` | Action bar: new-flow, undo/redo, record/stop, relayout, export, run-tests, replay-speed, environment selector (🌐), profile selector (⚙), status pills; new-flow dialog |
| `src/renderer/components/Toolbar/TestOutputModal.tsx` | Streams live `TEST_OUTPUT` lines during `RUN_TESTS` |
| `src/renderer/components/Canvas/FlowCanvas.tsx` | ReactFlow canvas: node/edge derivation (incl. groups), drag-reposition with debounced save, connect/disconnect, multi-select, context menu, modals (CallFlow / ExtractSubflow / GroupName); one-time layout materialization |
| `src/renderer/components/Canvas/ActionNode.tsx` | Custom node: type icon/color, description, selector, replay-status border, page-nav border, callFlow profile badge |
| `src/renderer/components/Canvas/GroupNode.tsx` | Collapsed-group node (expand on click) |
| `src/renderer/components/Canvas/GroupBox.tsx` | Expanded-group background frame with collapse / ungroup controls |
| `src/renderer/components/Canvas/GroupNameModal.tsx` | Name prompt when forming a group |
| `src/renderer/components/Canvas/BranchEdge.tsx` | Custom bezier edge with optional branch-label badge |
| `src/renderer/components/Canvas/NodeContextMenu.tsx` | Node context menu: replay, branch-record, group/extract (multi-select), insert/append callFlow, capture-as variable, disconnect, delete-only, delete+subtree |
| `src/renderer/components/Canvas/CanvasStatusBar.tsx` | Multi-select status banner |
| `src/renderer/components/Canvas/ExtractSubflowModal.tsx` | Name + confirm dialog for extracting a selection into a sub-flow |
| `src/renderer/components/FlowList/FlowList.tsx` | Sidebar: flows grouped by project + 未分類; collapsible 子流程 subsection (refCount>0); right-click menu (move project / rename / duplicate / delete / add as sub-flow); new-project + rename dialogs |
| `src/renderer/components/PropertyPanel/PropertyPanel.tsx` | Bottom panel: edit description/selector/locator/value for selected node; assertText/assertValue value fields; callFlow "配置對應" mapping grid (loads sub-flow profiles via `FLOW_GET`) |
| `src/renderer/components/ProfileEditor/ProfileEditorModal.tsx` | Two-column modal: profile list (add/rename/delete) + variable table (key synced across profiles; value/description per-profile) |
| `src/renderer/components/CallFlowModal/CallFlowModal.tsx` | 2–3 step modal to embed a sub-flow: select flow (cycle-checked) → exit node → profile mapping |
| `src/renderer/components/LocatorPickerModal/LocatorPickerModal.tsx` | **Legacy** — Cell-vs-Row picker (now rendered in-browser by CodegenCapture) |
| `src/renderer/components/VariableList/VariableList.tsx` | Sidebar: 5 built-in variables; click to copy |
| `src/renderer/components/ProfileVarList/ProfileVarList.tsx` | Sidebar: active profile's variables (amber); click to copy `{{key}}` |
| `src/renderer/components/SessionVarList/SessionVarList.tsx` | Sidebar: session variables from `captureAs` nodes; click to copy, trash to delete |
| `src/renderer/hooks/usePlaywrightEvents.ts` | IPC event subscriptions: ACTION_CAPTURED, REPLAY_NODE_*, REPLAY_FINISHED/ERROR, ASSERTION_PICK_CANCELLED, LOCATOR_PICK_NEEDED |
| `src/renderer/hooks/usePlaywright.ts` | IPC invocation wrappers: startRecording, startBranchRecording, stopRecording, replayToNode (builds env-aware profileVars) |
| `src/renderer/hooks/useUndoRedo.ts` | Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z keyboard shortcuts |
| `src/renderer/hooks/useRecording.ts` | Branch-recording state helpers |
| `src/renderer/hooks/useFlowStore.ts` | `useFlowManager`: refreshFlowList/refreshProjectList, openFlow (+ loads project), newFlow, saveCurrentFlow, deleteCurrentFlow |
| `src/renderer/utils/treeLayout.ts` | Tree layout: `computeTreeLayout`, `computeAllRootsLayout`, sizing constants, `SizeOf` |
| `src/renderer/utils/groups.ts` | Group geometry + `computeGroupAwareLayout` |
| `src/renderer/utils/subflowExtraction.ts` | `validateExtraction` (single entry/exit, connected) + `extractSubflow` (build sub-flow, rewire parent) |
| `src/renderer/types/electron.d.ts` | TypeScript declaration for `window.electronAPI` |
| `electron.vite.config.ts` | Build config for all three bundles + path aliases |
| `playwright.config.ts` | Generated-spec runner config (`testDir: './exports'`, headless: false, HTML report) |
| `electron-builder.yml` / `package.json#build` | Installer config |
