# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**FlowTest** is an Electron desktop app that records user interactions as a visual branching flow graph, then generates Playwright `.spec.ts` test suites. The core innovation is "branch recording": silently replay to any previously-recorded node, then continue recording from that exact browser state — turning a 30-step flow into 5 new steps when testing a different path.

Beyond recording, the app is a full visual flow editor: drag-to-reposition, drag-to-connect/disconnect nodes, multi-select, undo/redo, collapsible visual groups, sub-flow extraction/embedding, environment profiles, project-level environment overrides, and hand-written `code` nodes as an escape hatch for anything recording can't express.

## Project Stage

**This project is currently in MVP development.** Existing on-disk data (flows under `flows/`, projects under `projects/`) does **not** need to be preserved or migrated — feel free to change data shapes, defaults, and storage formats without backward-compatibility shims or migration code. Don't add or retain migration logic solely to protect old data; optimize for a clean design.

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
  ├── FixtureStorage
  └── ScriptExporter
```

`src/main/index.ts` is the Electron entry point: creates the BrowserWindow (1280×800, contextIsolation on, nodeIntegration off) and calls `registerIpcHandlers(win)`.

### IPC as the central seam

`src/main/ipc/ipcHandlers.ts` is the **only file** that coordinates Main process modules. All Renderer ↔ Main communication goes through `IPC_CHANNELS` constants defined in `src/shared/types.ts`. The preload bridge (`src/preload/index.ts`) exposes `window.electronAPI` with typed wrappers for every channel.

Renderer → Main: `window.electronAPI.<method>()` → `ipcMain.handle(channel, ...)`
Main → Renderer: `win.webContents.send(channel, payload)` → `usePlaywrightEvents` / `Toolbar` hooks

Singletons `browserController`, `recorder`, `replayer` are module-level in `ipcHandlers.ts`. Recording **always relaunches the browser** (Playwright's `_enableRecorder` can only be called once per context).

### Key data types (`src/shared/types.ts`)

- **`ActionType`** — 14 variants: `goto | click | fill | selectOption | check | uncheck | press | upload | wait | assertVisible | assertText | assertValue | callFlow | code`
- **`Action`** — one browser interaction: `type`, `locatorExpr` (high-quality Playwright locator), `selector` (CSS fallback), `value`, `captureAs` (optional session variable name), `description`, `url`, `isPageNavigation`, optional `assertion`. Type-specific fields:
  - **click** — `button?: 'left'|'right'|'middle'`, `modifiers?: string[]` (Playwright names), `clickCount?` (2 = replayed/exported as `dblclick`)
  - **selectOption** — `values?: string[]` for `<select multiple>` (takes precedence over `value`)
  - **upload** — `filePaths?: string[]` (authoritative over the comma-joined `value`)
  - **callFlow** — `subFlowId`, `subFlowExitNodeId`, `subFlowProfileMapping?: Record<parentProfileId, subFlowProfileId | null>`, legacy `subFlowProfileId` / `subFlowProfileName` (for single-parent badge display). `isCallFlowAction(action)` is a type guard.
  - **code** — `code?: string`, a raw Playwright/JS body run with `(page, expect, vars)` in scope
  - **multi-page / iframe (any type)** — `pageAlias?` (absent = initial page; popups get `page1`, `page2`…), `framePath?: string[]` (iframe locator expressions, top → innermost; scoped via `.contentFrame()` chains), `opensPage?` (the alias of the page this action opened)
- **`Assertion`** — `type` (`text|visible|url|count`), optional `target` selector, `expected` value
- **`FlowNode`** — `Action` + canvas `position` + `parentId` + `childIds[]` + optional `branchLabel` + optional `groupId` (membership in a visual group)
- **`FlowGroup`** — `{ id, name, collapsed }` — an in-place collapsible group of contiguous nodes (single entry, single exit). **Pure canvas-display construct** — never creates a separate Flow, never enters the flow list. Membership recorded via `FlowNode.groupId`.
- **`ProfileVariable`** — `{ key, value, description?, envValues?: Record<envId, string> }`. `value` is the fallback; `envValues[activeEnvId] ?? value` is the per-environment resolution.
- **`FlowProfile`** — `{ id, name, vars: ProfileVariable[] }` — a named environment configuration
- **`ProjectEnvironment`** — `{ id, name }`
- **`ProjectEnvVar`** — `{ key, values: Record<envId, string>, description? }` — a project env var with one value per environment (`values[activeEnvId]`). The reserved `domain` key drives goto-URL origin substitution.
- **`Project`** — `{ id, name, environments: ProjectEnvironment[], envVars?: ProjectEnvVar[], createdAt, updatedAt }` — stored separately under `projects/`. Reserved default project: `DEFAULT_PROJECT_ID = '__default__'` / `DEFAULT_PROJECT_NAME = '未分類'`. Domain constants: `DOMAIN_ENV_KEY = 'domain'`, `DEFAULT_ENV_NAME = 'DEV'`, `DEFAULT_DOMAIN = 'http://localhost:3000/'`.
- **`Flow`** — `nodes: FlowNode[]`, `rootNodeId`, `baseURL`, `profiles?: FlowProfile[]`, `groups?: FlowGroup[]`, `projectId?` (project membership), `positionsFinalized?` (true once layout is materialized / first manual drag), metadata. `domains?: string[]` is deprecated (migrated to profiles on load)
- **`FlowListItem`** — lightweight summary from `FLOW_LIST` with `refCount` (how many callFlow nodes across all other flows reference this flow as a sub-flow; >0 = it's a reusable sub-flow, 0 = top-level test case) and `projectId`
- **`ReplaySpeed`** — `'fast' | 'normal' | 'slow'` mapped to 100 / 500 / 1000 ms (`REPLAY_SPEED_MS`)
- **`RecordingStartPayload`** — `baseURL`, optional branch-recording fields (`branchFromNodeId`, `branchNodes`, `replaySpeed`), `profileVars?`, `activeProfileId?`, `activeEnvironmentId?`, `envVars?`, `activeProjectId?`
- **`ExportConfig`** — `outputDir`, `helperFunctions`, `useTestStep`, `profileVars?` (active profile's flat key-value map), `activeProfileId?`, `activeEnvironmentId?`, `envVars?` (flattened project env vars for the active env), `activeProjectId?`
- **`ReplayToNodePayload`** — `nodes`, `targetNodeId`, `speed`, `baseURL?`, `profileVars?`, `activeProfileId?`, `activeEnvironmentId?`, `envVars?`, `activeProjectId?`
- **`LocatorOption` / `LocatorPickPayload`** — Cell-vs-Row locator alternatives for repeated table/list items
- **`ActionUpdatedPayload`** — `{ actionId, updates: Partial<Action> }` — retroactively patches an already-captured action (used when a popup arrives after its triggering click was emitted)

### IPC channels (`src/shared/types.ts` → `IPC_CHANNELS`)

**Renderer → Main (22):** `BROWSER_LAUNCH`, `BROWSER_CLOSE`, `RECORDING_START`, `RECORDING_STOP`, `REPLAY_TO_NODE`, `REPLAY_STOP`, `FLOW_SAVE`, `FLOW_LOAD`, `FLOW_LIST`, `FLOW_DELETE`, `FLOW_GET` (one flow JSON by ID), `FLOW_CHECK_CYCLE` (validate adding a callFlow won't create a circular reference — recursively walks the sub-flow's callFlow graph), `EXPORT_SCRIPTS`, `RUN_TESTS`, `SHOW_REPORT` (spawn `npx playwright show-report`; kills any process on port 9323 first), `PROJECT_SAVE`, `PROJECT_LOAD`, `PROJECT_LIST`, `PROJECT_DELETE`, `START_ASSERTION_PICK`, `LOCATOR_PICK_RESOLVED`, `PICK_FILES` (native open dialog; copies picks into `fixtures/` and returns their stored paths)

**Main → Renderer (11):** `ACTION_CAPTURED`, `ACTION_UPDATED` (retro-patch fields of an already-emitted action — e.g. stamping `opensPage` when the popup arrives late), `ACTION_REMOVED` (un-record a node — the click that opened a file chooser), `REPLAY_NODE_START`, `REPLAY_NODE_COMPLETE`, `REPLAY_FINISHED`, `REPLAY_ERROR`, `TEST_OUTPUT`, `TEST_FINISHED`, `ASSERTION_PICK_CANCELLED`, `LOCATOR_PICK_NEEDED` (legacy — the locator picker now renders in-browser)

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
- **Mouse variants** — `dblclick` (`clickCount: 2`), `contextmenu` (right button) and `auxclick` (middle button) are recorded alongside plain clicks; modifier keys held during a click become `modifiers`. The raw `detail >= 2` clicks that make up a double-click are dropped in favour of the `dblclick` event.
- **Table cell detection** — when a click lands inside a `<tr>`, two `alternativeLocators` are offered (Cell-by-content vs Row-by-nth-position, scoped to the right `<table>`/section), triggering the in-browser locator picker (see below).

`CodegenCapture` keeps a **one-slot action buffer**: `isInputClick` clicks wait indefinitely and are discarded if a fill on the same element follows (`flushPendingInputClick`); plain left clicks wait `DBLCLICK_MERGE_MS = 350` for a possible `dblclick` to merge into (and so a popup event can stamp `opensPage` before emission).

#### Multi-page (popup) recording

`CodegenCapture` listens on the context's `page` event. Each new page gets an alias (`page1`, `page2`…; the initial page maps to `''` and its actions carry no `pageAlias`), gets the same scripts injected, and its first navigation is nav-suppressed. The action that opened it is stamped with `opensPage`:
- if it is still in the dblclick buffer, the field is set before emission;
- if it was already emitted within `OPENS_PAGE_WINDOW_MS = 1000`, `ACTION_UPDATED` retro-patches the node in the renderer.

`Replayer` awaits `context.waitForEvent('page')` around such actions; `ScriptExporter` emits the official `const pageNPromise = page.waitForEvent('popup'); … ; const pageN = await pageNPromise;` pattern (and imports `Page` when a popup alias must be hoisted).

#### iframe recording

`frameLocatorChain()` builds the iframe locator chain (top → innermost) for the frame an event came from, cached per `Frame` and invalidated on detach/navigation. When the frame element can't be resolved it degrades to `iframe[name="…"]` / `iframe[src="…"]`. The chain is stored on `action.framePath` and **never baked into `locatorExpr`** — `Replayer.scopeFor()` folds it into `page → frameLocator` hops via `.contentFrame()`, and `ScriptExporter` emits the same chain. Top-frame-only UI (assertion dock, cursor highlight, locator picker) is wrapped by `topFrameOnly()` since context init scripts run in every frame.

### File upload recording (`fixtures/`)

The page only ever sees `File.name`, never a path — but the browser process knows the backing path, and CDP hands it over. **The file chooser is deliberately not intercepted**: Chromium opens its own dialog, on the window the user is already working in (registering a `filechooser` listener would suppress it and force a jarring cross-window Electron dialog instead). The capture script's upload branch parks the input on `(window.top || window).__ft_lastUploadInput`, then `CodegenCapture.importUploadedFiles()` — awaited inside the `__flowtest_report` binding, before the action is emitted — runs `Runtime.evaluate` + **`DOM.getFileInfo`** over a cached per-page `CDPSession` to read each real path, and `onFilesImported` (wired to `FixtureStorage.importFile()` in `ipcHandlers`) copies them into `fixtures/`. `handleRawEvent` then swaps the stored paths into `value` / `filePaths` / `description`. Init scripts run in the main world, which is why `Runtime.evaluate` can see the global; same-origin iframes write through to `window.top`, cross-origin ones can't and degrade to names.

- Paths are stored **relative to the data root** (`fixtures/cat.jpg`), which is also the cwd `RUN_TESTS` spawns Playwright in — so exported specs are portable. `FixtureStorage.toAbsolute()` resolves them for `Replayer` (the packaged main process cwd is *not* the data root). Absolute paths still pass through untouched.
- **The click that opened the chooser is dropped.** It is unreplayable: the input is hidden behind a styled trigger, Chromium reports `input[type=file]` itself as role=button carrying the trigger's label, so the recorded click either waits forever on an invisible element or matches both — and `setInputFiles` never needed it. The DOM script's `findTriggerSelector()` anchors on the input that actually received files and walks **up** ≤3 levels looking for the last-clicked element (anchoring the other way would mis-flag a click on any container that happens to enclose an upload widget); `dropTriggerClick()` then either discards the still-buffered click or, if it already reached the canvas, sends `ACTION_REMOVED` so the renderer deletes that node and moves `recordingHeadId` back to its parent. **`ACTION_REMOVED` must precede the upload's `ACTION_CAPTURED`** — `deleteNode` takes the subtree with it. A visible button that opens the chooser via JS isn't detectable this way and is correctly kept; `Replayer.suppressFileChooser()` plus an emitted `page.on('filechooser', () => {});` stop it stalling a run.
- **Chooser suppression is scoped to one replay run and must be released.** Playwright enables `Page.setInterceptFileChooserDialog` on the *first* `filechooser` listener and disables it when the last one is removed, so a leftover listener silently swallows the chooser forever — and branch recording silently replays on the very page it then records on, which made "click upload, nothing happens". `replayToNode` releases its own listeners in a `finally` (`suppressedPages` + a shared `swallowFileChooser` reference, so a nested call-flow replayer can't lift the outer run's suppression).
- **Locators must stay tag-qualified.** These widgets routinely give the trigger and the hidden input the same id, so `qualifyFileInputLocator` emits `input#id` / `input[name=…]`, never a bare `#id`. For nodes recorded before that, `Replayer.resolveFileInput()` narrows at runtime (`base.and(input[type=file])` → descendant → base → the page's only file input) and `ScriptExporter` emits the same `.and(…)` narrowing when the locator isn't already input-scoped.
- Drag & drop uploads fire no chooser and keep bare names — `ActionNode` shows a red ⚠ 缺少檔案路徑 badge, and PropertyPanel's 📂 選擇檔案… button (`PICK_FILES`) fills them in.

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

