# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**FlowTest** is an Electron desktop app that records user interactions as a visual branching flow graph, then generates Playwright `.spec.ts` test suites. The core innovation is "branch recording": silently replay to any previously-recorded node, then continue recording from that exact browser state — turning a 30-step flow into 5 new steps when testing a different path.

Beyond recording, the app is a full visual flow editor: drag-to-reposition, drag-to-connect/disconnect nodes, multi-select, undo/redo, collapsible visual groups, sub-flow extraction/embedding, environment profiles, project-level environment overrides, and hand-written `code` nodes as an escape hatch for anything recording can't express.

All of that data lives in a **workspace** — one folder the user picks, which they drop inside their own repo so their git versions the test data and separate repos stay isolated. See "The workspace" below; it is the first thing to understand, because nothing in storage resolves a path without it.

## Project Stage

**This project is currently in MVP development.** Existing on-disk data (flows, projects) does **not** need to be preserved or migrated — feel free to change data shapes, defaults, and storage formats without backward-compatibility shims or migration code. Don't add or retain migration logic solely to protect old data; optimize for a clean design.

## Commands

```bash
npm run dev       # Start Electron app with hot-reload (electron-vite dev)
npm run build     # electron-vite build (main + preload + renderer)
npm run preview   # Preview production build
npm run dist      # Build + create platform installers (electron-builder)
```

No lint or test scripts are defined. Typecheck with `npx tsc --noEmit` — it covers all three bundles and is the closest thing to a test gate.

Generated specs are run by the app itself, through the **bundled** `@playwright/test` (see Test execution pipeline) — not `npx`. They remain plain Playwright specs, so a user whose repo has Playwright installed can also run them directly with `npx playwright test`.

## Architecture

This is an **Electron multi-process app** with three distinct bundles (built by `electron-vite`):

```
Main Process (Node.js)         Preload Bridge         Renderer (React)
──────────────────────         ──────────────         ────────────────
ipcHandlers.ts                 preload/index.ts       App.tsx
  ├── BrowserController          contextBridge          ├── WelcomeScreen (no workspace)
  ├── Recorder                   window.electronAPI     └── Toolbar/FlowList/Canvas/PropertyPanel
  ├── Replayer                                          Zustand stores (flowStore, workspaceStore)
  ├── CodegenCapture                                    Hooks (usePlaywright, usePlaywrightEvents,
  ├── runner (bundled Playwright CLI)                         useWorkspace, useUndoRedo, useFlowStore)
  ├── browserCheck                                      Canvas utils (treeLayout, groups, subflowExtraction)
  ├── workspace ◄── every path below resolves through this
  ├── FlowStorage
  ├── ProjectStorage
  ├── FixtureStorage
  └── ScriptExporter
```

`src/main/index.ts` is the Electron entry point: it **awaits `loadSettings()` before creating the window** (the renderer asks for the workspace on mount, and storage throws until one is set), creates the BrowserWindow (1280×800, contextIsolation on, nodeIntegration off), calls `registerIpcHandlers(win)`, and relays `focus` as `WORKSPACE_RELOAD`.

### IPC as the central seam

`src/main/ipc/ipcHandlers.ts` is the **only file** that coordinates Main process modules. All Renderer ↔ Main communication goes through `IPC_CHANNELS` constants defined in `src/shared/types.ts`. The preload bridge (`src/preload/index.ts`) exposes `window.electronAPI` with typed wrappers for every channel.

Renderer → Main: `window.electronAPI.<method>()` → `ipcMain.handle(channel, ...)`
Main → Renderer: `win.webContents.send(channel, payload)` → `usePlaywrightEvents` / `Toolbar` hooks

