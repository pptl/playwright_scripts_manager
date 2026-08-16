import { useCallback } from 'react'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { useFlowStore } from '../stores/flowStore'
import { useProjectStore } from '../stores/projectStore'
import { useFlowManager } from './useFlowManager'
import { notify } from '../stores/confirmStore'
import { formatError } from '../stores/errorStore'

/**
 * Opening a different workspace invalidates everything the app is holding: the
 * flow list, the open flow, its project, and the undo snapshots (which reference
 * flow ids that no longer exist here). Order matters — see switchTo.
 */
export function useWorkspace() {
  const { info, loading, installing, vault, setInfo, forget, installBrowser } = useWorkspaceStore()
  const { refreshFlowList } = useFlowManager()

  const resetForNewWorkspace = useCallback(async () => {
    // Both stores must be cleared: setCurrentFlow(null) covers selection and undo history,
    // but the project context now lives in projectStore and would otherwise survive the
    // switch and show the previous workspace's environments.
    useFlowStore.getState().setCurrentFlow(null)
    useFlowStore.getState().setFlows([])
    useProjectStore.getState().reset()
    // The main process already dropped the old key; pick up the new workspace's state
    // (which may auto-unlock from the remembered passphrase).
    await useWorkspaceStore.getState().refreshVault()
    await refreshFlowList()
    await useProjectStore.getState().refreshProjects()
  }, [refreshFlowList])

  /** Guard against swapping the folder out from under a live browser session. */
  const busy = useCallback(async (): Promise<boolean> => {
    const { isRecording, isReplaying } = useFlowStore.getState()
    if (!isRecording && !isReplaying) return false
    await notify({
      title: '無法切換工作區',
      message: isRecording ? '請先停止錄製。' : '請先停止重播。',
      okLabel: '知道了',
    })
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
        await notify({ title: '無法開啟工作區', message: formatError(err), okLabel: '知道了' })
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
