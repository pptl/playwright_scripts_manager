import type { ElectronAPI } from '../../shared/electronAPI'

// The interface itself lives in src/shared/ so preload can pin its object literal to it
// (`satisfies ElectronAPI`). This file only attaches it to `window` for the renderer.
declare global {
  interface Window {
    electronAPI: ElectronAPI
  }

  // Electron's renderer augments dropped File objects with the real filesystem path
  // (WelcomeScreen's onDrop reads it). Before the D3 tsconfig split this typed cleanly
  // only by accident — main's `import ... from 'electron'` pulled in Electron's own
  // ambient `File.path` augmentation into the single Program the whole app shared, and
  // renderer inherited it despite never importing 'electron' itself. Now that renderer
  // is its own isolated project, it needs this declared explicitly.
  interface File {
    readonly path: string
  }
}
