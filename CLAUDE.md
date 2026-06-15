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
  ├── CodegenCapture
  ├── FlowStorage
  └── ScriptExporter
```

### IPC as the central seam

`src/main/ipc/ipcHandlers.ts` is the **only file** that coordinates Main process modules. All Renderer ↔ Main communication goes through `IPC_CHANNELS` constants defined in `src/shared/types.ts`. The preload bridge (`src/preload/index.ts`) exposes `window.electronAPI` with typed wrappers for every channel.

Renderer → Main: `window.electronAPI.<method>()` → `ipcMain.handle(channel, ...)`
Main → Renderer: `mainWindow.webContents.send(channel, payload)` → `usePlaywrightEvents` hook

### Key data types (`src/shared/types.ts`)

- **`Action`** — one browser interaction: `type`, `locatorExpr` (high-quality Playwright locator), `selector` (CSS fallback), `value`, `description`, `url`, optional `assertion`
- **`FlowNode`** — `Action` + canvas position + `parentId` + `childIds[]` + optional `branchLabel`
- **`Flow`** — `nodes: FlowNode[]`, `rootNodeId`, `baseURL`, metadata

### Recording pipeline

1. `Recorder.start()` → `CodegenCapture.start()` injects `pageScript` (DOM event capture) + `page.exposeFunction('__flowtest_report', ...)` so the browser can call Node.js
2. `CodegenCapture.processEvent()` generates high-quality locators via a priority chain: `getByRole` → `getByLabel` → `getByPlaceholder` → `getByTestId` → `getByText` → `#id` → tag
3. Each captured action fires `IPC_CHANNELS.ACTION_CAPTURED` → `usePlaywrightEvents` → `flowStore.addActionNode()` → auto-saves JSON

### Replay pipeline

`Replayer.replayToNode()` walks `parentId` pointers from the target node up to the root to build an ordered path, then executes each `Action` sequentially with `executeAction()` / `executeAssertion()`. Each step fires `REPLAY_NODE_START` / `REPLAY_NODE_COMPLETE` events to drive the canvas status badges.

### Branch recording pipeline

When the user clicks "Branch Record" from node N:
1. Silent replay runs from root → node N (page is now in exact state as when N was recorded)
2. `Recorder.start()` begins WITHOUT navigating to `baseURL`
3. New actions are appended as children of N in the flow tree

### Storage

Flows are stored as `flows/{flowId}.json` (plain JSON, no database). `ScriptExporter` computes all root-to-leaf paths in the tree and emits one `test()` block per path into `exports/{flowId}.spec.ts`.

### Path aliases (tsconfig + vite config)

| Alias | Resolves to |
|-------|-------------|
| `@shared/*` | `src/shared/*` |
| `@renderer/*` | `src/renderer/*` |

## File Reference

| File | Role |
|------|------|
| `src/main/ipc/ipcHandlers.ts` | Central orchestrator — all IPC channels registered here |
| `src/main/playwright/codegenCapture.ts` | Core recording: browser script injection + locator generation |
| `src/main/playwright/replayer.ts` | Action/assertion execution; path traversal |
| `src/main/storage/scriptExporter.ts` | Template-based `.spec.ts` generation; path computation |
| `src/renderer/stores/flowStore.ts` | Zustand store — single source of truth for all UI state |
| `src/renderer/hooks/usePlaywrightEvents.ts` | IPC event subscriptions from Main process |
| `src/renderer/hooks/usePlaywright.ts` | IPC invocation wrappers |
| `src/shared/types.ts` | All shared types + `IPC_CHANNELS` constants |
| `electron.vite.config.ts` | Build config for all three bundles |
| `electron-builder.yml` | Installer config (NSIS/AppImage/DMG) |
