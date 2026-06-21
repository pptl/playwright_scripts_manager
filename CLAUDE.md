# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**FlowTest** is an Electron desktop app that records user interactions as a visual branching flow graph, then generates Playwright `.spec.ts` test suites. The core innovation is "branch recording": silently replay to any previously-recorded node, then continue recording from that exact browser state — turning a 30-step flow into 5 new steps when testing a different path.

## Commands

```bash
npm run dev       # Start Electron app with hot-reload
npm run build     # Vite build (main + preload + renderer)
npm run preview   # Preview production build
npm run dist      # Build + create platform installers
```

No lint or test scripts are defined. TypeScript checking happens via the compiler during dev.

## Architecture

This is an **Electron multi-process app** with three distinct bundles (built by `electron-vite`):

```
Main Process (Node.js)         Preload Bridge         Renderer (React)
──────────────────────         ──────────────         ────────────────
ipcHandlers.ts                 preload/index.ts       App.tsx
  ├── BrowserController          contextBridge          Zustand store (flowStore.ts)
  ├── Recorder                   window.electronAPI     React Flow canvas
  ├── Replayer                                          Hooks (usePlaywright, usePlaywrightEvents)
  ├── CodegenCapture                                    useRecording, useFlowStore
  ├── FlowStorage
  └── ScriptExporter
```

### IPC as the central seam

`src/main/ipc/ipcHandlers.ts` is the **only file** that coordinates Main process modules. All Renderer ↔ Main communication goes through `IPC_CHANNELS` constants defined in `src/shared/types.ts`. The preload bridge (`src/preload/index.ts`) exposes `window.electronAPI` with typed wrappers for every channel.

Renderer → Main: `window.electronAPI.<method>()` → `ipcMain.handle(channel, ...)`
Main → Renderer: `mainWindow.webContents.send(channel, payload)` → `usePlaywrightEvents` hook

### Key data types (`src/shared/types.ts`)

