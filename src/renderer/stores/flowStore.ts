import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { Flow, FlowNode, Action, NodePosition, FlowProfile, Project, ProjectEnvironment, LocatorPickPayload } from '../../shared/types'

const NODE_VERTICAL_GAP = 80
const NODE_START_Y = 50
const NODE_START_X = 300

interface FlowStore {
  // State
  flows: Pick<Flow, 'id' | 'name' | 'description' | 'updatedAt' | 'projectId'>[]
  currentFlow: Flow | null
  selectedNodeId: string | null
  replayingNodeId: string | null
  replayStatus: Record<string, 'running' | 'success' | 'error'>
  isRecording: boolean
  isReplaying: boolean
  /** The node ID that new recorded actions should be appended to */
  recordingHeadId: string | null
  replaySpeed: number

  // Flow management
  setFlows: (flows: FlowStore['flows']) => void
  createFlow: (name: string, baseURL: string, description?: string) => Flow
  setCurrentFlow: (flow: Flow | null) => void
  setRecordingHead: (id: string | null) => void
  renameCurrentFlow: (name: string) => Promise<void>

  // Node management
  addActionNode: (action: Action, parentId?: string | null, branchLabel?: string) => FlowNode
  updateNode: (nodeId: string, updates: Partial<FlowNode>) => void
  deleteNode: (nodeId: string) => void
  selectNode: (nodeId: string | null) => void
  /** Insert a callFlow node between nodeId's parent and nodeId. Throws if nodeId is root. */
  insertCallFlowBefore: (nodeId: string, callFlowAction: Action) => FlowNode
  /** Append a callFlow node as the sole child of nodeId. Throws if nodeId already has children. */
  appendCallFlowAfter: (nodeId: string, callFlowAction: Action) => FlowNode

  // Replay status
  setReplayingNode: (nodeId: string | null) => void
  setReplayStatus: (nodeId: string, status: 'running' | 'success' | 'error') => void
  clearReplayStatus: () => void

  // Recording flag
  setIsRecording: (v: boolean) => void
  setIsReplaying: (v: boolean) => void
  setReplaySpeed: (ms: number) => void
  isPickingAssertion: boolean
  setIsPickingAssertion: (v: boolean) => void
  pendingLocatorPick: LocatorPickPayload | null
  setPendingLocatorPick: (payload: LocatorPickPayload | null) => void

  // Environment profiles
  /** ID of the currently active profile; null = no active profile (no substitution) */
  activeProfileId: string | null
  setActiveProfile: (id: string | null) => void
  addProfile: (name: string) => Promise<void>
  updateProfile: (id: string, updates: Partial<Pick<FlowProfile, 'name' | 'vars'>>) => Promise<void>
  deleteProfile: (id: string) => Promise<void>
  /** Append a new empty variable row to EVERY profile (keys must stay in sync) */
  addVarToAllProfiles: () => Promise<void>
  /** Rename the variable at the given index across ALL profiles */
  updateVarKeyInAllProfiles: (index: number, newKey: string) => Promise<void>
  /** Delete the variable at the given index from ALL profiles */
  deleteVarFromAllProfiles: (index: number) => Promise<void>

  // Projects and environments
  projects: Pick<Project, 'id' | 'name' | 'updatedAt'>[]
  currentProject: Project | null
  /** Active project environment ID; null = use profile var fallback values */
  activeEnvironmentId: string | null
  setProjects: (projects: FlowStore['projects']) => void
  setCurrentProject: (project: Project | null) => void
  setActiveEnvironment: (envId: string | null) => void
  createProject: (name: string) => Promise<Project>
  addEnvironmentToProject: (name: string) => Promise<void>
  renameEnvironment: (envId: string, name: string) => Promise<void>
  deleteEnvironment: (envId: string) => Promise<void>
  deleteProject: (projectId: string) => Promise<void>
  /** Assign any flow (by ID) to a project. Pass null to detach. */
  assignFlowToProject: (flowId: string, projectId: string | null) => Promise<void>
}

/** Migrate legacy callFlow actions that have subFlowProfileId but no subFlowProfileMapping.
 *  Creates a mapping where every current parent profile maps to the same subFlowProfileId.
 *  Applied in-memory only (no auto-save), consistent with migrateDomainsToProfiles. */