Each action resolves its target through two hops: `pageFor(action)` picks the page by `pageAlias` (relaunching a closed one is not possible — a missing page is an error), then `scopeFor(action)` folds `framePath` into `.contentFrame()` hops. `getLocator()` evaluates `locatorExpr` against that scope with `new Function`, falling back to `scope.locator(selector)`. Clicks honour `button` / `modifiers` / `clickCount` (≥2 → `dblclick`); `selectOption` prefers `values[]`; `press` uses `keyboard.press()` when there is no locator; `code` nodes run through `AsyncFunction` with `(page, expect, vars)`.

`Replayer` constructor: `(page, baseURL = '', profileVars?, activeProfileId?, activeEnvironmentId?, envVars?, activeProjectId?, sharedPages?)`. The **project environment variable** `domain` (`envVars['domain']`, trailing slash stripped) drives goto URL origin substitution — if a goto URL's origin matches `baseURL`'s origin, it is replaced with that domain. `activeProfileId` + `activeEnvironmentId` let the replayer resolve `subFlowProfileMapping` and `envValues` on `callFlow` nodes at any nesting depth; `activeProjectId` gates env-var resolution to the active project. `executeCallFlow()` loads the sub-flow, resolves its profile, builds a nested `Replayer` (passing same-project-gated `envVars`), and merges captured session vars back up.

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

