import { useCallback } from 'react'
import { useWorkspaceStore } from '../stores/workspaceStore'

/**
 * Gestures around private data. The vault key lives in the main process, so everything
 * here is either a state query or a request that crosses the bridge.
 */
export function useVault() {
  const vault = useWorkspaceStore((s) => s.vault)
  const openVaultDialog = useWorkspaceStore((s) => s.openVaultDialog)

  const state = vault?.state ?? 'none'

  /**
   * Make the vault usable before writing a private value, opening whichever dialog is
   * needed. Returns false when the caller must abort — either the vault is still being
   * created/unlocked (the dialog is now up) or the user will cancel.
   *
   * Callers re-check `state` after the dialog closes rather than awaiting it, so that
   * marking a value private is always an explicit two-step gesture.
   */
  const ensureUsable = useCallback((): boolean => {
    if (state === 'unlocked') return true
    openVaultDialog(
      state === 'none' ? 'setup' : 'unlock',
      state === 'none'
        ? '要使用私密資料，請先為這個工作區建立保險庫。'
        : '保險庫已鎖定，請先輸入通行碼。',
    )
    return false
  }, [state, openVaultDialog])

  /** Open the unlock dialog because an operation was refused. */
  const promptUnlock = useCallback(
    (reason: string) => openVaultDialog('unlock', reason),
    [openVaultDialog],
  )

  const lock = useCallback(async () => {
    useWorkspaceStore.getState().setVault(await window.electronAPI.lockVault())
  }, [])

  return {
    state,
    /** True when private values can be read and written right now. */
    usable: state === 'unlocked',
    /** True when this workspace has any private data at all. */
    hasVault: state !== 'none',
    canRemember: vault?.canRemember ?? false,
    ensureUsable,
    promptUnlock,
    lock,
    openVaultDialog,
  }
}