function migrateCallFlowProfiles(flow: Flow): Flow {
  const profiles = flow.profiles ?? []
  const needsMigration = flow.nodes.some(
    (n) => n.action.type === 'callFlow' && n.action.subFlowProfileId && !n.action.subFlowProfileMapping,
  )
  if (!needsMigration || profiles.length === 0) return flow

  const updatedNodes = flow.nodes.map((n) => {
    if (n.action.type === 'callFlow' && n.action.subFlowProfileId && !n.action.subFlowProfileMapping) {
      return {
        ...n,
        action: {
          ...n.action,
          subFlowProfileMapping: Object.fromEntries(profiles.map((p) => [p.id, n.action.subFlowProfileId!])),
        },
      }
    }
    return n
  })
  return { ...flow, nodes: updatedNodes }
}

/** Migrate legacy domains[] field to profiles[] in memory (no auto-save). */
function migrateDomainsToProfiles(flow: Flow): FlowProfile[] {
  if (flow.profiles && flow.profiles.length > 0) return flow.profiles
  if (flow.domains && flow.domains.length > 0) {
    return flow.domains.map((origin, i) => ({
      id: uuidv4(),
      name: i === 0 ? '錄製' : origin,
      vars: [{ key: 'domain', value: origin }],
    }))
  }
  return []
}

