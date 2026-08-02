import { create } from 'zustand'
import type { VaultStatus, WorkspaceInfo } from '@shared/types'

/**
 * Which folder the app is reading and writing. Kept out of flowStore because it
 * outlives every flow: switching it invalidates the whole flow list, and nothing
 * in storage can be touched before one is chosen.
 *
 * The vault belongs here for the same reason — it is a property of the workspace,
 * and its key is dropped whenever the workspace changes.
 */
interface WorkspaceStore {
  info: WorkspaceInfo | null
  /** True until the first getWorkspace() resolves — gates the initial render. */
  loading: boolean
  installing: boolean
  /** Private-data state of the open workspace. Null until the first probe resolves. */
  vault: VaultStatus | null
  /** The vault dialog to show, if any. `reason` explains what triggered it. */
  vaultDialog: { mode: 'setup' | 'unlock' | 'change'; reason?: string } | null

  load: () => Promise<void>
  setInfo: (info: WorkspaceInfo) => void
  forget: (dir: string) => Promise<void>
  installBrowser: () => Promise<void>
  refreshVault: () => Promise<VaultStatus>
  setVault: (vault: VaultStatus) => void
  openVaultDialog: (mode: 'setup' | 'unlock' | 'change', reason?: string) => void
  closeVaultDialog: () => void
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  info: null,
  loading: true,
  installing: false,
  vault: null,
  vaultDialog: null,

  load: async () => {
    const info = await window.electronAPI.getWorkspace()
    set({ info, loading: false })
    if (info.root) set({ vault: await window.electronAPI.getVaultStatus() })
  },

  setInfo: (info) => set({ info, loading: false }),

  // Also runs the main process's auto-unlock attempt against the remembered passphrase.
  refreshVault: async () => {
    const vault = await window.electronAPI.getVaultStatus()
    set({ vault })
    return vault
  },

  setVault: (vault) => set({ vault }),

  openVaultDialog: (mode, reason) => set({ vaultDialog: { mode, reason } }),
  closeVaultDialog: () => set({ vaultDialog: null }),

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
