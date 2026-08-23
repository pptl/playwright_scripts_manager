import { useCallback } from 'react'
import { useFlowStore } from '../stores/flowStore'
import { useProjectStore } from '../stores/projectStore'
import { persistFlow } from '../stores/persistence'
import type { Flow } from '@shared/types'
import { DEFAULT_PROJECT_ID, DEFAULT_DOMAIN, DOMAIN_ENV_KEY, isCallFlowAction } from '@shared/types'
import { flattenProjectEnvVars } from '@shared/variableResolver'
import { resolveProjectId } from '@shared/projectResolution'
import { v4 as uuidv4 } from 'uuid'

/**
 * The flow↔project coordinator. `flowStore` and `projectStore` never import each other —
 * every sequence that spans both domains lives here, which is what keeps each store
 * readable as a closed unit.
 */
// Bumped on every openFlow call, compared after each await, so a call superseded by a
// newer one (rapid clicks in FlowList) bails instead of committing stale state on top.
let openFlowRequestId = 0

export function useFlowManager() {
  const { setFlows, createFlow, setCurrentFlow } = useFlowStore()

  const refreshFlowList = useCallback(async () => {
    const list = await window.electronAPI.listFlows()
    setFlows(list)
  }, [setFlows])

  const openFlow = useCallback(
    async (flowId: string) => {
      const requestId = ++openFlowRequestId
      const flow = await window.electronAPI.loadFlow(flowId)
      if (!flow || requestId !== openFlowRequestId) return
      // Read the OUTGOING project context before anything changes it — that is what decides
      // whether the active environment can be carried over.
      const { projects, currentProject, activeEnvironmentId } = useProjectStore.getState()
      // Every flow belongs to a project — flows with no (or an unknown) projectId
      // fall back to the reserved default project ("未分類").
      const pid = resolveProjectId(flow, new Set(projects.map((p) => p.id)))
      const stayingInProject = currentProject?.id === pid
      const prevEnvId = activeEnvironmentId

      setCurrentFlow(flow)
      const project = await window.electronAPI.loadProject(pid)
      if (requestId !== openFlowRequestId) return
      // Preserve the active environment when staying in the same project; reset otherwise.
      const keepEnv =
        stayingInProject && !!prevEnvId && !!project?.environments.some((e) => e.id === prevEnvId)
      useProjectStore
        .getState()
        .setProjectContext(project, keepEnv ? prevEnvId : (project?.environments[0]?.id ?? null))
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
      await persistFlow(savedFlow, { label: '新增流程存檔失敗' })
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

  /** Deleting a project deletes every flow that belongs to it — no orphans left behind. */
  const deleteProjectWithFlows = useCallback(
    async (projectId: string) => {
      const all = await window.electronAPI.listFlows()
      const doomed = all.filter((f) => (f.projectId ?? DEFAULT_PROJECT_ID) === projectId)
      for (const f of doomed) {
        await window.electronAPI.deleteFlow(f.id)
      }
      await useProjectStore.getState().deleteProject(projectId)
      // Membership in the list we just deleted — not a second ownership predicate that
      // would have to be kept in step with the filter above.
      const { currentFlow, setCurrentFlow: closeFlow } = useFlowStore.getState()
      if (currentFlow && doomed.some((f) => f.id === currentFlow.id)) closeFlow(null)
      await refreshFlowList()
    },
    [refreshFlowList],
  )

  /** Duplicate a project together with all flows that belong to it. */
  const duplicateProjectWithFlows = useCallback(
    async (projectId: string) => {
      const newProject = await useProjectStore.getState().duplicateProject(projectId)
      if (!newProject) return
      const now = new Date().toISOString()

      // Copy every flow belonging to the source project. Node/profile ids are kept verbatim
      // (so subFlowExitNodeId / subFlowProfileMapping stay valid); only flow ids change.
      const all = await window.electronAPI.listFlows()
      const sourceFlows = all.filter((f) => (f.projectId ?? DEFAULT_PROJECT_ID) === projectId)
      const idMap = new Map<string, string>()
      sourceFlows.forEach((f) => idMap.set(f.id, uuidv4()))

      for (const item of sourceFlows) {
        const flow = await window.electronAPI.getFlow(item.id)
        if (!flow) continue
        const copy: Flow = {
          ...flow,
          id: idMap.get(item.id)!,
          projectId: newProject.id,
          createdAt: now,
          updatedAt: now,
          // Rewrite callFlow references that point at a sibling flow copied in this batch,
          // so the copies call each other instead of the originals.
          nodes: flow.nodes.map((node) => {
            if (isCallFlowAction(node.action) && idMap.has(node.action.subFlowId)) {
              return { ...node, action: { ...node.action, subFlowId: idMap.get(node.action.subFlowId)! } }
            }
            return node
          }),
        }
        await persistFlow(copy)
      }
      await refreshFlowList()
    },
    [refreshFlowList],
  )

  return {
    refreshFlowList,
    openFlow,
    newFlow,
    deleteCurrentFlow,
    deleteProjectWithFlows,
    duplicateProjectWithFlows,
  }
}
