import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { Flow, FlowListItem, FlowNode, Action, NodePosition, FlowProfile, Project, ProjectEnvironment, LocatorPickPayload } from '../../shared/types'
import { computeGroupAwareLayout } from '../utils/groups'

const NODE_VERTICAL_GAP = 80
const NODE_START_Y = 50
const NODE_START_X = 300

/** Max number of undo snapshots kept per flow editing session. */
const HISTORY_LIMIT = 50
/** Guards the history subscription so undo/redo restores don't get re-recorded. */
let isTimeTraveling = false
/** When true, currentFlow mutations are not pushed onto the undo stack
 *  (e.g. node-drag position updates, which would otherwise flood history). */
let suppressHistory = false

interface FlowStore {
  // State
  flows: FlowListItem[]
  currentFlow: Flow | null
  selectedNodeId: string | null
  replayingNodeId: string | null
  replayStatus: Record<string, 'running' | 'success' | 'error'>
  isRecording: boolean
  isReplaying: boolean
  /** The node ID that new recorded actions should be appended to */
  recordingHeadId: string | null
  replaySpeed: number

  // Undo/redo history (snapshots of currentFlow; cleared on flow switch)
  past: Flow[]
  future: Flow[]
  /** Restore the previous flow snapshot. No-op if nothing to undo. */
  undo: () => void
  /** Re-apply the most recently undone flow snapshot. No-op if nothing to redo. */
  redo: () => void
  /** Run flow mutations without recording an undo snapshot (e.g. node drag). */
  runWithoutHistory: (fn: () => void) => void

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
  /** Delete the given nodes WITHOUT deleting their subtrees. Each deleted node's
   *  surviving children become floating roots (parentId = null, branchLabel cleared),
   *  consistent with disconnectNodes. Supports multi-node deletion. */
  deleteNodesOnly: (nodeIds: string[]) => void
  selectNode: (nodeId: string | null) => void
  /** Insert a callFlow node between nodeId's parent and nodeId. Throws if nodeId is root. */
  insertCallFlowBefore: (nodeId: string, callFlowAction: Action) => FlowNode
  /** Append a callFlow node as the sole child of nodeId. Throws if nodeId already has children. */
  appendCallFlowAfter: (nodeId: string, callFlowAction: Action) => FlowNode
  /** Flip positionsFinalized on the current flow */
  setPositionsFinalized: (v: boolean) => void
  /** Write computed tree-layout positions into every node and mark positions finalized.
   *  One-shot; no-op if already finalized. Makes fn.position the single source of truth. */
  materializeLayout: (positions: Map<string, NodePosition>) => void
  /** Re-layout all nodes: each root tree laid out left-to-right, subtrees centered.
   *  Unconditional (unlike materializeLayout). Caller persists to disk. */
  relayoutAll: () => void
  /** Connect source → target as parent → child. No-op if target already has a parent. */
  connectNodes: (sourceId: string, targetId: string, branchLabel?: string) => void
  /** Remove parent-child relationship. Target's parentId becomes null (floating node). */
  disconnectNodes: (parentId: string, childId: string) => void
  /** Detach nodeId from its parent AND all its children; node and each child become floating roots. */
  disconnectNode: (nodeId: string) => void

  // In-place visual groups (canvas display only — no separate Flow, never enters flow list)
  /** Tag the given nodes as a new collapsed group and re-layout. Returns the new group id. */
  createGroup: (memberIds: string[], name: string) => string | null
  /** Flip a group's collapsed flag and re-layout the canvas group-aware. */
  toggleGroupCollapsed: (groupId: string) => void
  /** Remove a group: clear groupId from its members, drop the FlowGroup, re-layout. */
  ungroupGroup: (groupId: string) => void

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
  renameProject: (projectId: string, name: string) => Promise<void>
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
  past: [],
  future: [],
  isPickingAssertion: false,
  pendingLocatorPick: null,
  activeProfileId: null,
  projects: [],
  currentProject: null,
  activeEnvironmentId: null,

  setFlows: (flows) => set({ flows }),

  createFlow: (name, baseURL, description) => {
    const flow: Flow = {
      id: uuidv4(),
      name,
      description,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      baseURL,
      profiles: [],
      nodes: [],
      rootNodeId: '',
    }
    set({ currentFlow: flow, activeProfileId: null })
    return flow
  },

