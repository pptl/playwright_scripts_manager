import { create } from 'zustand'
import type { WorkspaceInfo } from '@shared/types'

/**
 * Which folder the app is reading and writing. Kept out of flowStore because it
 * outlives every flow: switching it invalidates the whole flow list, and nothing
 * in storage can be touched before one is chosen.
 */
interface WorkspaceStore {
  info: WorkspaceInfo | null
  /** True until the first getWorkspace() resolves — gates the initial render. */
  loading: boolean
  installing: boolean

  load: () => Promise<void>
  setInfo: (info: WorkspaceInfo) => void
  forget: (dir: string) => Promise<void>
  installBrowser: () => Promise<void>
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  info: null,
  loading: true,
  installing: false,

  load: async () => {
    const info = await window.electronAPI.getWorkspace()
    set({ info, loading: false })
  },

  setInfo: (info) => set({ info, loading: false }),

  forget: async (dir) => {
    set({ info: await window.electronAPI.forgetWorkspace(dir) })
  },

  installBrowser: async () => {
    set({ installing: true })
    try {
      await window.electronAPI.installBrowser()
      set({ info: await window.electronAPI.getWorkspace() })
    } finally {
      set({ installing: false })
    }
  },
}))