Kinds of `{{...}}` placeholders, resolved in priority order **session > profile > project-env > built-in**:

1. **Session variables** (highest) — any action node can set `action.captureAs = "varName"`. `Replayer` captures the resolved value into `this.sessionVars`; `ScriptExporter` emits a `const varName = ...` declaration.
2. **Environment profile variables** — the active `FlowProfile`'s `vars[]` resolved by key, with `envValues[activeEnvId] ?? value`. A profile value may itself reference a project env var via `{{key}}`.
3. **Project environment variables** — the active project's `envVars[]` flattened for the active environment (`flattenProjectEnvVars`). The reserved `domain` key drives goto URL origin substitution (origins matching `flow.baseURL` are swapped for the active environment's `domain`); see the Projects & Environments section.
4. **Built-in variables** (5): `{{randomText}}` (8-char string), `{{randomNumber}}` (8-digit), `{{randomOneText}}` (one A–Z letter), `{{randomOneNumber}}` (one 0–9 digit), `{{timestamp}}` (`yyyyMMddHHmmssSSS`).

`resolveValue` / `resolveValueWithSession` resolve at runtime. For codegen: `valueToCodeExpr(value, profileVarKeys?)` → TS literal (profile keys become `${_ftProf_key}`); `sessionAwareValueToCodeExpr()` additionally treats session vars as bare identifiers; `locatorExprToCode()` rewrites `{{...}}` inside locator expression string arguments; `emitProfileVarDecls()` emits `const _ftProf_key = '...'`; `VARIABLE_HELPERS_CODE` injects `_ftRandomText` / `_ftRandomNumber` / `_ftRandomOneLetter` / `_ftRandomOneDigit` / `_ftTimestamp` when needed.