export const useFlowStore = create<FlowStore>((set, get) => ({
  flows: [],
  currentFlow: null,
  selectedNodeId: null,
  replayingNodeId: null,
  replayStatus: {},
  isRecording: false,
  isReplaying: false,
  recordingHeadId: null,
  replaySpeed: 500,
  isPickingAssertion: false,
  pendingLocatorPick: null,
  activeProfileId: null,
  projects: [],
  currentProject: null,
  activeEnvironmentId: null,

  setFlows: (flows) => set({ flows }),

  createFlow: (name, baseURL, description) => {
    const origin = (() => { try { return new URL(baseURL).origin } catch { return baseURL } })()
    const firstProfile: FlowProfile = {
      id: uuidv4(),
      name: '錄製',
      vars: [{ key: 'domain', value: origin }],
    }
    const flow: Flow = {
      id: uuidv4(),
      name,
      description,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      baseURL,
      profiles: [firstProfile],
      nodes: [],
      rootNodeId: '',
    }
    set({ currentFlow: flow, activeProfileId: firstProfile.id })
    return flow
  },

  setCurrentFlow: (flow) => {
    if (!flow) {
      set({
        currentFlow: null, selectedNodeId: null, replayStatus: {}, recordingHeadId: null,
        activeProfileId: null, currentProject: null, activeEnvironmentId: null,
      })
      return
    }
    // Migrate old flows that have domains[] but no profiles[]
    const profiles = migrateDomainsToProfiles(flow)
    const withDomainsMigrated = profiles !== flow.profiles ? { ...flow, profiles } : flow
    // Migrate callFlow nodes with static subFlowProfileId to per-profile mapping
    const migratedFlow = migrateCallFlowProfiles(withDomainsMigrated)
    // Clear project context if the new flow belongs to a different project
    // (project loading happens async in useFlowStore.openFlow after setCurrentFlow)
    const { currentProject } = get()
    const changingProject = flow.projectId !== currentProject?.id
    set({
      currentFlow: migratedFlow,
      selectedNodeId: null,
      replayStatus: {},
      recordingHeadId: null,
      activeProfileId: profiles[0]?.id ?? null,
      ...(changingProject ? { currentProject: null, activeEnvironmentId: null } : {}),
    })
  },

  setRecordingHead: (id) => set({ recordingHeadId: id }),

  renameCurrentFlow: async (name) => {
    const flow = get().currentFlow
    if (!flow) return
    const updatedFlow: Flow = { ...flow, name, updatedAt: new Date().toISOString() }
    set({ currentFlow: updatedFlow })
    await window.electronAPI.saveFlow(updatedFlow).catch(console.error)
  },

  addActionNode: (action, parentId = null, branchLabel) => {
    const flow = get().currentFlow
    if (!flow) throw new Error('No active flow')

    // Deduplicate: reject if this action ID already exists
    if (flow.nodes.some((n) => n.id === action.id)) return {} as FlowNode

    // Determine position
    const parent = parentId ? flow.nodes.find((n) => n.id === parentId) : null
    const siblingCount = parent ? parent.childIds.length : 0
    const position: NodePosition = parent
      ? {
          x: parent.position.x + siblingCount * 220,
          y: parent.position.y + NODE_VERTICAL_GAP,
        }
      : { x: NODE_START_X, y: NODE_START_Y }

    const node: FlowNode = {
      id: action.id,
      action,
      position,
      parentId: parentId ?? null,
      childIds: [],
      branchLabel,
    }

    // Update parent's childIds
    const updatedNodes = flow.nodes.map((n) =>
      n.id === parentId ? { ...n, childIds: [...n.childIds, node.id] } : n,
    )
    updatedNodes.push(node)

    const updatedFlow: Flow = {
      ...flow,
      nodes: updatedNodes,
      rootNodeId: flow.rootNodeId || node.id,
      updatedAt: new Date().toISOString(),
    }

    set({ currentFlow: updatedFlow, recordingHeadId: node.id })
    return node
  },

  updateNode: (nodeId, updates) => {
    const flow = get().currentFlow
    if (!flow) return
    const updatedFlow: Flow = {
      ...flow,
      nodes: flow.nodes.map((n) => (n.id === nodeId ? { ...n, ...updates } : n)),
      updatedAt: new Date().toISOString(),
    }
    set({ currentFlow: updatedFlow })
  },

  deleteNode: (nodeId) => {
    const flow = get().currentFlow
    if (!flow) return

    // Collect all descendant ids
    const toDelete = new Set<string>()
    const collect = (id: string) => {
      toDelete.add(id)
      const node = flow.nodes.find((n) => n.id === id)
      node?.childIds.forEach(collect)
    }
    collect(nodeId)

    const updatedNodes = flow.nodes
      .filter((n) => !toDelete.has(n.id))
      .map((n) => ({
        ...n,
        childIds: n.childIds.filter((cid) => !toDelete.has(cid)),
      }))

    const newRoot = updatedNodes.find((n) => n.parentId === null)
    set({
      currentFlow: {
        ...flow,
        nodes: updatedNodes,
        rootNodeId: newRoot?.id ?? '',
        updatedAt: new Date().toISOString(),
      },
      selectedNodeId: null,
    })
  },

  selectNode: (nodeId) => set({ selectedNodeId: nodeId }),

  insertCallFlowBefore: (nodeId, callFlowAction) => {
    const flow = get().currentFlow
    if (!flow) throw new Error('No active flow')
    const node = flow.nodes.find((n) => n.id === nodeId)
    if (!node) throw new Error(`Node "${nodeId}" not found`)
    if (node.parentId === null) throw new Error('Cannot insert before root node')

    const parent = flow.nodes.find((n) => n.id === node.parentId)!
    const callFlowNode: FlowNode = {
      id: callFlowAction.id,
      action: callFlowAction,
      position: { x: node.position.x, y: node.position.y },
      parentId: node.parentId,
      childIds: [nodeId],
      branchLabel: node.branchLabel,
    }

    const updatedNodes = flow.nodes.map((n) => {
      if (n.id === node.parentId) {
        return {
          ...parent,
          childIds: parent.childIds.map((cid) => (cid === nodeId ? callFlowNode.id : cid)),
        }
      }
      if (n.id === nodeId) {
        return { ...n, parentId: callFlowNode.id, branchLabel: undefined }
      }
      return n
    })
    updatedNodes.push(callFlowNode)

    const updatedFlow: Flow = { ...flow, nodes: updatedNodes, updatedAt: new Date().toISOString() }
    set({ currentFlow: updatedFlow })
    return callFlowNode
  },

  appendCallFlowAfter: (nodeId, callFlowAction) => {
    const flow = get().currentFlow
    if (!flow) throw new Error('No active flow')
    const node = flow.nodes.find((n) => n.id === nodeId)
    if (!node) throw new Error(`Node "${nodeId}" not found`)
    if (node.childIds.length > 0) throw new Error('Cannot append after a node that already has children')

    const callFlowNode: FlowNode = {
      id: callFlowAction.id,
      action: callFlowAction,
      position: { x: node.position.x, y: node.position.y + NODE_VERTICAL_GAP },
      parentId: nodeId,
      childIds: [],
    }

    const updatedNodes = flow.nodes.map((n) =>
      n.id === nodeId ? { ...n, childIds: [...n.childIds, callFlowNode.id] } : n,
    )
    updatedNodes.push(callFlowNode)

    const updatedFlow: Flow = { ...flow, nodes: updatedNodes, updatedAt: new Date().toISOString() }
    set({ currentFlow: updatedFlow })
    return callFlowNode
  },

  setReplayingNode: (nodeId) => set({ replayingNodeId: nodeId }),

  setReplayStatus: (nodeId, status) =>
    set((state) => ({ replayStatus: { ...state.replayStatus, [nodeId]: status } })),

  clearReplayStatus: () => set({ replayStatus: {}, replayingNodeId: null }),

  setIsRecording: (v) => set({ isRecording: v }),
  setIsReplaying: (v) => set({ isReplaying: v }),
  setReplaySpeed: (ms) => set({ replaySpeed: ms }),
  setIsPickingAssertion: (v) => set({ isPickingAssertion: v }),
  setPendingLocatorPick: (payload) => set({ pendingLocatorPick: payload }),

  setActiveProfile: (id) => set({ activeProfileId: id }),

  addProfile: async (name) => {
    const flow = get().currentFlow
    if (!flow) return
    const existingProfiles = flow.profiles ?? []
    const lastProfile = existingProfiles[existingProfiles.length - 1]
    const existingVars = lastProfile?.vars ?? []
    const newProfile: FlowProfile = {
      id: uuidv4(),
      name,
      vars: existingVars.map((v) => ({ key: v.key, value: v.value, description: v.description ?? '' })),
    }
    // Extend all callFlow node mappings to include the new profile.
    // Default to the same sub-flow profile as the last existing profile (best-guess default).
    const updatedNodes = flow.nodes.map((n) => {
      if (n.action.type === 'callFlow' && n.action.subFlowProfileMapping) {
        const lastMappedId = lastProfile ? (n.action.subFlowProfileMapping[lastProfile.id] ?? null) : null
        return {
          ...n,
          action: {
            ...n.action,
            subFlowProfileMapping: { ...n.action.subFlowProfileMapping, [newProfile.id]: lastMappedId },
          },
        }
      }
      return n
    })
    const updatedFlow: Flow = {
      ...flow,
      profiles: [...(flow.profiles ?? []), newProfile],
      nodes: updatedNodes,
      updatedAt: new Date().toISOString(),
    }
    set({ currentFlow: updatedFlow })
    await window.electronAPI.saveFlow(updatedFlow).catch(console.error)
  },

  updateProfile: async (id, updates) => {
    const flow = get().currentFlow
    if (!flow) return
    const updatedFlow: Flow = {
      ...flow,
      profiles: (flow.profiles ?? []).map((p) =>
        p.id === id ? { ...p, ...updates } : p,
      ),
      updatedAt: new Date().toISOString(),
    }
    set({ currentFlow: updatedFlow })
    await window.electronAPI.saveFlow(updatedFlow).catch(console.error)
  },

  deleteProfile: async (id) => {
    const flow = get().currentFlow
    if (!flow) return
    const updatedProfiles = (flow.profiles ?? []).filter((p) => p.id !== id)
    // Remove the deleted profile ID from all callFlow node mappings
    const updatedNodes = flow.nodes.map((n) => {
      if (n.action.type === 'callFlow' && n.action.subFlowProfileMapping && id in n.action.subFlowProfileMapping) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [id]: _removed, ...rest } = n.action.subFlowProfileMapping
        return { ...n, action: { ...n.action, subFlowProfileMapping: rest } }
      }
      return n
    })
    const { activeProfileId } = get()
    const updatedFlow: Flow = {
      ...flow,
      profiles: updatedProfiles,
      nodes: updatedNodes,
      updatedAt: new Date().toISOString(),
    }
    set({
      currentFlow: updatedFlow,
      activeProfileId: activeProfileId === id ? (updatedProfiles[0]?.id ?? null) : activeProfileId,
    })
    await window.electronAPI.saveFlow(updatedFlow).catch(console.error)
  },

  addVarToAllProfiles: async () => {
    const flow = get().currentFlow
    if (!flow) return
    const updatedFlow: Flow = {
      ...flow,
      profiles: (flow.profiles ?? []).map((p) => ({
        ...p,
        vars: [...p.vars, { key: '', value: '', description: '' }],
      })),
      updatedAt: new Date().toISOString(),
    }
    set({ currentFlow: updatedFlow })
    await window.electronAPI.saveFlow(updatedFlow).catch(console.error)
  },

  updateVarKeyInAllProfiles: async (index, newKey) => {
    const flow = get().currentFlow
    if (!flow) return
    const updatedFlow: Flow = {
      ...flow,
      profiles: (flow.profiles ?? []).map((p) => ({
        ...p,
        vars: p.vars.map((v, i) => (i === index ? { ...v, key: newKey } : v)),
      })),
      updatedAt: new Date().toISOString(),
    }
    set({ currentFlow: updatedFlow })
    await window.electronAPI.saveFlow(updatedFlow).catch(console.error)
  },

  deleteVarFromAllProfiles: async (index) => {
    const flow = get().currentFlow
    if (!flow) return
    const updatedFlow: Flow = {
      ...flow,
      profiles: (flow.profiles ?? []).map((p) => ({
        ...p,
        vars: p.vars.filter((_, i) => i !== index),
      })),
      updatedAt: new Date().toISOString(),
    }
    set({ currentFlow: updatedFlow })
    await window.electronAPI.saveFlow(updatedFlow).catch(console.error)
  },

  setProjects: (projects) => set({ projects }),
  setCurrentProject: (project) => set({ currentProject: project }),
  setActiveEnvironment: (envId) => set({ activeEnvironmentId: envId }),

  createProject: async (name) => {
    const project: Project = {
      id: uuidv4(),
      name,
      environments: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await window.electronAPI.saveProject(project)
    const list = await window.electronAPI.listProjects()
    set({ projects: list })
    return project
  },

  addEnvironmentToProject: async (name) => {
    const project = get().currentProject
    if (!project) return
    const newEnv: ProjectEnvironment = { id: uuidv4(), name }
    const updatedProject: Project = { ...project, environments: [...project.environments, newEnv] }
    await window.electronAPI.saveProject(updatedProject)
    set({ currentProject: updatedProject })
  },

  renameEnvironment: async (envId, name) => {
    const project = get().currentProject
    if (!project) return
    const updatedProject: Project = {
      ...project,
      environments: project.environments.map((e) => (e.id === envId ? { ...e, name } : e)),
    }
    await window.electronAPI.saveProject(updatedProject)
    set({ currentProject: updatedProject })
  },

  deleteEnvironment: async (envId) => {
    const project = get().currentProject
    if (!project) return
    const updatedProject: Project = {
      ...project,
      environments: project.environments.filter((e) => e.id !== envId),
    }
    await window.electronAPI.saveProject(updatedProject)
    const { activeEnvironmentId } = get()
    set({
      currentProject: updatedProject,
      activeEnvironmentId:
        activeEnvironmentId === envId
          ? (updatedProject.environments[0]?.id ?? null)
          : activeEnvironmentId,
    })
  },

  deleteProject: async (projectId) => {
    await window.electronAPI.deleteProject(projectId)
    const list = await window.electronAPI.listProjects()
    const { currentProject } = get()
    set({
      projects: list,
      ...(currentProject?.id === projectId ? { currentProject: null, activeEnvironmentId: null } : {}),
    })
  },

  assignFlowToProject: async (flowId, projectId) => {
    const flowData = await window.electronAPI.getFlow(flowId)
    if (!flowData) return
    const updatedFlow: Flow = { ...flowData, projectId: projectId ?? undefined }
    await window.electronAPI.saveFlow(updatedFlow)
    const { currentFlow } = get()
    if (currentFlow?.id === flowId) {
      set({ currentFlow: updatedFlow })
    }
  },
}))