- **`ActionType`** — 14 variants: `goto | click | fill | selectOption | check | uncheck | press | upload | wait | assertVisible | assertText | assertValue | callFlow`
- **`Action`** — one browser interaction: `type`, `locatorExpr` (high-quality Playwright locator), `selector` (CSS fallback), `value`, `captureAs` (optional session variable name), `description`, `url`, `isPageNavigation`, optional `assertion`. For `callFlow` actions: `subFlowId`, `subFlowExitNodeId`, `subFlowProfileMapping?: Record<string, string | null>` (parent profile ID → sub-flow profile ID), legacy `subFlowProfileId` / `subFlowProfileName` (for single-parent badge display)
- **`Assertion`** — `type` (`text|visible|url|count`), optional `target` selector, `expected` value
- **`FlowNode`** — `Action` + canvas `position` + `parentId` + `childIds[]` + optional `branchLabel`
- **`ProfileVariable`** — `{ key: string, value: string, description?: string }` — one variable entry in a profile
- **`FlowProfile`** — `{ id, name, vars: ProfileVariable[] }` — a named environment configuration
- **`Flow`** — `nodes: FlowNode[]`, `rootNodeId`, `baseURL`, `profiles?: FlowProfile[]`, metadata. `domains?: string[]` is deprecated (migrated to profiles on load)
- **`ReplaySpeed`** — `'fast' | 'normal' | 'slow'` mapped to 100 / 500 / 1000 ms
- **`RecordingStartPayload`** — `baseURL`, optional `branchFromNodeId` + `branchNodes` + `replaySpeed` for branch recording, `activeProfileId?` for sub-flow profile resolution
- **`ExportConfig`** — `outputDir`, `helperFunctions` (extract common prefix), `useTestStep`, `profileVars?: Record<string, string>` (active profile's flat key-value map for code generation), `activeProfileId?` for sub-flow profile resolution
- **`ReplayToNodePayload`** — includes `profileVars?: Record<string, string>` for runtime variable substitution, `activeProfileId?` for sub-flow profile resolution

### IPC channels (`src/shared/types.ts` → `IPC_CHANNELS`)

**Renderer → Main (13):** `BROWSER_LAUNCH`, `BROWSER_CLOSE`, `RECORDING_START`, `RECORDING_STOP`, `START_ASSERTION_PICK`, `REPLAY_TO_NODE`, `REPLAY_STOP`, `FLOW_SAVE`, `FLOW_LOAD`, `FLOW_LIST`, `FLOW_DELETE`, `EXPORT_SCRIPTS`, `RUN_TESTS`, `FLOW_GET` (fetch one flow JSON by ID — used async by PropertyPanel and CallFlowModal to load sub-flow profiles), `FLOW_CHECK_CYCLE` (validate that adding a callFlow won't create a circular reference — recursively checks the sub-flow's callFlow graph before insertion)

**Main → Renderer (9):** `ACTION_CAPTURED`, `ASSERTION_PICK_CANCELLED`, `REPLAY_NODE_START`, `REPLAY_NODE_COMPLETE`, `REPLAY_FINISHED`, `REPLAY_ERROR`, `TEST_OUTPUT`, `TEST_FINISHED`

### Recording pipeline

1. `Recorder.start()` → `CodegenCapture.start()` extracts Playwright's `InjectedScript` from `playwright-core/lib/coreBundle.js` at runtime (via `captureShared.ts`) and injects it with `page.addInitScript()`, plus exposes `__flowtest_report` via `page.exposeFunction()`
2. Browser JS calls `__flowtest_report(rawEvent)` on click/fill/selectOption/check/uncheck/press
3. `captureShared.ts` builds Actions with high-quality locators: `getByRole` → `getByLabel` → `getByPlaceholder` → `getByTestId` → `getByText` → `#id` → tag fallback
4. Navigation suppression: events within `NAV_SUPPRESSION_MS = 5000` after a click are not re-recorded as `goto` (redirect side-effects)
5. Each captured action fires `ACTION_CAPTURED` → `usePlaywrightEvents` → `flowStore.addActionNode()` → auto-saves JSON

#### DOM event filtering in `getDOMCaptureScript()` (matches Playwright's `RecordActionTool`)

- **Click** — **blacklist** approach (not whitelist): records any click except `SELECT`, `OPTION`, `INPUT[date/range]`, `html`, `body`. Bubbles up to nearest `<button>`/`<a>` only for better locator quality, not as a filter. Uses `event.composedPath()[0]` (not `e.target`) to pierce Shadow DOM.
- **Fill** — `focus`/`blur` pair captures final value on text inputs **and `contentEditable`** elements. An `isInputClick` flag on text-input clicks lets CodegenCapture suppress the click if a fill follows.
- **SelectOption** — native `<select>` `change` event; captures `value` and display text.
- **Press** — mirrors Playwright's `_shouldGenerateKeyPressFor`: records `Tab`, `Enter` (outside textarea/contentEditable), `Escape`, arrow/function keys, modifier+char combos. Skips `Backspace`, `Delete`, paste shortcuts (`Ctrl/Meta+V`), bare modifier keys, and single printable chars without modifiers (those become fill values).

### Assertion-picking pipeline

1. User clicks an assertion button in the Toolbar (assertVisible / assertText / assertValue) during recording
2. `START_ASSERTION_PICK` IPC fires with the assertion type; `isPickingAssertion` flag set in flowStore
3. Main process puts recorder into picking mode — next DOM element the user clicks triggers the exposed assertion-pick function rather than a regular action
4. If user cancels, Main fires `ASSERTION_PICK_CANCELLED` → `usePlaywrightEvents` clears the flag
5. On successful pick, an assertion action node (type `assertVisible` / `assertText` / `assertValue`) is emitted via `ACTION_CAPTURED` and appended to the flow

### Replay pipeline

`Replayer.replayToNode()` walks `parentId` pointers from the target node up to the root to build an ordered path, then executes each `Action` sequentially. Assertions support `text`, `visible`, `url`, and `count` types with a 10 s timeout. Each step fires `REPLAY_NODE_START` / `REPLAY_NODE_COMPLETE` events to drive the canvas status badges (running → success/error border colors).

`Replayer` constructor: `(page: Page, baseURL = '', profileVars?: Record<string, string>, activeProfileId?: string)`. The `domain` profile variable drives goto URL origin substitution — if a goto URL's origin matches `baseURL`'s origin, it is replaced with `profileVars['domain']`. `activeProfileId` enables the replayer to resolve `subFlowProfileMapping` on `callFlow` nodes at any nesting depth.

### Branch recording pipeline

When the user clicks "Branch Record" from node N:
1. `startBranchRecording(N)` passes `branchFromNodeId: N` + `branchNodes: flow.nodes` in `RecordingStartPayload`
2. Main process silently replays from root → N using Replayer (50–200 ms/step, no UI events fired)
3. `Recorder.start()` begins WITHOUT navigating to `baseURL` — browser is already at N's page state
4. New actions append as children of N; `recordingHeadId` in the Zustand store tracks the last-added node so subsequent actions chain correctly

### Test execution pipeline

1. User clicks "Run All Tests" → `RUN_TESTS` IPC
2. Main process runs `ScriptExporter.export()` to write `.spec.ts`, then spawns `npx playwright test` as a child process
3. stdout/stderr are streamed line-by-line via `TEST_OUTPUT` events → `TestOutputModal` displays live output
4. On process exit, `TEST_FINISHED` fires; Main spawns the Playwright HTML report viewer

### Variable system

Three kinds of `{{...}}` placeholders can appear in action `value` fields, resolved in priority order:

1. **Session variables** (highest priority) — any action node can set `action.captureAs = "varName"`. During replay, `Replayer` captures the resolved value into `this.sessionVars`. During export, `ScriptExporter` emits a `const varName = ...` declaration.
2. **Environment profile variables** — the active `FlowProfile`'s `vars[]` are resolved by key. The `domain` key is special: it also substitutes the origin in goto URLs matching `flow.baseURL`'s origin. Profile vars are passed as a flat `Record<string, string>` from Renderer → IPC → Replayer/ScriptExporter.
3. **Built-in variables** (`src/shared/variableResolver.ts`) — `{{randomText}}`, `{{randomNumber}}`, `{{timestamp}}` only (3 total; `{{domain}}` was removed from built-ins and is now a profile variable key).

`valueToCodeExpr(value, profileVarKeys?)` converts a value string to a TypeScript literal, substituting profile var keys as `${_ftProf_key}` template references. `sessionAwareValueToCodeExpr()` additionally handles session vars. `emitProfileVarDecls(profileVars)` emits `const _ftProf_key = '...'` declarations at the top of generated spec files. Helper functions (`_ftRandomText`, `_ftRandomNumber`, `_ftTimestamp`) are injected when needed (`VARIABLE_HELPERS_CODE`).

#### Session variable hoisting in `useTestStep` mode

When `config.useTestStep` is true, each action is wrapped in its own `test.step('…', async () => { … })` closure. A `captureAs` variable declared with `const` inside one closure is invisible to subsequent closures (JavaScript block scoping). Fix: `generateSpec()` collects all `captureAs` names across every step into `hoistedVars: Set<string>`, emits `let varName = ''` declarations immediately after the `async ({ page }) => {` opening (before the first step), and passes `hoistedVars` down to `actionToCode()`. Inside `actionToCode()`: if `captureAs ∈ hoistedVars`, emit `varName = expr` (plain assignment); otherwise emit `const varName = expr` (normal declaration). Without `useTestStep` no hoisting is needed.

#### `assertText` session-variable locator fix

The `locatorExpr` stored on an `assertText` node at recording time may embed the element's text content (e.g. `getByRole('cell', { name: 'Bottest_20260621162212389' })`). When `action.value` is a pure session-variable reference (`{{varName}}` and `varName ∈ sessionVarsDefined`) and `action.selector` exists, `actionToCode()` replaces the hardcoded locator with `page.locator(selector).filter({ hasText: valueExpr })`. This tracks the *runtime* value of the session variable instead of the stale recording-time text. The fallback (no `action.selector`, or value is not a session var) still uses the original `locatorExpr`. `assertValue` is unaffected — its locator targets an input by label/name, not by value.

### Environment Profiles system

Each flow has `profiles?: FlowProfile[]`. A profile is a named set of `ProfileVariable` entries (`key`, `value`, `description?`). Switching the active profile swaps all `{{key}}` resolutions at once — useful for running the same flow against different environments (staging vs prod, different admin credentials, etc.).

**Key invariant:** all profiles within a flow share the same variable keys — only `value` and `description` differ per profile. The store enforces this with three cross-profile mutation actions:
- `addVarToAllProfiles()` — appends `{key:'', value:'', description:''}` to every profile
- `updateVarKeyInAllProfiles(index, newKey)` — renames the key at `index` across all profiles
- `deleteVarFromAllProfiles(index)` — removes the variable at `index` from all profiles

Per-profile mutations (`value`, `description`, `name`) use `updateProfile(id, updates)`.

**Migration:** old flows with `domains?: string[]` but no `profiles` are migrated in memory on load (`migrateDomainsToProfiles()` in `flowStore.ts`) without writing to disk.

**Code generation:** profile vars emit as `const _ftProf_key = '...'` at top of spec file. Goto URLs with domain substitution emit as `` `${_ftProf_domain}/path` `` (parameterizable, not hard-coded).

**UI:** Toolbar profile selector (⚙ button) → dropdown to switch profiles → "管理配置…" opens `ProfileEditorModal`. Right sidebar shows active profile's vars in the `ProfileVarList` panel (amber colour), between `VariableList` (built-ins) and `SessionVarList` (session vars). Click any var to copy its `{{key}}` placeholder.

### Sub-flow Profile Mapping system

A `callFlow` action node embeds another flow inline. Because the parent flow and the sub-flow each have their own set of `FlowProfile`s, the mapping between them must be configurable per parent profile.

**`subFlowProfileMapping: Record<parentProfileId, subFlowProfileId | null>`** — stored on the `callFlow` action. Each parent profile ID maps to the sub-flow profile ID to activate. `null` means "use the sub-flow's first profile".

**N-level nesting:** Each `Replayer` receives the *resolved sub-flow profile ID* as its own `activeProfileId`. When that replayer hits a nested `callFlow`, it resolves `subFlowProfileMapping[this.activeProfileId]` to get the next level's profile ID, creating a chain that supports unlimited nesting depth.

**Resolution order in `Replayer.executeCallFlow()`:**
1. Check `action.subFlowProfileMapping[this.activeProfileId]` → use if key exists
2. Fallback to legacy `action.subFlowProfileId`
3. Fallback to first profile of the sub-flow

**ScriptExporter** threads `activeProfileId` through `generateSpec()` → `buildStepSequence()` → `getSubFlowPath()` recursively, calling `resolveSubFlowProfileId()` at each `callFlow` node.

**Migration:** Legacy `callFlow` nodes that have `subFlowProfileId` but no `subFlowProfileMapping` are auto-migrated in memory on flow load (`migrateCallFlowProfiles()` in `flowStore.ts`) — all parent profiles map to the existing `subFlowProfileId`. No disk write.

**Store maintenance:**
- `addProfile()` — extends all callFlow node mappings with `[newProfile.id]: lastMappedId ?? null` (copies the last profile's mapping as default)
- `deleteProfile()` — removes the deleted profile ID key from all callFlow node `subFlowProfileMapping` objects

**UI entry points:**
1. **CallFlowModal Step 3** — shown when sub-flow has >1 profiles. If parent has ≥2 profiles: 2-column mapping table (parent profile → sub-flow profile dropdown per row). If parent has 1 profile: original single-selection list.
2. **PropertyPanel "配置對應" section** — visible whenever a callFlow node is selected and parent flow has ≥1 profiles. Loads sub-flow profiles async, shows mapping grid, saves via "儲存" button.

**ActionNode badge:** If `subFlowProfileMapping` has >1 entries → indigo `⚙ 動態配置` badge; if 1 entry → amber `⚙ <profileName>` badge.

### Storage

Flows are stored as `flows/{flowId}.json` in dev mode or `app.getPath('userData')/flows` in production (plain JSON, no database). `ScriptExporter` computes all root-to-leaf paths in the tree and emits one `test()` block per path into `exports/{flowId}.spec.ts`. Optionally extracts a shared prefix into `helpers/{flowId}-helpers.ts`.

### Path aliases (tsconfig + vite config)

| Alias | Resolves to |
|-------|-------------|
| `@shared/*` | `src/shared/*` |
| `@renderer/*` | `src/renderer/*` |

## File Reference

| File | Role |
|------|------|
| `src/main/index.ts` | Electron entry point — creates BrowserWindow, registers IPC handlers |
| `src/main/ipc/ipcHandlers.ts` | Central orchestrator — IPC channel handlers for all 13 Renderer→Main channels; holds singleton BrowserController/Recorder/Replayer |
| `src/main/playwright/browserController.ts` | Wraps playwright-core chromium: launch, context, page, auto-cleanup on disconnect |
| `src/main/playwright/recorder.ts` | Thin wrapper around CodegenCapture; tracks recording state and assertion-picking mode |
| `src/main/playwright/codegenCapture.ts` | Multi-page recorder: injects scripts, exposes `__flowtest_report`, filters navigation events |
| `src/main/playwright/actionCapture.ts` | Single-page variant of CodegenCapture (supports stop/restart without re-injection; not yet active in main flow) |
| `src/main/playwright/captureShared.ts` | Shared utilities: extracts InjectedScript from coreBundle.js, DOM event capture (blacklist-based, Shadow DOM-aware), locator builder, assertion-pick logic, variable helper codegen |
| `src/main/playwright/replayer.ts` | Action/assertion execution; parentId-chain path traversal; fires REPLAY_NODE_* events; constructor takes `(page, baseURL, profileVars?, activeProfileId?)`; resolves `subFlowProfileMapping` for callFlow nodes at any nesting depth |
| `src/main/storage/flowStorage.ts` | Flow CRUD: save/load/list/delete JSON files; sorts by updatedAt |
| `src/main/storage/scriptExporter.ts` | Path computation + `.spec.ts` / `-helpers.ts` code generation; emits `_ftProf_*` declarations from `profileVars`; threads `activeProfileId` through recursive sub-flow expansion via `resolveSubFlowProfileId()`; hoists `captureAs` vars as `let` at test-function scope when `useTestStep` is true; generates `filter({ hasText })` locators for `assertText` nodes whose value is a pure session variable |
| `src/renderer/App.tsx` | Root component — calls `usePlaywrightEvents()` once; renders Toolbar + FlowList + FlowCanvas + PropertyPanel + right sidebar (VariableList / ProfileVarList / SessionVarList) |
| `src/renderer/components/Toolbar/Toolbar.tsx` | Action bar: record/stop/branch/replay/export/run-tests buttons; assertion picker buttons; speed selector; profile selector dropdown; status pills |
| `src/renderer/components/Toolbar/TestOutputModal.tsx` | Modal that streams live `TEST_OUTPUT` lines during `RUN_TESTS` execution |
| `src/renderer/components/Canvas/FlowCanvas.tsx` | ReactFlow canvas: tree layout, right-click to open NodeContextMenu, recording indicator overlay |
| `src/renderer/components/Canvas/NodeContextMenu.tsx` | Context menu for nodes: replay-to-here, branch-from-here, delete node+children |
| `src/renderer/components/Canvas/ActionNode.tsx` | Custom node: action icon + label + description; color-coded type; replay status border; page-nav indicator; callFlow badge: indigo `⚙ 動態配置` (multi-profile mapping) or amber `⚙ <name>` (single) |
| `src/renderer/components/Canvas/BranchEdge.tsx` | Custom bezier edge with optional branch label badge |
| `src/renderer/components/FlowList/FlowList.tsx` | Sidebar: lists flows sorted by updatedAt; highlights current flow |
| `src/renderer/components/PropertyPanel/PropertyPanel.tsx` | Bottom panel: edit description/selector/value for selected node; `assertText` nodes show editable "驗證文字" field, `assertValue` nodes show editable "驗證值" field (both accept `{{variable}}` placeholders); shows "配置對應" mapping grid for callFlow nodes (loads sub-flow profiles async via `FLOW_GET`) |
| `src/renderer/components/ProfileEditor/ProfileEditorModal.tsx` | Two-column modal: left = profile list (add/rename/delete); right = variable table (key synced across profiles, value/description per-profile) |
| `src/renderer/components/CallFlowModal/CallFlowModal.tsx` | 2–3 step modal for embedding a sub-flow: Step 1 = select sub-flow + edit description; Step 2 = select exit node; Step 3 = profile mapping (shown only when sub-flow has >1 profiles) |
| `src/renderer/stores/flowStore.ts` | Zustand store — 11 state fields, 20 actions; profile CRUD + 3 cross-profile sync actions; legacy domain migration; `migrateCallFlowProfiles()` migrates legacy `subFlowProfileId` → `subFlowProfileMapping`; `addProfile`/`deleteProfile` keep callFlow mappings in sync |
| `src/renderer/hooks/usePlaywrightEvents.ts` | 6 IPC event subscriptions: ACTION_CAPTURED, REPLAY_NODE_*, REPLAY_FINISHED/ERROR, ASSERTION_PICK_CANCELLED |
| `src/renderer/hooks/usePlaywright.ts` | IPC invocation wrappers: startRecording, startBranchRecording, stopRecording, replayToNode (builds profileVars from active profile) |
| `src/renderer/hooks/useRecording.ts` | Branch recording state: which node to branch from, branch label |
| `src/renderer/hooks/useFlowStore.ts` | Flow management helpers: refreshFlowList, openFlow, newFlow, saveCurrentFlow |
| `src/renderer/types/electron.d.ts` | TypeScript declaration for `window.electronAPI` |
| `src/shared/types.ts` | All shared types + `IPC_CHANNELS` constants; includes `ProfileVariable`, `FlowProfile` |
| `src/shared/variableResolver.ts` | Variable system: `BUILT_IN_VARIABLES` (3 built-ins), `resolveValue`, `resolveValueWithSession` (takes `profileVars?`), `valueToCodeExpr`, `sessionAwareValueToCodeExpr`, `emitProfileVarDecls`, `VARIABLE_HELPERS_CODE` |
| `src/renderer/components/VariableList/VariableList.tsx` | Sidebar panel — built-in global variables (`{{randomText}}`, `{{randomNumber}}`, `{{timestamp}}`); click to copy |
| `src/renderer/components/ProfileVarList/ProfileVarList.tsx` | Sidebar panel — active profile's variables in amber; shows description + value; click to copy `{{key}}` |
| `src/renderer/components/SessionVarList/SessionVarList.tsx` | Sidebar panel — session variables from `action.captureAs` nodes; click to copy, trash to delete |
| `src/preload/index.ts` | contextBridge — exposes `window.electronAPI` with typed ipcRenderer wrappers |
| `electron.vite.config.ts` | Build config for all three bundles + path aliases |
| `electron-builder.yml` | Installer config (NSIS/AppImage/DMG) |
