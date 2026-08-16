import { useCallback } from 'react'
import { useFlowStore } from '../stores/flowStore'
import { useProjectStore } from '../stores/projectStore'
import type { Flow } from '@shared/types'
import { DOMAIN_ENV_KEY } from '@shared/types'
import { buildResolutionContext, getEnvVars } from '../utils/varMaps'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { notify } from '../stores/confirmStore'
import { reportError, formatError } from '../stores/errorStore'
import { persistFlow } from '../stores/persistence'

/**
 * Refuse anything that would drive a real browser while private values are unreadable,
 * and raise the unlock dialog. Blanket rather than "only when a secret is involved" —
 * failing loudly beats silently typing `enc:v1:…` into a login form.
 */
function blockedByLock(reason: string): boolean {
  const { vault, openVaultDialog } = useWorkspaceStore.getState()
  if (!vault || vault.state !== 'locked') return false
  openVaultDialog('unlock', reason)
  return true
}

/**
 * Returns action functions for controlling Playwright (record / replay).
 * Does NOT set up IPC subscriptions — use usePlaywrightEvents in App.tsx for that.
 */
export function usePlaywright() {
  const { setIsRecording, setIsReplaying, clearReplayStatus } = useFlowStore()

  const startRecording = useCallback(async () => {
    const flow = useFlowStore.getState().currentFlow
    const { currentProject, activeEnvironmentId } = useProjectStore.getState()
    if (!flow) return
    // The recording origin is the active environment's `domain` env var (falling back to the
    // flow's existing baseURL). Persist it as baseURL so replay/export origin substitution
    // matches the origin recorded against.
    const domain = getEnvVars(currentProject, activeEnvironmentId)[DOMAIN_ENV_KEY] || flow.baseURL
    setIsRecording(true)
    try {
      const { started } = await window.electronAPI.startRecording({ baseURL: domain })
      // Stopped before recording ever got under way — nothing else will clear this.
      if (!started) {
        setIsRecording(false)
        useFlowStore.getState().setRecordingHead(null)
        return
      }
      if (domain && domain !== flow.baseURL) {
        const updated: Flow = { ...flow, baseURL: domain }
        useFlowStore.setState({ currentFlow: updated })
        await persistFlow(updated, { label: '流程存檔失敗' })
      }
    } catch (err) {
      setIsRecording(false)
      // A modal, not a toast: the user pressed ▶ and is looking at a browser that never
      // opened. This is the failure they are standing there waiting for.
      await notify({ title: '無法開始錄製', message: formatError(err) })
    }
  }, [setIsRecording])

  const startBranchRecording = useCallback(
    async (fromNodeId: string) => {
      const { currentFlow, activeProfileId } = useFlowStore.getState()
      const { currentProject, activeEnvironmentId } = useProjectStore.getState()
      if (!currentFlow) return
      // Branch recording silently replays to the branch point first, which may type
      // private values into the page.
      if (blockedByLock('分支錄製會先重播到該節點，需要讀取私密資料。請先解鎖。')) return
      // Set recording head so new actions append as children of this node
      useFlowStore.getState().setRecordingHead(fromNodeId)
      // Set BEFORE the await, so ⏹ exists during the silent replay that runs first — that
      // stop is now honoured by main, which is what makes showing the button honest.
      setIsRecording(true)

      try {
        const { started } = await window.electronAPI.startRecording({
          baseURL: currentFlow.baseURL,
          branchFromNodeId: fromNodeId,
          branchNodes: currentFlow.nodes,
          replaySpeed: 200,
          ctx: buildResolutionContext(currentFlow, activeProfileId, activeEnvironmentId, currentProject),
        })
        // Stopped during the silent replay: no recorder was ever built, so no action will
        // arrive. stopRecording has already cleared both of these — this is for the case
        // where main abandoned the start for its own reasons.
        if (!started) {
          setIsRecording(false)
          useFlowStore.getState().setRecordingHead(null)
        }
      } catch (err) {
        setIsRecording(false)
        useFlowStore.getState().setRecordingHead(null)
        await notify({ title: '無法開始分支錄製', message: formatError(err) })
      }
    },
    [setIsRecording],
  )

  const stopRecording = useCallback(async () => {
    try {
      await window.electronAPI.stopRecording()
    } catch (err) {
      // Toast, not a modal: this is a teardown path, and stacking a dialog on top of a
      // failed stop only gets in the way of whatever the user does to recover.
      reportError('停止錄製失敗', err)
    } finally {
      setIsRecording(false)
      useFlowStore.getState().setRecordingHead(null)
      const flow = useFlowStore.getState().currentFlow
      if (flow) {
        await persistFlow(flow, { label: '錄製結束後存檔失敗' })
      }
    }
  }, [setIsRecording])

  const cancelReplay = useCallback(async () => {
    try {
      await window.electronAPI.cancelReplay()
    } catch (err) {
      reportError('停止重播失敗', err)
    }
    // Deliberately no setIsReplaying(false) here — REPLAY_CANCELLED owns that, exactly as
    // REPLAY_FINISHED does. Clearing it locally would unblock reloadFromDisk and the undo
    // subscription while the main process is still unwinding the run.
  }, [])

  const replayToNode = useCallback(
    async (targetNodeId: string, speed: number) => {
      const { currentFlow, activeProfileId } = useFlowStore.getState()
      const { currentProject, activeEnvironmentId } = useProjectStore.getState()
      if (!currentFlow) return
      if (blockedByLock('重播需要讀取私密資料，請先解鎖。')) return
      clearReplayStatus()
      setIsReplaying(true)

      try {
        await window.electronAPI.replayToNode(
          currentFlow.nodes,
          targetNodeId,
          speed,
          currentFlow.baseURL,
          buildResolutionContext(currentFlow, activeProfileId, activeEnvironmentId, currentProject),
        )
      } catch (err) {
        // The bridge itself failed, so no REPLAY_ERROR is coming — this is the only
        // place this particular failure can be reported from.
        reportError('重播失敗', err)
      } finally {
        setIsReplaying(false)
      }
    },
    [clearReplayStatus, setIsReplaying],
  )

  return { startRecording, startBranchRecording, stopRecording, replayToNode, cancelReplay }
}
