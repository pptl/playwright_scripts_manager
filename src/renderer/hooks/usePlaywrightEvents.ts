import { useEffect } from 'react'
import { useFlowStore } from '../stores/flowStore'
import type { Action } from '../../../shared/types'

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

    return () => {
      unsubCaptured()
      unsubNodeStart()
      unsubNodeComplete()
      unsubFinished()
      unsubError()
      unsubAssertCancelled()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
