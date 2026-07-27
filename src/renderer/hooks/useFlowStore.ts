import { useCallback } from 'react'
import { useFlowStore } from '../stores/flowStore'
import { DEFAULT_PROJECT_ID, DEFAULT_DOMAIN, DOMAIN_ENV_KEY } from '@shared/types'
import { flattenProjectEnvVars } from '@shared/variableResolver'
import { ensureNoUnsavedDrafts } from './useDraftForm'

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
      // Switching flows discards every open draft — prompt before losing unsaved edits.
      if (!(await ensureNoUnsavedDrafts())) return
      const flow = await window.electronAPI.loadFlow(flowId)
      if (!flow) return
      setCurrentFlow(flow)
      // Every flow belongs to a project — flows with no (or an unknown) projectId
      // fall back to the reserved default project ("未分類").
      const store = useFlowStore.getState()
      const pid = flow.projectId ?? DEFAULT_PROJECT_ID
      const project = await window.electronAPI.loadProject(pid)
      store.setCurrentProject(project)
      // Preserve active env when staying in the same project; reset otherwise
      const sameProject = store.currentProject?.id === pid
      const envStillValid =
        sameProject &&
        !!store.activeEnvironmentId &&
        !!project?.environments.some((e) => e.id === store.activeEnvironmentId)
      store.setActiveEnvironment(
        envStillValid ? store.activeEnvironmentId : (project?.environments[0]?.id ?? null),
      )
    },
    [setCurrentFlow],
  )

  const newFlow = useCallback(
    async (name: string, projectId?: string, description?: string) => {
      // baseURL is no longer entered by the user — derive it from the target project's
      // first-environment `domain` env var (the recording origin / substitution basis).
      const pid = projectId ?? DEFAULT_PROJECT_ID
      const project = await window.electronAPI.loadProject(pid)
      const baseURL =
        flattenProjectEnvVars(project?.envVars, project?.environments[0]?.id)[DOMAIN_ENV_KEY] || DEFAULT_DOMAIN
      const flow = createFlow(name, baseURL, description)
      const savedFlow = projectId ? { ...flow, projectId } : flow
      if (projectId) useFlowStore.getState().setCurrentFlow(savedFlow)
      await window.electronAPI.saveFlow(savedFlow)
      await refreshFlowList()
      return savedFlow
    },
    [createFlow, refreshFlowList],
  )

  const deleteCurrentFlow = useCallback(async () => {
    const flow = useFlowStore.getState().currentFlow
    if (!flow) return
    await window.electronAPI.deleteFlow(flow.id)
    setCurrentFlow(null)
    await refreshFlowList()
  }, [setCurrentFlow, refreshFlowList])

  return { refreshFlowList, refreshProjectList, openFlow, newFlow, deleteCurrentFlow }
}