#### Session variable hoisting in `useTestStep` mode

With `useTestStep`, each action is wrapped in its own `test.step('…', async () => {…})` closure, so a `captureAs` declared with `const` in one closure is invisible to later closures. `generateSpec()` collects all `captureAs` names into `hoistedVars`, emits `let varName = ''` at the test-function scope, and passes `hoistedVars` to `actionToCode()` which then emits plain assignment (`varName = expr`) instead of `const`.

#### `assertText` session-variable locator fix

If an `assertText` node's `value` is a pure session-var reference (`{{varName}}`, with `varName` already defined) and `action.selector` exists, `actionToCode()` emits `page.locator(selector).filter({ hasText: valueExpr })` instead of the stale recording-time `locatorExpr` (which embedded the captured text). `assertValue` is unaffected.

### Code nodes

A `code` action holds a raw Playwright/JS body — the escape hatch for loops, conditionals and anything the recorder can't express. Created from the **canvas pane context menu → 加入節點** (`AddNodeModal`), which lands a **floating** node (no parent/child) at the click position via `addNodeAt()`; the user wires it up manually.

Three names are in scope: **`page`** (the action's page), **`expect`** (Playwright's), and **`vars`**. `Replayer.buildCodeVars()` builds `vars` as `{...envVars, ...profileVars}` overlaid with session vars (session wins), plus the 5 built-ins exposed as **functions** (`vars.randomText()`) so each call yields a fresh value. `AddNodeModal` lists every available name with its origin (內建 / 環境配置 / 專案環境 / 區域); click to copy.

- **Replay**: `new AsyncFunction('page', 'expect', 'vars', action.code)`.
- **Export**: the body is inlined verbatim, preceded by a generated `const vars = { … }` literal — profile keys reference `_ftProf_*` (or are inlined as literals inside sub-flows), built-ins reference the `VARIABLE_HELPERS_CODE` helpers, so those helpers are always emitted when a code node is present.

### Environment Profiles system

Each flow has `profiles?: FlowProfile[]`. A profile is a named set of `ProfileVariable` entries. Switching the active profile swaps all `{{key}}` resolutions at once.

**Key invariant:** all profiles within a flow share the same variable keys — only `value`/`description`/`envValues` differ per profile. The store enforces this in `commitProfileVars(profileId, rows, envId)`, which rebuilds every profile's `vars` from one whole-table submission: keys are applied to all profiles, value/description only to `profileId` (into `envValues[envId]` when an environment is active). Profile-level mutations (`name`) use `updateProfile(id, updates)`.

A new flow starts with `profiles: []` (no profiles). `domain` is **not** a profile variable — it lives on the project's environments (see Projects & Environments). `flow.baseURL` is not entered by the user; it is derived from the target project's first-environment `domain` at flow creation and refreshed to the active environment's `domain` at each fresh recording start (the origin-substitution basis).

**Migration:** legacy flows with `domains?: string[]` but no `profiles` are migrated in memory on load (`migrateDomainsToProfiles()`), no disk write; any resulting `domain` profile var is now ignored by origin substitution (which reads the project env var).

**Code generation:** profile vars emit as `const _ftProf_key = '...'` at top of spec. Goto URLs whose origin matches `flow.baseURL` are emitted with the active environment's `domain` **baked in as a literal** (`await page.goto('<domain>/path')`) — export is environment-specific; there is no `_ftProf_domain` reference.

**UI:** Toolbar `⚙` profile selector → dropdown → "管理配置…" opens `ProfileEditorModal`. Right sidebar `ProfileVarList` (amber) shows the active profile's vars; click to copy `{{key}}`.

### Projects & Environments system

Projects add a layer **above** flows for managing environment-specific variable values. A `Project` has named `environments` (e.g. `DEV` / `UAT` / `PRD`) plus project-level `envVars?: ProjectEnvVar[]`; a `Flow` joins a project via `projectId`. **Every flow belongs to a project**: a flow with no (or an unknown) `projectId` is treated as belonging to the reserved default project `未分類` (`DEFAULT_PROJECT_ID = '__default__'`, normalized via `?? DEFAULT_PROJECT_ID` everywhere), which cannot be deleted or renamed and is pinned to the bottom of `FlowList`.