Singletons `browserController`, `recorder`, `replayer` are module-level in `ipcHandlers.ts`. Recording **always relaunches the browser** (Playwright's `_enableRecorder` can only be called once per context).

### Key data types (`src/shared/types.ts`)

- **`ActionType`** — 14 variants: `goto | click | fill | selectOption | check | uncheck | press | upload | wait | assertVisible | assertText | assertValue | callFlow | code`
- **`Action`** — one browser interaction: `type`, `locatorExpr` (high-quality Playwright locator), `selector` (CSS fallback), `value`, `captureAs` (optional session variable name), `description`, `url`, `isPageNavigation`. Type-specific fields:
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
- **`ResolutionContext`** — the context every `{{...}}` placeholder is resolved under, shared verbatim by replay, branch recording, export and test runs; every field is optional. `profileVars?` (active profile's flat key-value map), `activeProfileId?`, `activeEnvironmentId?`, `envVars?` (flattened project env vars for the active env), `activeProjectId?`, `secretEnvKeys?` (codegen only). It travels as **one object**, never as five positional parameters — assembled in exactly one place (`buildResolutionContext` in `renderer/utils/varMaps.ts`) and decrypted in exactly one place (`decryptContext` in `ipcHandlers.ts`). There is no separate `ExportConfig`; specs always go to `<workspace>/exports` and always wrap each step in `test.step`, so neither is configurable.
- **`RecordingStartPayload`** — `baseURL`, optional branch-recording fields (`branchFromNodeId`, `branchNodes`, `replaySpeed`), `ctx?: ResolutionContext` (only the branch-recording silent replay reads it)
- **`ReplayToNodePayload`** — `nodes`, `targetNodeId`, `speed`, `baseURL?`, `ctx?: ResolutionContext`
- **`ExportScriptsPayload`** — `{ flow, ctx }`
- **`LocatorOption`** — one Cell-vs-Row locator alternative for repeated table/list items
- **`ActionUpdatedPayload`** — `{ actionId, updates: Partial<Action> }` — retroactively patches an already-captured action (used when a popup arrives after its triggering click was emitted)

### IPC channels (`src/shared/types.ts` → `IPC_CHANNELS`)

**Renderer → Main (32):** `RECORDING_START`, `RECORDING_STOP`, `REPLAY_TO_NODE`, `FLOW_SAVE` (accepts `touch?: boolean`), `FLOW_LOAD`, `FLOW_LIST`, `FLOW_DELETE`, `FLOW_GET` (one flow JSON by ID), `FLOW_CHECK_CYCLE` (validate adding a callFlow won't create a circular reference — recursively walks the sub-flow's callFlow graph), `EXPORT_SCRIPTS`, `RUN_TESTS`, `SHOW_REPORT` (bundled CLI `show-report`; kills any process on port 9323 first), `PROJECT_SAVE`, `PROJECT_LOAD`, `PROJECT_LIST`, `PROJECT_DELETE`, `PICK_FILES` (native open dialog; copies picks into `fixtures/` and returns their stored paths), `NORMALIZE_PATHS` (rewrite absolute paths as workspace-relative), `WORKSPACE_GET` (also reports `hasChromium` — there is no separate browser-check channel), `WORKSPACE_PICK` (native folder dialog → validate → scaffold → open), `WORKSPACE_SET` (open a remembered path), `WORKSPACE_FORGET`, `WORKSPACE_REVEAL` (`shell.openPath`), `BROWSER_INSTALL` (`playwright install chromium`, output over `TEST_OUTPUT`), `VAULT_STATUS`, `VAULT_SETUP`, `VAULT_UNLOCK`, `VAULT_LOCK`, `VAULT_CHANGE_PASSPHRASE`, `SECRET_ENCRYPT`, `SECRET_REVEAL`, `SECRETS_FILE_WRITE`

There is **no browser lifecycle channel** (`BROWSER_LAUNCH` / `BROWSER_CLOSE`), **no replay-stop channel**, and **no assertion-pick or locator-pick channel**: the browser is launched implicitly by `RECORDING_START` / `REPLAY_TO_NODE`, replay cannot currently be cancelled (see A2 in the cleanup backlog), and both pickers now run entirely in-browser.

**Main → Renderer (10):** `ACTION_CAPTURED`, `ACTION_UPDATED` (retro-patch fields of an already-emitted action — e.g. stamping `opensPage` when the popup arrives late), `ACTION_REMOVED` (un-record a node — the click that opened a file chooser), `REPLAY_NODE_START`, `REPLAY_NODE_COMPLETE`, `REPLAY_FINISHED`, `REPLAY_ERROR`, `TEST_OUTPUT`, `TEST_FINISHED`, `WORKSPACE_RELOAD` (window regained focus — the workspace may have changed on disk)

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

- Paths are stored **relative to the workspace** (`fixtures/cat.jpg`), which is also the cwd `RUN_TESTS` spawns Playwright in — so exported specs travel with the repo. `FixtureStorage.toAbsolute()` resolves them for `Replayer` (the main process cwd is *not* the workspace). Absolute paths still pass through at replay time, but `normalizeStoredPath()` rewrites them on save, so they should not survive into stored actions.
- **The click that opened the chooser is dropped.** It is unreplayable: the input is hidden behind a styled trigger, Chromium reports `input[type=file]` itself as role=button carrying the trigger's label, so the recorded click either waits forever on an invisible element or matches both — and `setInputFiles` never needed it. The DOM script's `findTriggerSelector()` anchors on the input that actually received files and walks **up** ≤3 levels looking for the last-clicked element (anchoring the other way would mis-flag a click on any container that happens to enclose an upload widget); `dropTriggerClick()` then either discards the still-buffered click or, if it already reached the canvas, sends `ACTION_REMOVED` so the renderer deletes that node and moves `recordingHeadId` back to its parent. **`ACTION_REMOVED` must precede the upload's `ACTION_CAPTURED`** — `deleteNode` takes the subtree with it. A visible button that opens the chooser via JS isn't detectable this way and is correctly kept; `Replayer.suppressFileChooser()` plus an emitted `page.on('filechooser', () => {});` stop it stalling a run.
- **Chooser suppression is scoped to one replay run and must be released.** Playwright enables `Page.setInterceptFileChooserDialog` on the *first* `filechooser` listener and disables it when the last one is removed, so a leftover listener silently swallows the chooser forever — and branch recording silently replays on the very page it then records on, which made "click upload, nothing happens". `replayToNode` releases its own listeners in a `finally` (`suppressedPages` + a shared `swallowFileChooser` reference, so a nested call-flow replayer can't lift the outer run's suppression).
- **Locators must stay tag-qualified.** These widgets routinely give the trigger and the hidden input the same id, so `qualifyFileInputLocator` emits `input#id` / `input[name=…]`, never a bare `#id`. For nodes recorded before that, `Replayer.resolveFileInput()` narrows at runtime (`base.and(input[type=file])` → descendant → base → the page's only file input) and `ScriptExporter` emits the same `.and(…)` narrowing when the locator isn't already input-scoped.
- Drag & drop uploads fire no chooser and keep bare names — `ActionNode` shows a red ⚠ 缺少檔案路徑 badge, and PropertyPanel's 📂 選擇檔案… button (`PICK_FILES`) fills them in.

### In-browser locator picker (Cell vs Row)

When a recorded click hits a repeated table/list item with `alternativeLocators`, `CodegenCapture.showLocatorPicker()` pauses recording and renders a "選擇 Locator 方式" modal **inside the recorded browser** (`getLocatorPickerScript`). On confirm, `__flowtest_locator_resolved(index)` finalizes the Action with the chosen locator. This path uses no IPC and no renderer modal — the former `LocatorPickerModal` / `LOCATOR_PICK_NEEDED` / `LOCATOR_PICK_RESOLVED` slice has been removed.

### Assertion-picking pipeline

Assertion picking is driven by an **in-browser dock** injected during recording (`getAssertionToolbarScript`), not by Toolbar buttons:

1. A fixed dock on the right edge of the recorded browser shows 👁 可見 / T 文字 / = 值 buttons (dock id `__ft_assert_toolbar`, so its clicks are blacklisted from recording)
2. Clicking a button runs `window.__ft_startAssertPick(type)` — a transparent overlay highlights the element under the cursor and shows its locator in a tooltip
3. On click, `__flowtest_assert_report` emits an assertion action (`assertVisible` / `assertText` / `assertValue`) via `ACTION_CAPTURED`; Escape cancels via `__flowtest_assert_cancel`

The dock is the only entry point — the old `START_ASSERTION_PICK` IPC path has been removed. `__flowtest_assert_cancel` is still registered as a no-op binding: the in-page Escape handler calls it, and the dock restores its own UI, so the Node side has nothing to do but must not be missing.

### Replay pipeline

`Replayer.replayToNode()` walks `parentId` pointers from the target node up to the root (cycle-guarded) to build an ordered path, then executes each `Action` sequentially. A yellow cursor-highlight dot is injected (`getCursorHighlightScript`). `assertVisible` / `assertText` / `assertValue` are ordinary action types executed by `executeAction` via Playwright's `expect` (`toBeVisible` / `toContainText` / `toHaveValue`, 10 s timeout) — semantics deliberately mirror `ScriptExporter.actionToCode` so replay and the exported spec agree. Each step fires `REPLAY_NODE_START` / `REPLAY_NODE_COMPLETE` to drive canvas status badges.

Each action resolves its target through two hops: `pageFor(action)` picks the page by `pageAlias` (relaunching a closed one is not possible — a missing page is an error), then `scopeFor(action)` folds `framePath` into `.contentFrame()` hops. `getLocator()` evaluates `locatorExpr` against that scope with `new Function`, falling back to `scope.locator(selector)`. Clicks honour `button` / `modifiers` / `clickCount` (≥2 → `dblclick`); `selectOption` prefers `values[]`; `press` uses `keyboard.press()` when there is no locator; `code` nodes run through `AsyncFunction` with `(page, expect, vars)`.

`Replayer` constructor: `(page, baseURL = '', ctx: ResolutionContext = {}, sharedPages?)` — the whole resolution context arrives as one object, normalized so `ctx.profileVars` / `ctx.envVars` are never undefined. The **project environment variable** `domain` (`ctx.envVars['domain']`, trailing slash stripped) drives goto URL origin substitution — if a goto URL's origin matches `baseURL`'s origin, it is replaced with that domain. `ctx.activeProfileId` + `ctx.activeEnvironmentId` let the replayer resolve `subFlowProfileMapping` and `envValues` on `callFlow` nodes at any nesting depth; `ctx.activeProjectId` gates env-var resolution to the active project. `executeCallFlow()` loads the sub-flow, resolves its profile, and builds a nested `Replayer` with a **derived context** (`{...this.ctx, profileVars: subProfileVars, activeProfileId: subProfile?.id, envVars: subFlowEnvVars}` — the last one same-project-gated), then merges captured session vars back up.

### Branch recording pipeline

When the user picks "從此節點分支錄製" from node N's context menu:
1. `startBranchRecording(N)` sets `recordingHeadId = N`, passes `branchFromNodeId: N` + `branchNodes` + `ctx` (from `buildResolutionContext`) in `RecordingStartPayload`
2. Main process relaunches the browser, then silently replays from root → N using a `Replayer` (200 ms/step default, no UI events)
3. `Recorder.start()` begins WITHOUT navigating to `baseURL` — browser is already at N's page state
4. New actions append as children of N; `recordingHeadId` tracks the last-added node so subsequent actions chain correctly

### Test execution pipeline

1. User clicks "▶ 執行所有測試" → `RUN_TESTS` IPC (with `ResolutionContext`)
2. Main runs `ScriptExporter.export()` to write `.spec.ts`, then runs the **bundled** Playwright CLI (`src/main/playwright/runner.ts`)
3. stdout/stderr stream line-by-line via `TEST_OUTPUT` → `TestOutputModal` shows live output
4. On exit, `TEST_FINISHED` fires. The HTML report is opened separately via `SHOW_REPORT` (`showReport()`), which kills any process on port 9323 first.

**`npx playwright test` is deliberately not used.** It only ever worked by accident: Playwright walks *up* from the cwd looking for a config, which in dev happened to land on this repo's own `playwright.config.ts` and `node_modules`. Once the data root is an arbitrary folder in the user's project, their repo may carry a config that silently hijacks the run, and almost certainly has no `@playwright/test` — leaving npx to download an arbitrary version, or fail offline. `resolvePlaywrightCli()` therefore resolves `@playwright/test/cli` from our own `node_modules` and `runPlaywright()` spawns it with:

- `process.execPath` + **`ELECTRON_RUN_AS_NODE=1`** — our own binary as a plain Node interpreter, so the user needs no Node installation.
- **`NODE_PATH`** = our `node_modules`. Shipping the CLI is *not* sufficient on its own: the generated config and every generated spec do `import ... from '@playwright/test'`, and Node resolves that by walking up from *the importing file* — i.e. the user's workspace, which has no `node_modules`. Without this the run dies with `MODULE_NOT_FOUND`.
- **`--config <workspace>/playwright.config.ts`** — explicit, so a config higher up the user's tree cannot take over.
- `cwd` = the workspace, which is what lets fixture paths stay relative (`ScriptExporter` writes `fixtures/…` verbatim into the spec).
- `PLAYWRIGHT_HTML_OUTPUT_DIR=.flowtest/playwright-report` — beats the config file, so `SHOW_REPORT` can find the report without parsing whatever config an adopted folder happens to carry.

Resolution failure is reported plainly rather than falling back to npx — a silent fallback only makes version problems harder to diagnose. `@playwright/test` is therefore a **dependency** (not devDependency) and is `asarUnpack`ed, since spawn cannot execute out of the asar archive; it is pinned to the same exact version as `playwright-core` so recording and running agree on a browser revision.

`browserCheck.ts` reports a missing browser by scanning `ms-playwright/` for any `chromium*` directory. It deliberately does **not** use `chromium.executablePath()`, which is revision-pinned and would cry "not installed" on every launch for a machine carrying a perfectly usable Chromium from a different Playwright version. A genuine revision mismatch surfaces reactively instead: `isMissingBrowserError()` matches Playwright's own stderr and offers `BROWSER_INSTALL`.

### Variable system (`src/shared/variableResolver.ts`)

Kinds of `{{...}}` placeholders, resolved in priority order **session > profile > project-env > built-in**:

1. **Session variables** (highest) — any action node can set `action.captureAs = "varName"`. `Replayer` captures the resolved value into `this.sessionVars`; `ScriptExporter` emits a `const varName = ...` declaration.
2. **Environment profile variables** — the active `FlowProfile`'s `vars[]` resolved by key, with `envValues[activeEnvId] ?? value`. A profile value may itself reference a project env var via `{{key}}`.
3. **Project environment variables** — the active project's `envVars[]` flattened for the active environment (`flattenProjectEnvVars`). The reserved `domain` key drives goto URL origin substitution (origins matching `flow.baseURL` are swapped for the active environment's `domain`); see the Projects & Environments section.
4. **Built-in variables** (5): `{{randomText}}` (8-char string), `{{randomNumber}}` (8-digit), `{{randomOneText}}` (one A–Z letter), `{{randomOneNumber}}` (one 0–9 digit), `{{timestamp}}` (`yyyyMMddHHmmssSSS`).

**The built-ins are one registry**, `BUILT_IN_VARIABLES`. Each entry carries all four identities a built-in has: sidebar metadata (`name` / `description` / `example`, with `placeholder` derived from `name`), the runtime `generate()`, the codegen identifier `helperFn` (`_ftRandomText`…), and `helperSource`, the emitted function body. Every consumer reads that table — `resolveValue`, `varToCodeRef`, `VARIABLE_HELPERS_CODE`, `Replayer.buildCodeVars`, `ScriptExporter`'s code-node `vars` literal, `VariableList`, `AddNodeModal` — so adding a built-in is one entry. `helperSource` is hand-written rather than derived from `generate.toString()`: the bundler rewrites function bodies, and the emitted source is TypeScript. The two spellings sitting in one entry is what makes a drift between them visible; that is the only guarantee the registry offers.

Note the deliberate call/no-call split: `varToCodeRef` emits `helperFn` **called** (`_ftRandomText()`) because a placeholder stands for a value, while a code node's `vars` literal holds it **uncalled**, so each `vars.randomText()` yields a fresh value — mirroring `buildCodeVars`, which hands over `generate` itself.

`resolveValue(value, { sessionVars?, profileVars?, envVars? })` resolves at runtime — one function, one multi-pass loop, absent tiers simply skipped (session vars rank highest but would have to sit last as a positional parameter, hence the object). For codegen: `valueToCodeExpr(value, profileVarKeys?)` → TS literal (profile keys become `${_ftProf_key}`); `sessionAwareValueToCodeExpr()` additionally treats session vars as bare identifiers; `locatorExprToCode()` rewrites `{{...}}` inside locator expression string arguments; `emitProfileVarDecls()` emits `const _ftProf_key = '...'`; `VARIABLE_HELPERS_CODE` injects `_ftRandomText` / `_ftRandomNumber` / `_ftRandomOneLetter` / `_ftRandomOneDigit` / `_ftTimestamp` when needed.

#### Session variable hoisting

Every action is wrapped in its own `test.step('…', async () => {…})` closure, so a `captureAs` declared with `const` in one closure is invisible to later closures. `generateSpec()` collects all `captureAs` names into `hoistedVars`, emits `let varName = ''` at the test-function scope, and passes `hoistedVars` to `actionToCode()` which then emits plain assignment (`varName = expr`) instead of `const`.

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

### Private data (the vault)

The workspace is deliberately git-tracked, which means every profile variable, project env var and recorded node value — passwords included — was being committed in plaintext. Marking a value **私密** (`secret: true`) stores it encrypted instead.

- **`src/main/security/vault.ts`** — scrypt-derived key (N=32768, r=8, p=1) + AES-256-GCM. Ciphertext is a self-describing string, `enc:v1:<b64 iv>:<b64 ct+tag>` (`SECRET_ENVELOPE_PREFIX`), so it lives in the same `value: string` fields with no schema change. A **passphrase**, not a machine key: the workspace travels with the user's repo, so a machine-bound key would leave a teammate with undecryptable garbage. This is the ansible-vault model.
- **Changing the passphrase is NOT atomic.** `recryptWorkspace` rewrites each flow/project to disk one at a time with no staging and no rollback, and only then commits the new metadata. A failure part-way therefore leaves the already-rewritten files under the NEW key while the verifier still expects the OLD one — those files are unrecoverable with either passphrase. The old passphrase does keep unlocking the vault, but it now decrypts only the untouched remainder. Fixing this needs staged writes plus an atomic swap (A7 in the cleanup backlog).
- **Vault metadata** (`salt`, KDF params, `verifier`) goes in the committed `.flowtest.json` marker via a merge-write that preserves `version`. The verifier is an envelope over a fixed string; decrypting it back is how a passphrase is checked. The **key exists only in main-process memory** — `lock()` on workspace switch.
- **The passphrase is cached in the OS keychain** — `safeStorage.encryptString` → `userData/settings.json` `vaultKeys[workspacePath]`, so it is a once-per-machine prompt. When `isEncryptionAvailable()` is false it simply isn't cached; it never falls back to plaintext.
- **`secret` is a per-KEY attribute**, not per-value: profile keys are shared across every profile of a flow, so `commitProfileVars` applies the flag to all of them (otherwise one profile would store the key in the clear). `domain` can never be secret — it is baked into goto URLs as a literal.
- **Decryption happens at the main-process boundary.** The renderer has no key: it assembles the `ResolutionContext` with ciphertext still in place, and `decryptContext()` in `ipcHandlers` unwraps `profileVars` / `envVars` on the way in. **Always before `resolveValue`** — resolution would splice ciphertext into a larger string, which nothing could recover. The shared `resolveProfileVars()` helper (`shared/variableResolver.ts`) enforces the order for all three call sites by taking `decrypt` as an **injected** function: identity in the renderer, `vault.decryptIfNeeded` in `ScriptExporter.flowScopeFor` and `Replayer.executeCallFlow`. (It has to be injected — `security/vault.ts` imports electron's `safeStorage` and so cannot live in `src/shared/`.) For the same reason `buildResolutionContext` (renderer, `utils/varMaps.ts`) leaves `{{secretEnvKey}}` references *unresolved* for main to expand post-decrypt.
- **Locked = loud failure.** `assertUnlocked()` blocks REPLAY_TO_NODE, branch RECORDING_START, EXPORT_SCRIPTS and RUN_TESTS outright rather than trying to guess whether a secret is involved — silently typing `enc:v1:…` into a login form is the worse outcome. The renderer mirrors this in `blockedByLock()` and raises the unlock dialog.
- **Node descriptions are scrubbed at mark time.** The recorder writes `填入「hunter2」到「密碼」`, and that string is committed, drawn on the canvas, and emitted as the `test.step()` name. Toggling a node private replaces the plaintext with `••••••` in the stored description — a render-time mask would not have helped the file on disk.
- **UI**: 🔐 toggles private (🔒 stays reserved for the `domain` lock); `common/SecretValue.tsx` masks read-only displays with a 👁 that fetches one plaintext over `SECRET_REVEAL`. Private values are also excluded from ProfileEditorModal's env-var search, which would otherwise be an oracle for them.

#### Codegen: `process.env`, never literals

Playwright has no secrets mechanism; the official pattern is `process.env` fed from a gitignored file. So a private value **never appears in the spec**:

- `ScriptExporter`'s `SecretRegistry` assigns each one an identifier and emits `const _ftSec_pw = _ftSecret('FT_SECRET_pw');`. Deduped on key+value, so a secret shared by a parent and its sub-flows collapses to one declaration while same-named different values get `_ftSec_pw_2`.
- `CodegenVarScope.secretVars` is a **resolver function**, consulted ahead of every other tier in `varToCodeRef`. It registers on lookup, so only referenced secrets get declared. Being a function (not a map) is what makes the sub-flow `inlineVars: true` path safe: those four inline-substitution sites skip private keys (via the side-effect-free `isSecret` predicate) and leave the `{{key}}` for `valueToCodeExpr` to turn into `_ftSec_*`.
- `emitProfileVarDecls` / `emitEnvVarDecls` take a skip-set so private keys never get a plaintext `_ftProf_*` / `_ftEnv_*` declaration.
- **`_ftSecret()`** (`SECRET_HELPER_CODE`) reads `process.env`, falls back to parsing `.flowtest/secrets.env`, and throws a clear message otherwise. Doing the file read *in the spec* keeps it self-sufficient, so `playwright.config.ts` needs no change — which matters because `scaffold()` uses `writeIfMissing` and would never update an existing workspace.
- **In-app runs write no plaintext to disk**: `RUN_TESTS` passes `ScriptExporter.collectSecretEnv()` into `runPlaywright`'s `extraEnv`. The gitignored `.flowtest/secrets.env` is only written on the explicit 匯出密鑰檔 action, for external `npx playwright test`.

**Known limitation:** Playwright traces, videos and HTML reports capture the *runtime* values. Encryption at rest cannot prevent that; they land in the gitignored `.flowtest/`, but must be treated as sensitive when shared.

### Projects & Environments system

Projects add a layer **above** flows for managing environment-specific variable values. A `Project` has named `environments` (e.g. `DEV` / `UAT` / `PRD`) plus project-level `envVars?: ProjectEnvVar[]`; a `Flow` joins a project via `projectId`. **Every flow belongs to a project**: a flow with no `projectId` is treated as belonging to the reserved default project `未分類` (`DEFAULT_PROJECT_ID = '__default__'`), which cannot be deleted or renamed and is pinned to the bottom of `FlowList`.

Two caveats the `?? DEFAULT_PROJECT_ID` idiom does **not** cover:
- **Unknown ids are only folded in for display.** `?? DEFAULT_PROJECT_ID` catches `null`/`undefined` only. A `projectId` pointing at a deleted project is mapped to `未分類` solely by `FlowList.tsx`; everywhere else (`openFlow`, `setCurrentFlow`, `gateEnvVars`, `executeCallFlow`) it matches no project, so the flow opens with `currentProject === null` — blank environment selector, and domain substitution plus env vars silently inert. A shared `resolveProjectId(flow, knownProjects)` is the fix (A10 in the cleanup backlog).
- **Deleting a project deletes its flows.** `deleteProject` cascade-deletes every flow whose `projectId` matches, then the project — it does not orphan them into `未分類`.

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

**ScriptExporter** splits what the recursion carries into two named types instead of one long parameter list: **`ExportEnv`** (constant for the whole run — the raw ungated `ctx`, `knownProjectIds`, `subFlowMap`, `secretEnvKeys`) and **`FlowScope`** (re-derived per flow — `activeProfileId`, resolved `profileVars`, *gated* `envVars`, `baseOrigin`, `domain`, `secretProfileKeys`). `generateSpec` → `buildStepSequence` → `getSubFlowPath` each take just `(…, env, scope)`; at every callFlow node `resolveSubFlowProfileId()` picks the sub-flow's profile id and `flowScopeFor()` builds its scope in one call. `ExpandedStep` is `{ node, inlineVars, scope }`, and `actionToCode(step, sessionVarsDefined, opts)` reads everything per-step off `step.scope`.

Note the two env-var maps that deliberately coexist: `env.ctx.envVars` is the raw, ungated map re-gated for each flow, while `scope.envVars` is the already-gated one a node is emitted against. Sub-flow nodes are inlined with `inlineVars: true` — their profile var placeholders are baked into literal values at codegen time (so they don't reference the parent's `_ftProf_*`).

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

**Covered:** add / delete node / delete subtree / delete-nodes-only, connect + disconnect edges, disconnect node, create + ungroup group, `relayoutAll`, insert/append callFlow, PropertyPanel commits.

**NOT covered — extract sub-flow.** `FlowCanvas.handleExtractConfirm` goes through `setCurrentFlow`, which resets `past`/`future`, so extracting is not undoable *and wipes the whole editing history*. Making it undoable is a one-line change in principle (end with a plain `set({ currentFlow })` like `insertCallFlowBefore` does), but it first needs a decision about the sub-flow file already written to disk: a Ctrl+Z would restore the parent graph and leave an orphan flow with `refCount: 0` in `FlowList`.

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
- **`src/renderer/stores/confirmStore.ts` + `components/common/ConfirmDialog.tsx`** — `confirm()` raises an app-styled dialog from `<ConfirmHost />` (mounted once in `App.tsx`, `zIndex 4000` so it can appear above modals). Replaces `window.confirm` entirely (zero remaining call sites). Five native `alert()` calls do remain and are not yet migrated — `FlowCanvas.tsx` (extraction / grouping validation failures) and `Toolbar.tsx` (export success and the two export failures). Danger dialogs put Enter on 取消.
- **Destructive actions all confirm** — delete flow / project / environment / profile / profile variable / project env var / session variable, and duplicate project. **Deliberate exception: deleting a node (or node + subtree) does not confirm** — it's a high-frequency editing gesture and Ctrl+Z restores it. Ungroup likewise (destroys no node data, and is undoable).

### The workspace (`src/main/storage/workspace.ts`)

**Everything on disk lives under one user-chosen folder — the workspace.** The user puts it inside their own repo, so version control of test data is theirs and different repos are isolated by construction. `getWorkspaceRoot()` is the single source of that path; there are no `app.isPackaged` / `process.cwd()` branches left in storage.

- **No workspace = no app.** `getWorkspaceRoot()` throws, so `App.tsx` renders `WelcomeScreen` (and mounts nothing else) until one is chosen. `FlowList` fetching the flow list on mount is exactly what that gate exists to prevent.
- **The chosen root is remembered outside every workspace** — `app.getPath('userData')/settings.json` (`{ workspaceRoot, recentWorkspaces[] }`), since it is what tells us *which* workspace to open. A remembered root that no longer exists is dropped and the picker is shown.
- **`scaffold()` runs on every open**, not just the first, and never overwrites an existing file — a fresh clone arrives without whatever was gitignored. It creates `flows/ projects/ fixtures/ exports/ .flowtest/`, a `playwright.config.ts`, and a `.flowtest.json` marker.
- **Ignore rules are per-directory `.gitignore` files, never the user's own.** `exports/.gitignore` and `.flowtest/.gitignore` both hold `*` + `!.gitignore` — the negation matters: a bare `*` hides the ignore file itself, so it would never be committed and the rule would not survive a clone. All Playwright output is routed into `.flowtest/` so two rules cover it (and the file has to sit *above* `test-results/`, which Playwright wipes before every run).
- **Switching workspaces** (`useWorkspace.switchTo`) is blocked during recording/replay, then clears `currentFlow` (which also clears project, active environment and undo history) and re-fetches both lists.
- **External changes**: `win.on('focus')` → `WORKSPACE_RELOAD` → `reloadFromDisk()`, which re-reads the lists and takes the disk copy of the open flow/project only when its `updatedAt` is newer. Skipped while recording/replaying.

### Storage

- Flows: `<workspace>/flows/{flowId}.json`. `FlowStorage.list()` also computes each flow's `refCount` by scanning all callFlow nodes. `save(flow, { touch: false })` writes without bumping `updatedAt` — used by the debounced drag save, since repositioning is not a content change (drag coordinates are also rounded) and would otherwise conflict in git for nothing.
- Projects: `<workspace>/projects/{projectId}.json` (`ProjectStorage`).
- Upload fixtures: copies of picked files under `<workspace>/fixtures/` (`FixtureStorage`), referenced from upload nodes as `fixtures/<file>`. `normalizeStoredPath()` (via the `NORMALIZE_PATHS` channel, called from PropertyPanel's save) rewrites hand-typed absolute paths: inside the workspace they simply lose the prefix — so a flow may reference the surrounding repo's own `testdata/` without a redundant copy — and outside it they are copied into `fixtures/`.
- Exports: `ScriptExporter` computes all root-to-leaf paths and emits one `test()` block per path into `<workspace>/exports/{flowId}.spec.ts`; optionally extracts a shared prefix (≥3 common leading nodes, ≥2 paths) into `exports/helpers/{flowId}-helpers.ts`.

### Path aliases (tsconfig + vite config)

| Alias | Resolves to |
|-------|-------------|
| `@shared/*` | `src/shared/*` |
| `@renderer/*` | `src/renderer/*` |

## File Reference

| File | Role |
|------|------|
| `src/main/index.ts` | Electron entry — creates BrowserWindow, registers IPC handlers, opens external links in default browser |
| `src/main/ipc/ipcHandlers.ts` | Central orchestrator — all 32 Renderer→Main channel handlers; holds singleton BrowserController/Recorder (the Replayer is handler-local); `hasCallFlowCycle()` + `killProcessOnPort()` |
| `src/main/playwright/browserController.ts` | Wraps playwright-core chromium: launch, context, page, auto-cleanup on disconnect |
| `src/main/playwright/recorder.ts` | Thin wrapper around CodegenCapture; tracks recording state; pause/resume; assertion-pick entry |
| `src/main/playwright/codegenCapture.ts` | Multi-page recorder: injects scripts (initScript + DOM capture + cursor + assertion dock, top-frame UI via `topFrameOnly`), exposes report/assert/locator-resolved functions, filters navigation, buffers input clicks + dblclick merge, assigns page aliases & `opensPage` (incl. `ACTION_UPDATED` retro-patch), builds iframe `framePath` chains, imports upload paths over CDP, drives in-browser locator picker |
| `src/main/playwright/captureShared.ts` | Shared utilities: extracts InjectedScript from coreBundle.js, DOM event capture (blacklist, Shadow DOM-aware), locator builder, nav-suppression logic, assertion dock + pick overlay scripts, in-browser locator-picker script, cursor highlight, `buildAction` |
| `src/main/playwright/replayer.ts` | Action execution (incl. the three assert types); parentId-chain path traversal; fires REPLAY_NODE_* events; constructor `(page, baseURL, ctx: ResolutionContext, sharedPages?)`; `pageFor`/`scopeFor` resolve `pageAlias` + `framePath`; `substituteOrigin` swaps goto origin for the project env var `domain`; `buildCodeVars` backs `code` nodes; resolves subFlowProfileMapping + envValues for callFlow at any depth |
| `src/main/security/vault.ts` | **Private data**: scrypt + AES-256-GCM over an `enc:v1:iv:ct` envelope; `load`/`setup`/`unlock`/`lock`/`changePassphrase`, `encrypt`/`decrypt`/`decryptIfNeeded`/`decryptMap`/`isCiphertext`; vault meta merge-written into `.flowtest.json`, passphrase cached via `safeStorage` in userData |
| `src/renderer/hooks/useVault.ts` | `ensureUsable` (opens setup/unlock as needed before writing a private value), `promptUnlock`, `lock`, state helpers |
| `src/renderer/components/Vault/VaultModal.tsx` / `VaultHost.tsx` | One dialog for setup / unlock / change-passphrase; the host is mounted once in `App.tsx` so a blocked replay or export can raise it |
| `src/renderer/components/common/SecretValue.tsx` | Masked read-only value with a 👁 that fetches one plaintext over `SECRET_REVEAL` |
| `src/renderer/utils/varMaps.ts` | `buildResolutionContext` — the renderer's **single** construction site for the `ResolutionContext` crossing IPC (replay / branch recording / export / run), plus `getEnvVars` / `getSecretEnvKeys`; leaves private env references unresolved for main to expand after decryption |
| `src/main/storage/workspace.ts` | **The workspace**: mutable root + `getWorkspaceRoot()`/`hasWorkspace()`/`setWorkspaceRoot()`; `loadSettings()`/persistence in `userData/settings.json` (outside every workspace); idempotent `scaffold()` (dirs, per-directory `.gitignore`s, `playwright.config.ts`, `.flowtest.json`); `warnAbout()` for drive-root / home-dir picks |
| `src/main/playwright/runner.ts` | Bundled Playwright CLI: `resolvePlaywrightCli()` (asar-unpacked path + version + `nodePath`), `runPlaywright()` (spawns `process.execPath` with `ELECTRON_RUN_AS_NODE` + `NODE_PATH` + pinned HTML report dir) |
| `src/main/playwright/browserCheck.ts` | `hasChromium()` — existence scan of `ms-playwright/chromium*`, never a revision comparison; `isMissingBrowserError()` for reactive install prompts |
| `src/main/storage/flowStorage.ts` | Flow CRUD; `list()` computes `refCount`; sorts by updatedAt; `save(flow, { touch })` |
| `src/main/storage/fixtureStorage.ts` | Upload fixtures: `importFile()` (copy into `fixtures/`, content-hash suffix on name collision), `toAbsolute()`, `normalizeStoredPath()` (absolute → workspace-relative, copying in from outside) |
| `src/main/storage/projectStorage.ts` | Project CRUD under `projects/`; `ensureDefault()` materializes the reserved `未分類` project (DEV env + `domain`) with a stable env id; `delete()` protects `__default__` |
| `src/main/storage/scriptExporter.ts` | Path computation + `.spec.ts` codegen; emits `_ftProf_*` decls; bakes each flow's active-env `domain` literal into matching gotos (`resolveFlowDomain`, per-step `domain`); threads activeProfileId/activeEnvironmentId/envVars/activeProjectId through recursive sub-flow expansion; hoists captureAs + popup-alias vars out of the per-step `test.step` closures; `filter({ hasText })` for session-var assertText; emits `waitForEvent('popup')` for `opensPage`, `.contentFrame()` chains for `framePath`, `dblclick` for `clickCount>=2`, and a `const vars = {…}` preamble for `code` nodes |
| `src/shared/types.ts` | All shared types + `IPC_CHANNELS`; `isCallFlowAction` guard; `REPLAY_SPEED_MS`; `DEFAULT_PROJECT_ID`/`DEFAULT_PROJECT_NAME`/`DOMAIN_ENV_KEY`/`DEFAULT_ENV_NAME`/`DEFAULT_DOMAIN` |
| `src/shared/variableResolver.ts` | Variable system: the `BUILT_IN_VARIABLES` registry (5 built-ins, each carrying metadata + `generate` + `helperFn` + `helperSource`), `flattenProjectEnvVars`, `resolveValue(value, { sessionVars?, profileVars?, envVars? })`, `pickProfile` + `resolveProfileVars` (the one profile-resolution rule all three processes share, with `decrypt` injected), `valueToCodeExpr`, `sessionAwareValueToCodeExpr`, `locatorExprToCode`, `emitProfileVarDecls` / `emitEnvVarDecls` (`_ftProf_` / `_ftEnv_` prefixes), `VARIABLE_HELPERS_CODE` |
| `src/shared/electronAPI.ts` | The `ElectronAPI` interface — one declaration read by both preload (`satisfies`) and renderer (`window` augmentation). Must stay free of `electron` imports |
| `src/preload/index.ts` | contextBridge — exposes `window.electronAPI`, pinned with `satisfies ElectronAPI`; the 10 Main→Renderer `onX` wrappers all come from one generic `subscribe<T>(channel)` |
| `src/renderer/App.tsx` | Root — calls `usePlaywrightEvents()` + `useUndoRedo()`; **gates on the workspace** (renders `WelcomeScreen` alone until one is open); then Toolbar + FlowList + FlowCanvas + PropertyPanel + right sidebar (VariableList / ProfileVarList / ProjectEnvVarList / SessionVarList, shown only when a node is selected) |
| `src/renderer/stores/flowStore.ts` | Zustand store — flow/node/profile/project/environment state + actions; node-graph-only undo/redo (`Flow[]` snapshots, `graphChanged` guard, `runAsOneHistoryStep`) + history subscription; `suppressDepth`/`setSilently`; atomic `commitProfileVars` / `commitProjectEnvVars`; group actions; layout actions; domain + callFlow-profile migrations |
| `src/renderer/stores/workspaceStore.ts` | Workspace state (`info` / `loading` / `installing`) — kept out of flowStore because it outlives every flow |
| `src/renderer/hooks/useWorkspace.ts` | `pick` / `switchTo` / `forget` / `reveal` / `installBrowser`; owns the switch cleanup order (block while recording/replaying → clear flow+project+undo → refresh lists) |
| `src/renderer/components/Welcome/WelcomeScreen.tsx` | Shown until a workspace is chosen (VSCode Get Started layout: Start / Recent / explainer cards / folder drag-drop; missing-browser banner) |
| `src/renderer/stores/confirmStore.ts` | `confirm()` — promise-based replacement for `window.confirm` |
| `src/renderer/components/common/ConfirmDialog.tsx` | `ConfirmHost` — renders queued confirm requests (zIndex 4000, Enter defaults to 取消 on danger) |
| `src/renderer/components/Toolbar/Toolbar.tsx` | Action bar: workspace name (📂 click to reveal) + switch (⇄, blocked while recording/replaying), new-flow, undo/redo, record/stop, relayout, export, run-tests, replay-speed, environment selector (🌐), profile selector (⚙), status pills; new-flow dialog (歸類至專案 + 流程名稱, no 目標URL) |
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
| `src/renderer/components/PropertyPanel/PropertyPanel.tsx` | Bottom panel: edit description/selector/locator/value for selected node; assertText/assertValue value fields; callFlow "配置對應" mapping grid (loads sub-flow profiles via `FLOW_GET`). Local `useState` fields re-synced on `selectedNodeId` only, written by the 儲存 button (which re-reads the node from `getState()`, and runs upload paths through `NORMALIZE_PATHS`); empty fields save as empty |
| `src/renderer/components/ProfileEditor/ProfileEditorModal.tsx` | Two-column modal: profile list (add/rename/delete) + local variable table (key synced across profiles; value/description per-profile) committed by 儲存 via `commitProfileVars`; rename commits on ✓/Enter only |
| `src/renderer/components/ProjectEnvVar/ProjectEnvVarModal.tsx` | Project-level env-var editor — local table (one key per row, value per selected environment) committed by 儲存 via `commitProjectEnvVars`; environment add/rename/duplicate/delete; `domain` row is key-locked and non-deletable (🔒) |
| `src/renderer/components/ProjectEnvVar/ProjectEnvVarList.tsx` | Sidebar: active project's env vars resolved for the active environment; click to copy `{{key}}` |
| `src/renderer/components/AddNodeModal/AddNodeModal.tsx` | 加入節點 dialog — code editor (`page` / `expect` / `vars` in scope) with a click-to-copy list of every available variable grouped by origin |
| `src/renderer/components/CallFlowModal/CallFlowModal.tsx` | 2–3 step modal to embed a sub-flow: select flow (cycle-checked) → exit node → profile mapping |
| `src/renderer/components/VariableList/VariableList.tsx` | Sidebar: 5 built-in variables; click to copy |
| `src/renderer/components/ProfileVarList/ProfileVarList.tsx` | Sidebar: active profile's variables (amber); click to copy `{{key}}` |
| `src/renderer/components/SessionVarList/SessionVarList.tsx` | Sidebar: session variables from `captureAs` nodes; click to copy, trash to delete |
| `src/renderer/hooks/usePlaywrightEvents.ts` | IPC event subscriptions: ACTION_CAPTURED, ACTION_UPDATED, ACTION_REMOVED, REPLAY_NODE_*, REPLAY_FINISHED/ERROR, WORKSPACE_RELOAD; owns `reloadFromDisk()` |
| `src/renderer/hooks/usePlaywright.ts` | IPC invocation wrappers: startRecording (navigates to the active env's `domain`, persists it as `flow.baseURL`), startBranchRecording, stopRecording, replayToNode (builds env-aware profileVars + envVars) |
| `src/renderer/hooks/useUndoRedo.ts` | Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z keyboard shortcuts |
| `src/renderer/hooks/useFlowStore.ts` | `useFlowManager`: refreshFlowList/refreshProjectList, openFlow (+ loads project), newFlow, deleteCurrentFlow |
| `src/renderer/utils/treeLayout.ts` | Tree layout: `computeTreeLayout`, `computeAllRootsLayout`, sizing constants, `SizeOf` |
| `src/renderer/utils/groups.ts` | Group geometry + `computeGroupAwareLayout` |
| `src/renderer/utils/subflowExtraction.ts` | `validateExtraction` (single entry/exit, connected) + `extractSubflow` (build sub-flow, rewire parent) |
| `src/renderer/types/electron.d.ts` | Attaches `ElectronAPI` to `window` for the renderer — nothing else; the interface itself lives in `src/shared/electronAPI.ts` |
| `electron.vite.config.ts` | Build config for all three bundles + path aliases |
| `playwright.config.ts` | Runner config **template** — `scaffold()` writes an equivalent (plus `.flowtest/` output dirs) into each workspace, which is what runs get pointed at via `--config`. The copy in this repo only applies when the repo root is itself opened as a workspace. |
| `package.json#build` | Installer config — the sole electron-builder source (`read-config-file` returns `package.json.build` when present and never reads `electron-builder.yml`, so a separate yml would be dead config). Ships + `asarUnpack`s `@playwright/test` / `playwright` / `playwright-core`. |
| `docs/archive/prd-flowtest.md` | **Historical only** — the pre-implementation PRD. Superseded by this file and contradicted by it in several places; do not implement from it. |