  setCurrentFlow: (flow) => {
    if (!flow) {
      set({
        currentFlow: null, selectedNodeId: null, replayStatus: {}, recordingHeadId: null,
        activeProfileId: null, currentProject: null, activeEnvironmentId: null,
        past: [], future: [],
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
      past: [],
      future: [],
      ...(changingProject ? { currentProject: null, activeEnvironmentId: null } : {}),
    })
  },

  setRecordingHead: (id) => set({ recordingHeadId: id }),

  undo: () => {
    const { past, future, currentFlow } = get()
    if (past.length === 0 || !currentFlow) return
    const previous = past[past.length - 1]
    isTimeTraveling = true
    set({
      past: past.slice(0, -1),
      future: [currentFlow, ...future],
      currentFlow: previous,
      selectedNodeId: null,
    })
    isTimeTraveling = false
    window.electronAPI.saveFlow(previous).catch(console.error)
  },

  redo: () => {
    const { past, future, currentFlow } = get()
    if (future.length === 0 || !currentFlow) return
    const next = future[0]
    isTimeTraveling = true
    set({
      past: [...past, currentFlow].slice(-HISTORY_LIMIT),
      future: future.slice(1),
      currentFlow: next,
      selectedNodeId: null,
    })
    isTimeTraveling = false
    window.electronAPI.saveFlow(next).catch(console.error)
  },

  runWithoutHistory: (fn) => {
    suppressHistory = true
    try {
      fn()
    } finally {
      suppressHistory = false
    }
  },

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

  deleteNodesOnly: (nodeIds) => {
    const flow = get().currentFlow
    if (!flow) return

    const toDelete = new Set(nodeIds)
    const updatedNodes = flow.nodes
      .filter((n) => !toDelete.has(n.id))
      .map((n) => {
        // A surviving child of a deleted node becomes a floating root.
        const orphaned = n.parentId !== null && toDelete.has(n.parentId)
        return {
          ...n,
          parentId: orphaned ? null : n.parentId,
          branchLabel: orphaned ? undefined : n.branchLabel,
          childIds: n.childIds.filter((cid) => !toDelete.has(cid)),
        }
      })

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

    // node.parentId is null when node is the root; then the callFlow node becomes the new root.
    const parent = node.parentId ? flow.nodes.find((n) => n.id === node.parentId) : null
    const callFlowNode: FlowNode = {
      id: callFlowAction.id,
      action: callFlowAction,
      position: { x: node.position.x, y: node.position.y },
      parentId: node.parentId,
      childIds: [nodeId],
      branchLabel: node.branchLabel,
    }

    const updatedNodes = flow.nodes.map((n) => {
      if (parent && n.id === parent.id) {
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

    const updatedFlow: Flow = {
      ...flow,
      nodes: updatedNodes,
      rootNodeId: node.parentId === null ? callFlowNode.id : flow.rootNodeId,
      updatedAt: new Date().toISOString(),
    }
    set({ currentFlow: updatedFlow })
    return callFlowNode
  },

  appendCallFlowAfter: (nodeId, callFlowAction) => {
    const flow = get().currentFlow
    if (!flow) throw new Error('No active flow')
    const node = flow.nodes.find((n) => n.id === nodeId)
    if (!node) throw new Error(`Node "${nodeId}" not found`)

    const callFlowNode: FlowNode = {
      id: callFlowAction.id,
      action: callFlowAction,
      // Offset by existing children so the new branch doesn't overlap them
      position: {
        x: node.position.x + node.childIds.length * 220,
        y: node.position.y + NODE_VERTICAL_GAP,
      },
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

  setPositionsFinalized: (v) => {
    const flow = get().currentFlow
    if (!flow) return
    set({ currentFlow: { ...flow, positionsFinalized: v, updatedAt: new Date().toISOString() } })
  },

  materializeLayout: (positions) => {
    const flow = get().currentFlow
    if (!flow || flow.positionsFinalized) return
    set({
      currentFlow: {
        ...flow,
        nodes: flow.nodes.map((n) => {
          const pos = positions.get(n.id)
          return pos ? { ...n, position: pos } : n
        }),
        positionsFinalized: true,
        updatedAt: new Date().toISOString(),
      },
    })
  },

  relayoutAll: () => {
    const flow = get().currentFlow
    if (!flow) return
    const positions = computeGroupAwareLayout(flow.nodes, flow.groups ?? [])
    set({
      currentFlow: {
        ...flow,
        nodes: flow.nodes.map((n) => {
          const pos = positions.get(n.id)
          return pos ? { ...n, position: pos } : n
        }),
        positionsFinalized: true,
        updatedAt: new Date().toISOString(),
      },
    })
  },

  connectNodes: (sourceId, targetId, branchLabel) => {
    if (sourceId === targetId) return
    const flow = get().currentFlow
    if (!flow) return
    const target = flow.nodes.find((n) => n.id === targetId)
    if (!target) return
    if (target.parentId !== null) {
      console.warn(`connectNodes: target ${targetId} already has parent ${target.parentId}`)
      return
    }
    const updatedNodes = flow.nodes.map((n) => {
      if (n.id === sourceId) return { ...n, childIds: [...n.childIds, targetId] }
      if (n.id === targetId) return { ...n, parentId: sourceId, branchLabel }
      return n
    })
    set({ currentFlow: { ...flow, nodes: updatedNodes, updatedAt: new Date().toISOString() } })
  },

  disconnectNodes: (parentId, childId) => {
    const flow = get().currentFlow
    if (!flow) return
    const updatedNodes = flow.nodes.map((n) => {
      if (n.id === parentId) return { ...n, childIds: n.childIds.filter((c) => c !== childId) }
      if (n.id === childId) return { ...n, parentId: null, branchLabel: undefined }
      return n
    })
    set({ currentFlow: { ...flow, nodes: updatedNodes, updatedAt: new Date().toISOString() } })
  },

  disconnectNode: (nodeId) => {
    const flow = get().currentFlow
    if (!flow) return
    const node = flow.nodes.find((n) => n.id === nodeId)
    if (!node) return
    const childIds = new Set(node.childIds)
    const updatedNodes = flow.nodes.map((n) => {
      // The node itself: detach from parent and drop all children
      if (n.id === nodeId) return { ...n, parentId: null, branchLabel: undefined, childIds: [] }
      // The parent: remove the node from its childIds
      if (n.id === node.parentId) return { ...n, childIds: n.childIds.filter((c) => c !== nodeId) }
      // Each child: becomes a floating root
      if (childIds.has(n.id)) return { ...n, parentId: null, branchLabel: undefined }
      return n
    })
    set({ currentFlow: { ...flow, nodes: updatedNodes, updatedAt: new Date().toISOString() } })
  },

  createGroup: (memberIds, name) => {
    const flow = get().currentFlow
    if (!flow || memberIds.length === 0) return null
    const groupId = uuidv4()
    const idSet = new Set(memberIds)
    const taggedNodes = flow.nodes.map((n) => (idSet.has(n.id) ? { ...n, groupId } : n))
    const groups = [...(flow.groups ?? []), { id: groupId, name, collapsed: true }]
    const positions = computeGroupAwareLayout(taggedNodes, groups)
    const nodes = taggedNodes.map((n) => {
      const pos = positions.get(n.id)
      return pos ? { ...n, position: pos } : n
    })
    set({
      currentFlow: { ...flow, nodes, groups, positionsFinalized: true, updatedAt: new Date().toISOString() },
      selectedNodeId: null,
    })
    return groupId
  },

  toggleGroupCollapsed: (groupId) => {
    const flow = get().currentFlow
    if (!flow) return
    const groups = (flow.groups ?? []).map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g))
    const positions = computeGroupAwareLayout(flow.nodes, groups)
    const nodes = flow.nodes.map((n) => {
      const pos = positions.get(n.id)
      return pos ? { ...n, position: pos } : n
    })
    set({ currentFlow: { ...flow, nodes, groups, positionsFinalized: true, updatedAt: new Date().toISOString() } })
  },

  ungroupGroup: (groupId) => {
    const flow = get().currentFlow
    if (!flow) return
    const clearedNodes = flow.nodes.map((n) =>
      n.groupId === groupId ? { ...n, groupId: undefined } : n,
    )
    const groups = (flow.groups ?? []).filter((g) => g.id !== groupId)
    const positions = computeGroupAwareLayout(clearedNodes, groups)
    const nodes = clearedNodes.map((n) => {
      const pos = positions.get(n.id)
      return pos ? { ...n, position: pos } : n
    })
    set({ currentFlow: { ...flow, nodes, groups, positionsFinalized: true, updatedAt: new Date().toISOString() } })
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

  renameProject: async (projectId, name) => {
    const full = await window.electronAPI.loadProject(projectId)
    if (!full) return
    const updated: Project = { ...full, name, updatedAt: new Date().toISOString() }
    await window.electronAPI.saveProject(updated)
    const list = await window.electronAPI.listProjects()
    const { currentProject } = get()
    set({
      projects: list,
      ...(currentProject?.id === projectId ? { currentProject: updated } : {}),
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

// Record undo history whenever an edit replaces currentFlow with a new object.
// One subscription covers every mutator, since all edits update currentFlow immutably.
useFlowStore.subscribe((state, prev) => {
  if (isTimeTraveling || suppressHistory) return
  const curr = state.currentFlow
  const before = prev.currentFlow
  if (!curr || !before || curr === before) return // no flow change
  if (curr.id !== before.id) return // switched flows, not an edit
  if (state.isRecording || state.isReplaying) return // skip live capture
  useFlowStore.setState((s) => ({
    past: [...s.past, before].slice(-HISTORY_LIMIT),
    future: [],
  }))
})
