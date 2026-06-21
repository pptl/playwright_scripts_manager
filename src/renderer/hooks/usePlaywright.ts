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
      const { currentFlow, activeProfileId } = useFlowStore.getState()
      if (!currentFlow) return
      // Set recording head so new actions append as children of this node
      useFlowStore.getState().setRecordingHead(fromNodeId)
      setIsRecording(true)

      const activeProfile = currentFlow.profiles?.find((p) => p.id === activeProfileId)
      const profileVars = activeProfile
        ? Object.fromEntries(activeProfile.vars.map((v) => [v.key, v.value]))
        : undefined

      try {
        await window.electronAPI.startRecording({
          baseURL: currentFlow.baseURL,
          branchFromNodeId: fromNodeId,
          branchNodes: currentFlow.nodes,
          replaySpeed: 200,
          profileVars,
          activeProfileId: activeProfileId ?? undefined,
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
      const { currentFlow, activeProfileId } = useFlowStore.getState()
      if (!currentFlow) return
      clearReplayStatus()
      setIsReplaying(true)

      // Build profileVars from active profile
      const activeProfile = currentFlow.profiles?.find((p) => p.id === activeProfileId)
      const profileVars = activeProfile
        ? Object.fromEntries(activeProfile.vars.map((v) => [v.key, v.value]))
        : undefined

      try {
        await window.electronAPI.replayToNode(
          currentFlow.nodes,
          targetNodeId,
          speed,
          currentFlow.baseURL,
          profileVars,
          activeProfileId ?? undefined,
        )
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