- **Every project has ≥1 environment.** `createProject(name, envName='DEV', domain=DEFAULT_DOMAIN)` seeds one environment plus a `domain` env var. `未分類` is materialized on disk by `ProjectStorage.ensureDefault()` (called from `list()`/`load()`) with a `DEV` env and `domain = 'http://localhost:3000/'` — this gives its environment a **stable id**.
- **`domain` is a reserved project env var** (`DOMAIN_ENV_KEY = 'domain'`, constants in `types.ts`): seeded into every project, **non-deletable and non-renamable** in `ProjectEnvVarModal` (rendered with a 🔒 lock). Its per-environment value drives goto-URL origin substitution in `Replayer` and `ScriptExporter` (trailing slash stripped).
- A `ProfileVariable` can carry `envValues: Record<envId, string>` — per-environment overrides of its base `value`. Resolution everywhere is `envValues[activeEnvironmentId] ?? value`; profile values may reference project env vars via `{{key}}`.
- `ProjectEnvVar` = `{ key, values: Record<envId, string>, description? }`, flattened for the active environment by `flattenProjectEnvVars`.
- The **active environment** (`activeEnvironmentId` in the store) + **active project** (`activeProjectId` = `currentProject.id`) are threaded through replay, branch recording, and export, and used by `Replayer`/`ScriptExporter`/`usePlaywright`/`Toolbar` when building `profileVars`/`envVars`. Env-var references resolve only when the flow belongs to the active project (v1: no cross-project references).
- Storage: projects live as `projects/{id}.json` (`ProjectStorage`), separate from flows.
- Store actions: `createProject`, `renameProject`, `duplicateProject`, `deleteProject`, `addEnvironmentToProject`, `renameEnvironment`, `duplicateEnvironment`, `deleteEnvironment` (the last environment can't be removed), `assignFlowToProject`, `setActiveEnvironment`, `setCurrentProject`, and `commitProjectEnvVars(rows, envId)` — one atomic write for the whole env-var table (see Editing model). `openFlow` loads the owning project (default if none) and picks a sensible active environment (first env by default).
- **UI:** `FlowList` groups flows by project (📁 headers, 未分類 last); the "新增專案" dialog collects 專案名稱 + 環境名稱 (DEV) + domain. The "新增流程" dialog collects 歸類至專案 (first) + 流程名稱 (second) — there is **no 目標URL field** (baseURL is derived from the project's `domain`). The Toolbar shows a 🌐 environment selector (with inline 新增環境) and "🔧 管理環境變數…" (`ProjectEnvVarModal`) for the current flow's project; the modal also handles environment add/rename/duplicate/delete. The right sidebar's `ProjectEnvVarList` shows the active environment's project vars.

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
- **`positionsFinalized`**: `fn.position` is the single source of truth for rendering. On first load of a flow whose positions were never finalized, `FlowCanvas` calls `materializeLayout()` (writes computed positions into the store, marks finalized, persists). `relayoutAll()` ("🧹 整理節點") recomputes unconditionally. Manual drags update `position` via `updateNode` with a **500 ms debounced** disk save, run through `runWithoutHistory` so repositioning doesn't flood undo history. The debounce captures the flow object at schedule time and is flushed on unmount / flow switch, so a drag followed by a quick flow switch isn't lost.
- **Editing**: drag node handles to `connectNodes` (rejects if target already has a parent); delete edges to `disconnectNodes`; context-menu `disconnectNode` detaches a node from both parent and children (each becomes a floating root); `deleteNode` removes a node + subtree; `deleteNodesOnly` removes nodes but re-parents survivors as floating roots. Multi-select (Shift) drives extract/group/bulk-delete/bulk-disconnect.
- **Pane context menu**: right-clicking empty canvas offers **加入節點** → `AddNodeModal` (currently `code` nodes only), which calls `addNodeAt(action, position)` to drop a floating node at the clicked canvas coordinates.

### Visual groups (in-place, canvas-only)

`FlowGroup` collapses a contiguous, single-entry/single-exit selection into one canvas node — **without** creating a separate Flow. Membership is `FlowNode.groupId`. `src/renderer/utils/groups.ts`:
- `getGroupBoundary()` resolves member set + entry/exit; `groupBoxRect()` computes the drawn frame.
- `computeGroupAwareLayout()` treats each group as one synthetic node in the outer tree (sized to its box footprint when expanded), then positions members inside the reserved box (expanded) or at the entry's slot (collapsed).
- Store: `createGroup`, `toggleGroupCollapsed`, `ungroupGroup` (each re-runs group-aware layout and persists). Rendered by `GroupNode` (collapsed pill) and `GroupBox` (expanded frame). Edges into a collapsed group are routed through its `group:<id>` node.

### Undo/Redo

**Undo/redo covers the canvas node graph and nothing else.** `flowStore` keeps `past[]` / `future[]` of `Flow` snapshots (cap `HISTORY_LIMIT = 50`). A single `useFlowStore.subscribe` records the previous `currentFlow` whenever an edit replaces it with a new object of the same id — skipping when `isTimeTraveling`, `historySuppressed()`, a flow switch, or live recording/replay.

**Covered:** add / delete node / delete subtree / delete-nodes-only, connect + disconnect edges, disconnect node, create + ungroup group, `relayoutAll`, insert/append callFlow, extract sub-flow, PropertyPanel commits.

**Deliberately NOT covered — off-canvas configuration.** A Ctrl+Z here would silently revert data the user cannot see (the commit actions are atomic, so a single press would restore a *whole* variable table). These are protected by delete confirmations instead:
- **Session variables** (`captureAs`) — suppressed at both call sites, `SessionVarList` 🗑 *and* the canvas context menu, so the same variable behaves identically wherever it's touched.
- **Environment profiles** — `addProfile` / `updateProfile` / `deleteProfile` / `duplicateProfile` / `commitProfileVars`.
- **Projects** — `currentProject` is not watched at all, so environments, project env vars and project rename never enter history.
- **Flow metadata** — `renameCurrentFlow`, `assignFlowToProject`.

> **Rule: any store action that writes flow CONFIG must go through `setSilently`.** The subscription's `graphChanged(cf, pf)` check (`nodes` / `rootNodeId` / `groups` reference comparison) is only a safety net for *config-only* writes. It cannot catch the profile actions, which also rewrite `nodes` to maintain callFlow `subFlowProfileMapping` — those need the explicit suppression.

- **Suppression** is a depth counter (`suppressDepth`), not a boolean, so nested scopes can't lift it early. `runWithoutHistory(fn)` and `runAsOneHistoryStep(fn)` are **synchronous only** — keep `await saveFlow(...)` outside the callback. `setSilently(partial)` applies a state change without recording — used by `toggleGroupCollapsed` (pure view state), `materializeLayout` (automatic one-time layout), and every config write above. `relayoutAll` stays undoable: it's an explicit user action.
- **One gesture = one undo step.** `runAsOneHistoryStep(fn)` suppresses during `fn` then pushes a single pre-batch snapshot. Used by multi-select disconnect, multi-edge delete, insert-callFlow + relayout, and FlowList's "加入當前流程中" (add node + position).
- **`undo`/`redo`** refuse to restore when the snapshot's flow id no longer matches the open flow.

`useUndoRedo` binds Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (ignored while typing in inputs or during recording/replay). Toolbar exposes ↶ 復原 / ↷ 重做 buttons.

### Editing model (local state → 儲存)

Every **text / form field** edits component-local `useState` and reaches the store only when 儲存/確認 is pressed. One save = one store write = one disk write = one undo entry (when in scope). **Single-gesture controls stay instant**: profile/environment dropdowns, replay speed, node drag, edge connect/disconnect, group collapse/expand.

**There is no dirty tracking and no unsaved-changes prompt.** Switching node / flow / profile / environment, or closing a modal, silently reloads the fields from the store and drops whatever was typed but not saved. This is deliberate — the previous draft-guard layer (`useDraftForm` / `ensureNoUnsavedDrafts` / `confirmDiscard` / `DirtyBadge`) was removed because it fired on state the user never touched (e.g. a callFlow node's asynchronously-seeded profile mapping) and blocked node selection. Do not reintroduce it.

- **Where the fields live** — `PropertyPanel` (six `useState` fields, re-synced by a `useEffect` keyed on **`selectedNodeId` only**, never on the node object: a node drag or a recorder `ACTION_UPDATED` replaces that object and would otherwise wipe in-progress typing). `ProfileEditorModal` / `ProjectEnvVarModal` hold a local `rows` array re-loaded by a `useEffect` keyed on `flow:profile:env` / `project:env`, plus a local `error` for validation.
- **Saving re-reads the store.** `PropertyPanel`'s save pulls the node fresh from `useFlowStore.getState()` before `updateNode`, so recorder-written fields (`opensPage`, `pageAlias`, `framePath`, `clickCount`…) are never clobbered by what the panel is holding.
- **Row identity** — table rows carry `_rid` (stable client id; also the key of ProfileEditorModal's value-input caret map) plus `_origIndex` (ProfileEditorModal) / `_origKey` (ProjectEnvVarModal), which `commitProfileVars` / `commitProjectEnvVars` need to tell added rows from edited ones and to carry other environments' values across a rename. One 儲存 commits the whole table.
- **Validation runs in the save handler** — empty key / duplicate key (both tables) and "`domain` must survive" (project env vars); failures set `error` and abort the write.
- **`src/renderer/stores/confirmStore.ts` + `components/common/ConfirmDialog.tsx`** — `confirm()` raises an app-styled dialog from `<ConfirmHost />` (mounted once in `App.tsx`, `zIndex 4000` so it can appear above modals). Replaces `window.confirm` entirely. Danger dialogs put Enter on 取消.
- **Destructive actions all confirm** — delete flow / project / environment / profile / profile variable / project env var / session variable, and duplicate project. **Deliberate exception: deleting a node (or node + subtree) does not confirm** — it's a high-frequency editing gesture and Ctrl+Z restores it. Ungroup likewise (destroys no node data, and is undoable).

### Storage

- Flows: `flows/{flowId}.json` (dev: `process.cwd()/flows`; prod: `app.getPath('userData')/flows`). `FlowStorage.list()` also computes each flow's `refCount` by scanning all callFlow nodes.
- Projects: `projects/{projectId}.json` (`ProjectStorage`).
- Upload fixtures: copies of picked files under `fixtures/` (`FixtureStorage`), referenced from upload nodes as `fixtures/<file>`.
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
| `src/main/ipc/ipcHandlers.ts` | Central orchestrator — all 22 Renderer→Main channel handlers; holds singleton BrowserController/Recorder/Replayer; `hasCallFlowCycle()` + `killProcessOnPort()` |
| `src/main/playwright/browserController.ts` | Wraps playwright-core chromium: launch, context, page, auto-cleanup on disconnect |
| `src/main/playwright/recorder.ts` | Thin wrapper around CodegenCapture; tracks recording state; pause/resume; assertion-pick entry |
| `src/main/playwright/codegenCapture.ts` | Multi-page recorder: injects scripts (initScript + DOM capture + cursor + assertion dock, top-frame UI via `topFrameOnly`), exposes report/assert/locator-resolved functions, filters navigation, buffers input clicks + dblclick merge, assigns page aliases & `opensPage` (incl. `ACTION_UPDATED` retro-patch), builds iframe `framePath` chains, imports upload paths over CDP, drives in-browser locator picker |
| `src/main/playwright/actionCapture.ts` | Single-page variant of CodegenCapture (supports stop/restart without re-injection; not active in main flow) |
| `src/main/playwright/captureShared.ts` | Shared utilities: extracts InjectedScript from coreBundle.js, DOM event capture (blacklist, Shadow DOM-aware), locator builder, nav-suppression logic, assertion dock + pick overlay scripts, in-browser locator-picker script, cursor highlight, `buildAction` |
| `src/main/playwright/replayer.ts` | Action/assertion execution; parentId-chain path traversal; fires REPLAY_NODE_* events; constructor `(page, baseURL, profileVars?, activeProfileId?, activeEnvironmentId?, envVars?, activeProjectId?, sharedPages?)`; `pageFor`/`scopeFor` resolve `pageAlias` + `framePath`; `substituteOrigin` swaps goto origin for the project env var `domain`; `buildCodeVars` backs `code` nodes; resolves subFlowProfileMapping + envValues for callFlow at any depth |
| `src/main/storage/flowStorage.ts` | Flow CRUD; `list()` computes `refCount`; sorts by updatedAt |
| `src/main/storage/fixtureStorage.ts` | Upload fixtures: `dataRoot()`, `importFile()` (copy into `fixtures/`, content-hash suffix on name collision), `toAbsolute()` |
| `src/main/storage/projectStorage.ts` | Project CRUD under `projects/`; `ensureDefault()` materializes the reserved `未分類` project (DEV env + `domain`) with a stable env id; `delete()` protects `__default__` |
| `src/main/storage/scriptExporter.ts` | Path computation + `.spec.ts` / `-helpers.ts` codegen; emits `_ftProf_*` decls; bakes each flow's active-env `domain` literal into matching gotos (`resolveFlowDomain`, per-step `domain`); threads activeProfileId/activeEnvironmentId/envVars/activeProjectId through recursive sub-flow expansion; hoists captureAs vars in useTestStep mode; `filter({ hasText })` for session-var assertText; emits `waitForEvent('popup')` for `opensPage`, `.contentFrame()` chains for `framePath`, `dblclick` for `clickCount>=2`, and a `const vars = {…}` preamble for `code` nodes |
| `src/shared/types.ts` | All shared types + `IPC_CHANNELS`; `isCallFlowAction` guard; `REPLAY_SPEED_MS`; `DEFAULT_PROJECT_ID`/`DEFAULT_PROJECT_NAME`/`DOMAIN_ENV_KEY`/`DEFAULT_ENV_NAME`/`DEFAULT_DOMAIN` |
| `src/shared/variableResolver.ts` | Variable system: 5 built-ins, `flattenProjectEnvVars`, `resolveValue(WithSession)`, `valueToCodeExpr`, `sessionAwareValueToCodeExpr`, `locatorExprToCode`, `emitProfileVarDecls` / `emitEnvVarDecls` (`_ftProf_` / `_ftEnv_` prefixes), `VARIABLE_HELPERS_CODE` |
| `src/preload/index.ts` | contextBridge — exposes typed `window.electronAPI` (incl. project + report + locator-pick wrappers) |
| `src/renderer/App.tsx` | Root — calls `usePlaywrightEvents()` + `useUndoRedo()`; renders Toolbar + FlowList + FlowCanvas + PropertyPanel + right sidebar (VariableList / ProfileVarList / ProjectEnvVarList / SessionVarList, shown only when a node is selected) |
| `src/renderer/stores/flowStore.ts` | Zustand store — flow/node/profile/project/environment state + actions; node-graph-only undo/redo (`Flow[]` snapshots, `graphChanged` guard, `runAsOneHistoryStep`) + history subscription; `suppressDepth`/`setSilently`; atomic `commitProfileVars` / `commitProjectEnvVars`; group actions; layout actions; domain + callFlow-profile migrations |
| `src/renderer/stores/confirmStore.ts` | `confirm()` — promise-based replacement for `window.confirm` |
| `src/renderer/components/common/ConfirmDialog.tsx` | `ConfirmHost` — renders queued confirm requests (zIndex 4000, Enter defaults to 取消 on danger) |
| `src/renderer/components/Toolbar/Toolbar.tsx` | Action bar: new-flow, undo/redo, record/stop, relayout, export, run-tests, replay-speed, environment selector (🌐), profile selector (⚙), status pills; new-flow dialog (歸類至專案 + 流程名稱, no 目標URL) |
| `src/renderer/components/Toolbar/TestOutputModal.tsx` | Streams live `TEST_OUTPUT` lines during `RUN_TESTS` |
| `src/renderer/components/Canvas/FlowCanvas.tsx` | ReactFlow canvas (Background / Controls / MiniMap): node/edge derivation (incl. groups), drag-reposition with debounced save, connect/disconnect, multi-select, node + pane context menus, modals (CallFlow / ExtractSubflow / GroupName / AddNode); one-time layout materialization |
| `src/renderer/components/Canvas/ActionNode.tsx` | Custom node: type icon/color, description, selector, replay-status border, page-nav border, callFlow profile badge |
| `src/renderer/components/Canvas/GroupNode.tsx` | Collapsed-group node (expand on click) |
| `src/renderer/components/Canvas/GroupBox.tsx` | Expanded-group background frame with collapse / ungroup controls |
| `src/renderer/components/Canvas/GroupNameModal.tsx` | Name prompt when forming a group |
| `src/renderer/components/Canvas/BranchEdge.tsx` | Custom bezier edge with optional branch-label badge |
| `src/renderer/components/Canvas/NodeContextMenu.tsx` | Node context menu: replay, branch-record, group/extract (multi-select), insert/append callFlow, capture-as variable, disconnect, delete-only, delete+subtree |
| `src/renderer/components/Canvas/CanvasStatusBar.tsx` | Multi-select status banner |
| `src/renderer/components/Canvas/ExtractSubflowModal.tsx` | Name + confirm dialog for extracting a selection into a sub-flow |
| `src/renderer/components/FlowList/FlowList.tsx` | Sidebar: flows grouped by project (未分類 = reserved default, pinned last, no rename/delete); collapsible 子流程 subsection (refCount>0); right-click menu (move project / rename / duplicate / delete / add as sub-flow); new-project dialog (name + 環境名稱 + domain) + rename dialogs |
| `src/renderer/components/PropertyPanel/PropertyPanel.tsx` | Bottom panel: edit description/selector/locator/value for selected node; assertText/assertValue value fields; callFlow "配置對應" mapping grid (loads sub-flow profiles via `FLOW_GET`). Local `useState` fields re-synced on `selectedNodeId` only, written by the 儲存 button (which re-reads the node from `getState()`); empty fields save as empty |
| `src/renderer/components/ProfileEditor/ProfileEditorModal.tsx` | Two-column modal: profile list (add/rename/delete) + local variable table (key synced across profiles; value/description per-profile) committed by 儲存 via `commitProfileVars`; rename commits on ✓/Enter only |
| `src/renderer/components/ProjectEnvVar/ProjectEnvVarModal.tsx` | Project-level env-var editor — local table (one key per row, value per selected environment) committed by 儲存 via `commitProjectEnvVars`; environment add/rename/duplicate/delete; `domain` row is key-locked and non-deletable (🔒) |
| `src/renderer/components/ProjectEnvVar/ProjectEnvVarList.tsx` | Sidebar: active project's env vars resolved for the active environment; click to copy `{{key}}` |
| `src/renderer/components/AddNodeModal/AddNodeModal.tsx` | 加入節點 dialog — code editor (`page` / `expect` / `vars` in scope) with a click-to-copy list of every available variable grouped by origin |
| `src/renderer/components/CallFlowModal/CallFlowModal.tsx` | 2–3 step modal to embed a sub-flow: select flow (cycle-checked) → exit node → profile mapping |
| `src/renderer/components/LocatorPickerModal/LocatorPickerModal.tsx` | **Legacy** — Cell-vs-Row picker (now rendered in-browser by CodegenCapture) |
| `src/renderer/components/VariableList/VariableList.tsx` | Sidebar: 5 built-in variables; click to copy |
| `src/renderer/components/ProfileVarList/ProfileVarList.tsx` | Sidebar: active profile's variables (amber); click to copy `{{key}}` |
| `src/renderer/components/SessionVarList/SessionVarList.tsx` | Sidebar: session variables from `captureAs` nodes; click to copy, trash to delete |
| `src/renderer/hooks/usePlaywrightEvents.ts` | IPC event subscriptions: ACTION_CAPTURED, ACTION_UPDATED, ACTION_REMOVED, REPLAY_NODE_*, REPLAY_FINISHED/ERROR, ASSERTION_PICK_CANCELLED, LOCATOR_PICK_NEEDED |
| `src/renderer/hooks/usePlaywright.ts` | IPC invocation wrappers: startRecording (navigates to the active env's `domain`, persists it as `flow.baseURL`), startBranchRecording, stopRecording, replayToNode (builds env-aware profileVars + envVars) |
| `src/renderer/hooks/useUndoRedo.ts` | Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z keyboard shortcuts |
| `src/renderer/hooks/useRecording.ts` | Branch-recording state helpers |
| `src/renderer/hooks/useFlowStore.ts` | `useFlowManager`: refreshFlowList/refreshProjectList, openFlow (+ loads project), newFlow, deleteCurrentFlow |
| `src/renderer/utils/treeLayout.ts` | Tree layout: `computeTreeLayout`, `computeAllRootsLayout`, sizing constants, `SizeOf` |
| `src/renderer/utils/groups.ts` | Group geometry + `computeGroupAwareLayout` |
| `src/renderer/utils/subflowExtraction.ts` | `validateExtraction` (single entry/exit, connected) + `extractSubflow` (build sub-flow, rewire parent) |
| `src/renderer/types/electron.d.ts` | TypeScript declaration for `window.electronAPI` |
| `electron.vite.config.ts` | Build config for all three bundles + path aliases |
| `playwright.config.ts` | Generated-spec runner config (`testDir: './exports'`, headless: false, HTML report) |
| `electron-builder.yml` / `package.json#build` | Installer config |
