import { useCallback } from 'react'
import { useFlowStore } from '../stores/flowStore'
import type { Flow } from '../../../shared/types'

export function useFlowManager() {
  const { setFlows, createFlow, setCurrentFlow } = useFlowStore()

  const refreshFlowList = useCallback(async () => {
    const list = await window.electronAPI.listFlows()
    setFlows(list)
  }, [setFlows])

  const refreshProjectList = useCallback(async () => {
    const list = await window.electronAPI.listProjects()
    useFlowStore.getState().setProjects(list)
  }, [])

  const openFlow = useCallback(
    async (flowId: string) => {
      const flow = await window.electronAPI.loadFlow(flowId)
      if (!flow) return
      setCurrentFlow(flow)
      // Load project context if this flow belongs to a project
      const store = useFlowStore.getState()
      if (flow.projectId) {
        const project = await window.electronAPI.loadProject(flow.projectId)
        store.setCurrentProject(project)
        // Preserve active env when staying in the same project; reset otherwise
        const sameProject = store.currentProject?.id === flow.projectId
        const envStillValid =
          sameProject &&
          !!store.activeEnvironmentId &&
          !!project?.environments.some((e) => e.id === store.activeEnvironmentId)
        store.setActiveEnvironment(
          envStillValid ? store.activeEnvironmentId : (project?.environments[0]?.id ?? null),
        )
      } else {
        store.setCurrentProject(null)
        store.setActiveEnvironment(null)
      }
    },
    [setCurrentFlow],
  )

  const newFlow = useCallback(
    async (name: string, baseURL: string, description?: string, projectId?: string) => {
      const flow = createFlow(name, baseURL, description)
      const savedFlow = projectId ? { ...flow, projectId } : flow
      if (projectId) useFlowStore.getState().setCurrentFlow(savedFlow)
      await window.electronAPI.saveFlow(savedFlow)
      await refreshFlowList()
      return savedFlow
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

  return { refreshFlowList, refreshProjectList, openFlow, newFlow, saveCurrentFlow, deleteCurrentFlow }
}
