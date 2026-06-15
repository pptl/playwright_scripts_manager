import { useCallback } from 'react'
import { useFlowStore } from '../stores/flowStore'

/**
 * Returns action functions for controlling Playwright (record / replay).
 * Does NOT set up IPC subscriptions — use usePlaywrightEvents in App.tsx for that.
 */
export function usePlaywright() {
  const { setIsRecording, setIsReplaying, clearReplayStatus } = useFlowStore()

  const startRecording = useCallback(async () => {
    const flow = useFlowStore.getState().currentFlow
    if (!flow) return
    setIsRecording(true)
    try {
      await window.electronAPI.startRecording({ baseURL: flow.baseURL })
    } catch (err) {
      setIsRecording(false)
      console.error('Failed to start recording:', err)
    }
  }, [setIsRecording])

  const startBranchRecording = useCallback(
    async (fromNodeId: string) => {
      const flow = useFlowStore.getState().currentFlow
      if (!flow) return
      // Set recording head so new actions append as children of this node
      useFlowStore.getState().setRecordingHead(fromNodeId)
      setIsRecording(true)
      try {
        await window.electronAPI.startRecording({
          baseURL: flow.baseURL,
          branchFromNodeId: fromNodeId,
          branchNodes: flow.nodes,
          replaySpeed: 200,
        })
      } catch (err) {
        setIsRecording(false)
        useFlowStore.getState().setRecordingHead(null)
        console.error('Failed to start branch recording:', err)
      }
    },
    [setIsRecording],
  )

  const stopRecording = useCallback(async () => {
    try {
      await window.electronAPI.stopRecording()
    } catch (err) {
      console.error('Failed to stop recording:', err)
    } finally {
      setIsRecording(false)
      useFlowStore.getState().setRecordingHead(null)
      const flow = useFlowStore.getState().currentFlow
      if (flow) await window.electronAPI.saveFlow(flow).catch(console.error)
    }
  }, [setIsRecording])

  const replayToNode = useCallback(
    async (targetNodeId: string, speed: number) => {
      const flow = useFlowStore.getState().currentFlow
      if (!flow) return
      clearReplayStatus()
      setIsReplaying(true)
      try {
        await window.electronAPI.replayToNode(flow.nodes, targetNodeId, speed)
      } catch (err) {
        console.error('Replay IPC error:', err)
      } finally {
        setIsReplaying(false)
      }
    },
    [clearReplayStatus, setIsReplaying],
  )

  return { startRecording, startBranchRecording, stopRecording, replayToNode }
}

