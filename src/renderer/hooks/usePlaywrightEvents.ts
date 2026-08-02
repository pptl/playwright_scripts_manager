import { useEffect } from 'react'
import { useFlowStore } from '../stores/flowStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import type { Action } from '@shared/types'

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
  store.setProjects(await window.electronAPI.listProjects())

  // The open project's environments / env vars can have changed too.
  const openProject = store.currentProject
  if (openProject) {
    const project = await window.electronAPI.loadProject(openProject.id)
    if (project && project.updatedAt > openProject.updatedAt) {
      const s = useFlowStore.getState()
      s.setCurrentProject(project)
      // Drop an active environment the incoming version no longer defines.
      if (!project.environments.some((e) => e.id === s.activeEnvironmentId)) {
        s.setActiveEnvironment(project.environments[0]?.id ?? null)
      }
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
      const { currentFlow, addActionNode, recordingHeadId, setIsPickingAssertion } = useFlowStore.getState()
      if (!currentFlow) return

      setIsPickingAssertion(false)

      // Use the explicit recording head (tracks the last added node during recording)
      addActionNode(action, recordingHeadId)

      // Auto-save
      const updated = useFlowStore.getState().currentFlow
      if (updated) window.electronAPI.saveFlow(updated).catch(console.error)
    })

    const unsubUpdated = window.electronAPI.onActionUpdated(({ actionId, updates }) => {
      // Node id === action id (addActionNode uses action.id as the node id)
      const { currentFlow, updateNode } = useFlowStore.getState()
      const node = currentFlow?.nodes.find((n) => n.id === actionId)
      if (!node) return
      updateNode(actionId, { action: { ...node.action, ...updates } })
      const updated = useFlowStore.getState().currentFlow
      if (updated) window.electronAPI.saveFlow(updated).catch(console.error)
    })

    // Un-record an action the main process decided shouldn't be part of the flow
    // (the click that opened a file chooser). It is always the recording head, so
    // deleting it takes no children with it — but move the head back to its parent
    // first so the action that follows attaches in the right place.
    const unsubRemoved = window.electronAPI.onActionRemoved((actionId: string) => {
      const { currentFlow, deleteNode, setRecordingHead, recordingHeadId } = useFlowStore.getState()
      const node = currentFlow?.nodes.find((n) => n.id === actionId)
      if (!node) return
      if (recordingHeadId === actionId) setRecordingHead(node.parentId)
      deleteNode(actionId)
      const updated = useFlowStore.getState().currentFlow
      if (updated) window.electronAPI.saveFlow(updated).catch(console.error)
    })

    const unsubNodeStart = window.electronAPI.onReplayNodeStart((nodeId: string) => {
      setReplayingNode(nodeId)
      setReplayStatus(nodeId, 'running')
    })

    const unsubNodeComplete = window.electronAPI.onReplayNodeComplete(({ nodeId, success }) => {
      setReplayStatus(nodeId, success ? 'success' : 'error')
    })

    const unsubFinished = window.electronAPI.onReplayFinished(() => {
      setReplayingNode(null)
      setIsReplaying(false)
    })

    const unsubError = window.electronAPI.onReplayError((err: string) => {
      setReplayingNode(null)
      setIsReplaying(false)
      console.error('Replay error:', err)
    })

    const unsubAssertCancelled = window.electronAPI.onAssertionPickCancelled(() => {
      useFlowStore.getState().setIsPickingAssertion(false)
    })

    const unsubLocatorPick = window.electronAPI.onLocatorPickNeeded((payload) => {
      useFlowStore.getState().setPendingLocatorPick(payload)
    })

    // The workspace sits in the user's own repo, so a pull or a branch switch can
    // change these files while we hold them in memory — and the next autosave
    // would quietly write our stale copy back over them. Regaining focus is the
    // moment right after the user ran that git command elsewhere.
    const unsubReload = window.electronAPI.onWorkspaceReload(() => {
      void reloadFromDisk()
    })

    return () => {
      unsubReload()
      unsubCaptured()
      unsubUpdated()
      unsubRemoved()
      unsubNodeStart()
      unsubNodeComplete()
      unsubFinished()
      unsubError()
      unsubAssertCancelled()
      unsubLocatorPick()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
