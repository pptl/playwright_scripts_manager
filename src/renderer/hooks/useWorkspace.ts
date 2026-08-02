import { useCallback } from 'react'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { useFlowStore } from '../stores/flowStore'
import { useFlowManager } from './useFlowStore'
import { useConfirmStore } from '../stores/confirmStore'

/** Single-button notice — nothing to decide, just something to acknowledge. */
function notify(title: string, message: string): Promise<string | null> {
  return useConfirmStore.getState().ask({
    title,
    message,
    actions: [{ id: 'ok', label: '知道了', tone: 'primary' }],
    defaultActionId: 'ok',
  })
}

/**
 * Opening a different workspace invalidates everything the app is holding: the
 * flow list, the open flow, its project, and the undo snapshots (which reference
 * flow ids that no longer exist here). Order matters — see switchTo.
 */
export function useWorkspace() {
  const { info, loading, installing, vault, setInfo, forget, installBrowser } = useWorkspaceStore()
  const { refreshFlowList, refreshProjectList } = useFlowManager()

  const resetForNewWorkspace = useCallback(async () => {
    // setCurrentFlow(null) also clears selection, project, active environment and
    // the undo history in one go.
    useFlowStore.getState().setCurrentFlow(null)
    useFlowStore.getState().setFlows([])
    useFlowStore.getState().setProjects([])
    // The main process already dropped the old key; pick up the new workspace's state
    // (which may auto-unlock from the remembered passphrase).
    await useWorkspaceStore.getState().refreshVault()
    await refreshFlowList()
    await refreshProjectList()
  }, [refreshFlowList, refreshProjectList])

  /** Guard against swapping the folder out from under a live browser session. */
  const busy = useCallback(async (): Promise<boolean> => {
    const { isRecording, isReplaying } = useFlowStore.getState()
    if (!isRecording && !isReplaying) return false
    await notify('無法切換工作區', isRecording ? '請先停止錄製。' : '請先停止重播。')
    return true
  }, [])

  const pick = useCallback(async () => {
    if (await busy()) return
    const next = await window.electronAPI.pickWorkspace()
    if (!next) return // cancelled
    setInfo(next)
    await resetForNewWorkspace()
  }, [busy, setInfo, resetForNewWorkspace])

  const switchTo = useCallback(
    async (dir: string) => {
      if (await busy()) return
      try {
        setInfo(await window.electronAPI.setWorkspace(dir))
      } catch (err) {
        // Most likely the folder was moved or deleted since it was remembered.
        await notify('無法開啟工作區', String(err instanceof Error ? err.message : err))
        await forget(dir)
        return
      }
      await resetForNewWorkspace()
    },
    [busy, setInfo, forget, resetForNewWorkspace],
  )

  return {
    info,
    loading,
    installing,
    vault,
    root: info?.root ?? null,
    pick,
    switchTo,
    forget,
    installBrowser,
    reveal: () => window.electronAPI.revealWorkspace(),
  }
}
