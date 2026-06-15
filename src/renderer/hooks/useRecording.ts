import { useState, useCallback } from 'react'
import { useFlowStore } from '../stores/flowStore'
import { usePlaywright } from './usePlaywright'

export type RecordingTarget = 'linear' | 'branch'

export function useRecording() {
  const { isRecording, currentFlow, addActionNode, selectNode } = useFlowStore()
  const { startRecording: _start, stopRecording: _stop } = usePlaywright()

  // Branch recording: from which node to create a branch
  const [branchFromNodeId, setBranchFromNodeId] = useState<string | null>(null)
  const [branchLabel, setBranchLabel] = useState<string>('')

  const startLinearRecording = useCallback(async () => {
    await _start()
  }, [_start])

  const startBranchRecording = useCallback(
    async (fromNodeId: string, label: string) => {
      setBranchFromNodeId(fromNodeId)
      setBranchLabel(label)
      await _start()
    },
    [_start],
  )

  const stopRecording = useCallback(async () => {
    await _stop()
    setBranchFromNodeId(null)
    setBranchLabel('')
  }, [_stop])

  return {
    isRecording,
    branchFromNodeId,
    startLinearRecording,
    startBranchRecording,
    stopRecording,
  }
}
