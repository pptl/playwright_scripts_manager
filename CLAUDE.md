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

- **`Action`** — one browser interaction: `type` (`goto|click|fill|selectOption|check|uncheck|press|wait|upload`), `locatorExpr` (high-quality Playwright locator), `selector` (CSS fallback), `value`, `description`, `url`, `isPageNavigation`, optional `assertion`
- **`Assertion`** — `type` (`text|visible|url|count`), `target` selector, `expected` value
- **`FlowNode`** — `Action` + canvas `position` + `parentId` + `childIds[]` + optional `branchLabel`
- **`Flow`** — `nodes: FlowNode[]`, `rootNodeId`, `baseURL`, metadata
- **`RecordingStartPayload`** — `baseURL`, optional `branchFromNodeId` + `branchNodes` + `replaySpeed` for branch recording
- **`ExportConfig`** — `outputDir`, `helperFunctions` (extract common prefix), `useTestStep`

### Recording pipeline

1. `Recorder.start()` → `CodegenCapture.start()` extracts Playwright's `InjectedScript` from `playwright-core/lib/coreBundle.js` at runtime (via `captureShared.ts`) and injects it with `page.addInitScript()`, plus exposes `__flowtest_report` via `page.exposeFunction()`
2. Browser JS calls `__flowtest_report(rawEvent)` on click/fill/selectOption/check/uncheck/press
3. `captureShared.ts` builds Actions with high-quality locators: `getByRole` → `getByLabel` → `getByPlaceholder` → `getByTestId` → `getByText` → `#id` → tag fallback
4. Navigation suppression: events within `NAV_SUPPRESSION_MS = 5000` after a click are not re-recorded as `goto` (redirect side-effects)
5. Each captured action fires `IPC_CHANNELS.ACTION_CAPTURED` → `usePlaywrightEvents` → `flowStore.addActionNode()` → auto-saves JSON

### Replay pipeline

`Replayer.replayToNode()` walks `parentId` pointers from the target node up to the root to build an ordered path, then executes each `Action` sequentially with `executeAction()` / `executeAssertion()`. Assertions support `text`, `visible`, `url`, and `count` types with a 10 s timeout. Each step fires `REPLAY_NODE_START` / `REPLAY_NODE_COMPLETE` events to drive the canvas status badges (running → success/error border colors).

### Branch recording pipeline

When the user clicks "Branch Record" from node N:
1. `startBranchRecording(N)` passes `branchFromNodeId: N` + `branchNodes: flow.nodes` in `RecordingStartPayload`
2. Main process silently replays from root → N using Replayer (50–200 ms/step, no UI events fired)
3. `Recorder.start()` begins WITHOUT navigating to `baseURL` — browser is already at N's page state
4. New actions append as children of N; `recordingHeadId` in the Zustand store tracks the last-added node so subsequent actions chain correctly

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
| `src/main/ipc/ipcHandlers.ts` | Central orchestrator — all 13 IPC channels registered here; holds singleton BrowserController/Recorder/Replayer |
| `src/main/playwright/browserController.ts` | Wraps playwright-core chromium: launch, context, page, auto-cleanup on disconnect |
| `src/main/playwright/recorder.ts` | Thin wrapper around CodegenCapture; tracks recording state |
| `src/main/playwright/codegenCapture.ts` | Multi-page recorder: injects scripts, exposes `__flowtest_report`, filters navigation events |
| `src/main/playwright/actionCapture.ts` | Single-page variant of CodegenCapture (supports stop/restart without re-injection; not yet active in main flow) |
| `src/main/playwright/captureShared.ts` | Shared utilities: extracts InjectedScript from coreBundle.js, DOM event capture logic, locator builder |
| `src/main/playwright/replayer.ts` | Action/assertion execution; parentId-chain path traversal; fires REPLAY_NODE_* events |
| `src/main/storage/flowStorage.ts` | Flow CRUD: save/load/list/delete JSON files; sorts by updatedAt |
| `src/main/storage/scriptExporter.ts` | Path computation + `.spec.ts` / `-helpers.ts` code generation |
| `src/renderer/App.tsx` | Root component — calls `usePlaywrightEvents()` once; renders Toolbar + FlowList + FlowCanvas + PropertyPanel |
| `src/renderer/components/Toolbar/Toolbar.tsx` | Action bar: record/stop/branch/replay/export buttons; speed selector; status pills; new-flow modal |
| `src/renderer/components/Canvas/FlowCanvas.tsx` | ReactFlow canvas: tree layout, context menu (replay/branch/delete), recording indicator overlay |
| `src/renderer/components/Canvas/ActionNode.tsx` | Custom node: action icon + label + description; color-coded type; replay status border; page-nav indicator |
| `src/renderer/components/Canvas/BranchEdge.tsx` | Custom bezier edge with optional branch label badge |
| `src/renderer/components/FlowList/FlowList.tsx` | Sidebar: lists flows sorted by updatedAt; highlights current flow |
| `src/renderer/components/PropertyPanel/PropertyPanel.tsx` | Bottom panel: edit description/selector/value/assertion for selected node |
| `src/renderer/stores/flowStore.ts` | Zustand store — single source of truth: currentFlow, replayStatus, isRecording, isReplaying, recordingHeadId |
| `src/renderer/hooks/usePlaywrightEvents.ts` | IPC event subscriptions from Main (ACTION_CAPTURED, REPLAY_NODE_*, REPLAY_FINISHED/ERROR) |
| `src/renderer/hooks/usePlaywright.ts` | IPC invocation wrappers: startRecording, startBranchRecording, stopRecording, replayToNode |
| `src/renderer/hooks/useRecording.ts` | Branch recording state: which node to branch from, branch label |
| `src/renderer/hooks/useFlowStore.ts` | Flow management helpers: refreshFlowList, openFlow, newFlow, saveCurrentFlow |
| `src/renderer/types/electron.d.ts` | TypeScript declaration for `window.electronAPI` |
| `src/shared/types.ts` | All shared types + `IPC_CHANNELS` constants |
| `src/preload/index.ts` | contextBridge — exposes `window.electronAPI` with typed ipcRenderer wrappers |
| `electron.vite.config.ts` | Build config for all three bundles + path aliases |
| `electron-builder.yml` | Installer config (NSIS/AppImage/DMG) |
