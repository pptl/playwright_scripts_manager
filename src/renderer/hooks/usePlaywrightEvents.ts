import { useEffect } from 'react'
import { useFlowStore } from '../stores/flowStore'
import { useProjectStore } from '../stores/projectStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { reportError } from '../stores/errorStore'
import type { Action, AppErrorPayload } from '@shared/types'

/**
 * Re-read the workspace after it may have changed on disk.
 *
 * Skipped outright while recording or replaying: those own the flow, and both
 * are short-lived enough that the next focus event will catch up.
 */
async function reloadFromDisk(): Promise<void> {
  // Nothing to reload before a workspace is open — and storage throws without one.
  if (!useWorkspaceStore.getState().info?.root) return

  const store = useFlowStore.getState()
  if (store.isRecording || store.isReplaying) return

  store.setFlows(await window.electronAPI.listFlows())
  await useProjectStore.getState().refreshProjects()

  // The open project's environments / env vars can have changed too.
  const openProject = useProjectStore.getState().currentProject
  if (openProject) {
    const project = await window.electronAPI.loadProject(openProject.id)
    if (project && project.updatedAt > openProject.updatedAt) {
      const { activeEnvironmentId, setProjectContext } = useProjectStore.getState()
      // Drop an active environment the incoming version no longer defines.
      const envStillDefined = project.environments.some((e) => e.id === activeEnvironmentId)
      setProjectContext(
        project,
        envStillDefined ? activeEnvironmentId : (project.environments[0]?.id ?? null),
      )
    }
  }

  const open = store.currentFlow
  if (!open) return

  const onDisk = await window.electronAPI.loadFlow(open.id)
  if (!onDisk) {
    // Deleted out from under us (a branch that never had it).
    useFlowStore.getState().setCurrentFlow(null)
    return
  }
  // Only take the disk copy when it is genuinely newer — otherwise a focus event
  // during ordinary editing would throw away unsaved in-memory state.
  if (onDisk.updatedAt > open.updatedAt) {
    // setCurrentFlow clears undo history, which is correct: those snapshots
    // describe a version of the flow that no longer exists.
    useFlowStore.getState().setCurrentFlow(onDisk)
  }
}

/**
 * Registers IPC event listeners from the Electron main process.
 * Must be called EXACTLY ONCE — in App.tsx only.
 */
export function usePlaywrightEvents() {
  const { setReplayStatus, setReplayingNode, setIsReplaying } = useFlowStore()

  useEffect(() => {
    const unsubCaptured = window.electronAPI.onActionCaptured((action: Action) => {
      const { currentFlow, addActionNode, recordingHeadId, isRecording } = useFlowStore.getState()
      if (!currentFlow) return
      // Backstop for A2: an action arriving after the UI says recording has stopped would be
      // appended with recordingHeadId === null — i.e. silently dropped onto the canvas as a
      // floating root, on top of whatever else landed at the start position. Main is supposed
      // to make this unreachable; dropping the action is the safer half if it ever isn't.
      if (!isRecording) return

      // Use the explicit recording head (tracks the last added node during recording).
      // addActionNode persists itself.
      addActionNode(action, recordingHeadId)
    })

    const unsubUpdated = window.electronAPI.onActionUpdated(({ actionId, updates }) => {
      // Node id === action id (addActionNode uses action.id as the node id)
      const { currentFlow, updateNode } = useFlowStore.getState()
      const node = currentFlow?.nodes.find((n) => n.id === actionId)
      if (!node) return
      // updateNode persists itself (this isn't a position-only update).
      updateNode(actionId, { action: { ...node.action, ...updates } })
    })

    // Un-record an action the main process decided shouldn't be part of the flow
    // (the click that opened a file chooser). It is always the recording head, so
    // deleting it takes no children with it — but move the head back to its parent
    // first so the action that follows attaches in the right place. deleteNode persists itself.
    const unsubRemoved = window.electronAPI.onActionRemoved((actionId: string) => {
      const { currentFlow, deleteNode, setRecordingHead, recordingHeadId } = useFlowStore.getState()
      const node = currentFlow?.nodes.find((n) => n.id === actionId)
      if (!node) return
      if (recordingHeadId === actionId) setRecordingHead(node.parentId)
      deleteNode(actionId)
    })

    const unsubNodeStart = window.electronAPI.onReplayNodeStart((nodeId: string) => {
      setReplayingNode(nodeId)
      setReplayStatus(nodeId, 'running')
    })

    // The `error` used to be dropped here, which left the user with a red node and no
    // reason for it. It is now kept on the node (ActionNode shows it as a tooltip) and
    // raised once as a toast, since the run stops on the first failure anyway.
    const unsubNodeComplete = window.electronAPI.onReplayNodeComplete(({ nodeId, success, error }) => {
      setReplayStatus(nodeId, success ? 'success' : 'error', error)
      if (!success) reportError('節點執行失敗', undefined, { detail: error })
    })

    const unsubFinished = window.electronAPI.onReplayFinished(() => {
      setReplayingNode(null)
      setIsReplaying(false)
    })

    const unsubError = window.electronAPI.onReplayError((err: string) => {
      setReplayingNode(null)
      setIsReplaying(false)
      reportError('重播失敗', undefined, { detail: err })
    })

    // The user pressed ⏹. Nodes left mid-flight go amber rather than red — they did not
    // fail, they were interrupted. markReplayCancelled also clears replayingNodeId.
    const unsubCancelled = window.electronAPI.onReplayCancelled(() => {
      useFlowStore.getState().markReplayCancelled()
      setIsReplaying(false)
    })

    // The workspace sits in the user's own repo, so a pull or a branch switch can
    // change these files while we hold them in memory — and the next autosave
    // would quietly write our stale copy back over them. Regaining focus is the
    // moment right after the user ran that git command elsewhere.
    const unsubReload = window.electronAPI.onWorkspaceReload(() => {
      void reloadFromDisk()
    })

    // Main's half of the error channel. Subscribe FIRST, then drain: anything main
    // reported before this effect ran is sitting in its buffer, anything after arrives
    // here live, and that ordering means nothing can fall between the two. The drain
    // is what makes startup failures reportable at all — loadSettings runs before the
    // window exists, so a live send then would have had no one to reach.
    const toast = (p: AppErrorPayload): void =>
      reportError(p.title, undefined, { detail: p.detail, tone: p.tone })
    const unsubAppError = window.electronAPI.onAppError(toast)
    void window.electronAPI.drainAppErrors().then((queued) => queued.forEach(toast))

    return () => {
      unsubReload()
      unsubAppError()
      unsubCaptured()
      unsubUpdated()
      unsubRemoved()
      unsubNodeStart()
      unsubNodeComplete()
      unsubFinished()
      unsubError()
      unsubCancelled()
    }
    // Subscribe once for the app's lifetime; every handler reads fresh store state
    // via getState(), so nothing here needs to be in the deps.
  }, [])
}
