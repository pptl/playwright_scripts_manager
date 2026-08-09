import type { ElectronAPI } from '../../shared/electronAPI'

// The interface itself lives in src/shared/ so preload can pin its object literal to it
// (`satisfies ElectronAPI`). This file only attaches it to `window` for the renderer.
declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
