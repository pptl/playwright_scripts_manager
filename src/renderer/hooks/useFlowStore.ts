import { useCallback } from 'react'
import { useFlowStore } from '../stores/flowStore'
import type { Flow } from '../../../shared/types'

export function useFlowManager() {
  const { setFlows, createFlow, setCurrentFlow } = useFlowStore()

  const refreshFlowList = useCallback(async () => {
    const list = await window.electronAPI.listFlows()
    setFlows(list)
  }, [setFlows])

  const openFlow = useCallback(
    async (flowId: string) => {
      const flow = await window.electronAPI.loadFlow(flowId)
      if (flow) setCurrentFlow(flow)
    },
    [setCurrentFlow],
  )

  const newFlow = useCallback(
    async (name: string, baseURL: string, description?: string) => {
      const flow = createFlow(name, baseURL, description)
      await window.electronAPI.saveFlow(flow)
      await refreshFlowList()
      return flow
    },
    [createFlow, refreshFlowList],
  )

  const saveCurrentFlow = useCallback(async () => {
    const flow = useFlowStore.getState().currentFlow
    if (!flow) return
    await window.electronAPI.saveFlow(flow)
  }, [])

  const deleteCurrentFlow = useCallback(async () => {
    const flow = useFlowStore.getState().currentFlow
    if (!flow) return
    await window.electronAPI.deleteFlow(flow.id)
    setCurrentFlow(null)
    await refreshFlowList()
  }, [setCurrentFlow, refreshFlowList])

  return { refreshFlowList, openFlow, newFlow, saveCurrentFlow, deleteCurrentFlow }
}
