import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { Flow, FlowListItem, FlowNode, Action, NodePosition, FlowProfile, Project, ProjectEnvironment, LocatorPickPayload } from '../../shared/types'
import { DEFAULT_PROJECT_ID, DEFAULT_ENV_NAME, DEFAULT_DOMAIN, DOMAIN_ENV_KEY, isCallFlowAction } from '../../shared/types'
import { computeGroupAwareLayout } from '../utils/groups'

const NODE_VERTICAL_GAP = 80
const NODE_START_Y = 50
const NODE_START_X = 300

/** Max number of undo snapshots kept per flow editing session. */
const HISTORY_LIMIT = 50

/**
 * Undo/redo covers the CANVAS NODE GRAPH ONLY — adding/deleting nodes, connecting and
 * disconnecting, grouping, relayout, and PropertyPanel edits. Each entry is the previous
 * `currentFlow`.
 *
 * Configuration is deliberately NOT undoable: session variables (`captureAs`), environment
 * profiles, project environments and project env vars, flow rename, and project assignment.
 * Those live off-canvas, so a Ctrl+Z would silently revert data the user cannot see —
 * including a whole variable table at once, since the commit actions are atomic. They are
 * protected by the draft 還原 button and delete confirmations instead.
 *
 * **Rule: any store action that writes flow CONFIG must go through `setSilently`.** The
 * `graphChanged` check in the subscription is only a safety net for config-only writes; the
 * profile actions also rewrite `nodes` (callFlow `subFlowProfileMapping`) and so cannot be
 * distinguished structurally.
 */
/** Guards the history subscription so undo/redo restores don't get re-recorded. */
let isTimeTraveling = false
/** Depth counter (not a boolean) so nested suppression can't be lifted early by an inner scope. */
let suppressDepth = 0
/** When >0, mutations are not pushed onto the undo stack (node drags, layout materialization,
 *  group collapse, and every config write — all of which would otherwise flood or pollute it). */
const historySuppressed = () => suppressDepth > 0

/** True when the node graph itself actually changed between two flow snapshots. */
const graphChanged = (a: Flow, b: Flow) =>
  a.nodes !== b.nodes || a.rootNodeId !== b.rootNodeId || a.groups !== b.groups

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

  // Undo/redo history — canvas node-graph snapshots only; cleared on flow switch
  past: Flow[]
  future: Flow[]
  /** Restore the previous node-graph snapshot. No-op if nothing to undo. */
  undo: () => void
  /** Re-apply the most recently undone snapshot. No-op if nothing to redo. */
  redo: () => void
  /** Run flow mutations without recording an undo snapshot (e.g. node drag, config writes).
   *  **Synchronous only** — an async fn would drop suppression at the first await. */
  runWithoutHistory: (fn: () => void) => void
  /** Run several node-graph mutations as ONE undo step, so a single user gesture costs a
   *  single Ctrl+Z (multi-select disconnect, multi-edge delete, insert-callFlow+relayout).
   *  **Synchronous only** — keep any `await saveFlow(...)` outside the callback. */
  runAsOneHistoryStep: (fn: () => void) => void

  // Flow management
  setFlows: (flows: FlowStore['flows']) => void
  createFlow: (name: string, baseURL: string, description?: string) => Flow
  setCurrentFlow: (flow: Flow | null) => void
  setRecordingHead: (id: string | null) => void
  renameCurrentFlow: (name: string) => Promise<void>

  // Node management
  addActionNode: (action: Action, parentId?: string | null, branchLabel?: string) => FlowNode
  /** Add a standalone floating node at an explicit canvas position (no parent, no children).
   *  Used by the "加入節點" dialog; the user wires it up manually afterwards. */
  addNodeAt: (action: Action, position: NodePosition) => FlowNode
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
  /** Duplicate an existing profile, deep-copying its vars (incl. envValues) */
  duplicateProfile: (id: string) => Promise<void>
  /**
   * Commit the whole profile-variable table in one shot — one store write, one disk write,
   * one undo entry (replaces the old per-keystroke add/rename/delete actions).
   *
   * Variable KEYS are shared across every profile (index-aligned); VALUE and DESCRIPTION
   * belong to `profileId` only, and VALUE targets `envValues[envId]` when an environment
   * is active. `origIndex === null` marks a row added in this draft (appended to every
   * profile); original indices absent from `rows` are deletions (removed from every profile).
   */
  commitProfileVars: (
    profileId: string,
    rows: { origIndex: number | null; key: string; value: string; description: string }[],
    envId: string | null,
  ) => Promise<void>

  // Projects and environments
  projects: Pick<Project, 'id' | 'name' | 'updatedAt'>[]
  currentProject: Project | null
  /** Active project environment ID; null = use profile var fallback values */
  activeEnvironmentId: string | null
  setProjects: (projects: FlowStore['projects']) => void
  setCurrentProject: (project: Project | null) => void
  setActiveEnvironment: (envId: string | null) => void
  createProject: (name: string, envName?: string, domain?: string) => Promise<Project>
  addEnvironmentToProject: (name: string) => Promise<void>
  renameEnvironment: (envId: string, name: string) => Promise<void>
  duplicateEnvironment: (envId: string) => Promise<void>
  deleteEnvironment: (envId: string) => Promise<void>
  deleteProject: (projectId: string) => Promise<void>
  renameProject: (projectId: string, name: string) => Promise<void>
  /** Duplicate a project together with all flows that belong to it. */
  duplicateProject: (projectId: string) => Promise<void>
  /** Assign any flow (by ID) to a project. Pass null to detach. */
  assignFlowToProject: (flowId: string, projectId: string | null) => Promise<void>
  /**
   * Commit the whole project env-var table in one shot — one store write, one disk write,
   * one undo entry (replaces the old per-keystroke add/rename/delete/set actions).
   *
   * `origKey === null` marks a row added in this draft; original keys absent from `rows` are
   * deletions. Values for OTHER environments are carried over by `origKey`, so a rename keeps
   * them. The reserved `domain` key is never renamed, whatever the draft says.
   */
  commitProjectEnvVars: (
    rows: { origKey: string | null; key: string; value: string }[],
    envId: string,
  ) => Promise<void>
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

/** Apply a state change without recording an undo entry. Used by actions that are pure
 *  view state (group collapse), automatic bookkeeping (one-time layout materialization),
 *  or any write to flow CONFIG (profiles, name, project assignment). */
function setSilently(partial: Partial<FlowStore>) {
  suppressDepth++
  try {
    useFlowStore.setState(partial)
  } finally {
    suppressDepth--
  }
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
    const changingProject = (flow.projectId ?? DEFAULT_PROJECT_ID) !== currentProject?.id
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
    if (past.length === 0) return
    const previous = past[past.length - 1]
    // The snapshot belongs to a different flow — refuse rather than restoring it over this one.
    if (!currentFlow || currentFlow.id !== previous.id) return
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
    if (future.length === 0) return
    const next = future[0]
    if (!currentFlow || currentFlow.id !== next.id) return
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
    suppressDepth++
    try {
      fn()
    } finally {
      suppressDepth--
    }
  },

  runAsOneHistoryStep: (fn) => {
    const before = get().currentFlow
    suppressDepth++
    try {
      fn()
    } finally {
      suppressDepth--
    }
    const after = get().currentFlow
    if (isTimeTraveling) return
    const { isRecording, isReplaying } = get()
    if (isRecording || isReplaying) return
    if (!before || !after || before === after) return
    if (before.id !== after.id) return
    if (!graphChanged(before, after)) return
    set((s) => ({ past: [...s.past, before].slice(-HISTORY_LIMIT), future: [] }))
  },

  // Flow metadata, not the node graph — not undoable (see header comment).
  renameCurrentFlow: async (name) => {
    const flow = get().currentFlow
    if (!flow) return
    const updatedFlow: Flow = { ...flow, name, updatedAt: new Date().toISOString() }
    setSilently({ currentFlow: updatedFlow })
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

  addNodeAt: (action, position) => {
    const flow = get().currentFlow
    if (!flow) throw new Error('No active flow')
    if (flow.nodes.some((n) => n.id === action.id)) return {} as FlowNode

    const node: FlowNode = {
      id: action.id,
      action,
      position,
      parentId: null,
      childIds: [],
    }

    const updatedFlow: Flow = {
      ...flow,
      nodes: [...flow.nodes, node],
      // Only becomes root if the flow is empty; otherwise it's a floating node
      // the user connects manually.
      rootNodeId: flow.rootNodeId || node.id,
      updatedAt: new Date().toISOString(),
    }

    set({ currentFlow: updatedFlow })
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

  // One-time automatic bookkeeping on first load of a never-laid-out flow — not a user edit,
  // so it must not consume an undo slot. Suppression lives here rather than at the call site
  // so it can't be forgotten.
  materializeLayout: (positions) => {
    const flow = get().currentFlow
    if (!flow || flow.positionsFinalized) return
    setSilently({
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

  // Collapse/expand is pure view state. It rewrites every node position (group-aware relayout),
  // which would otherwise land on the undo stack and let a few toggles evict real edits.
  // Still persisted by the caller — collapsed state belongs on disk.
  toggleGroupCollapsed: (groupId) => {
    const flow = get().currentFlow
    if (!flow) return
    const groups = (flow.groups ?? []).map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g))
    const positions = computeGroupAwareLayout(flow.nodes, groups)
    const nodes = flow.nodes.map((n) => {
      const pos = positions.get(n.id)
      return pos ? { ...n, position: pos } : n
    })
    setSilently({
      currentFlow: { ...flow, nodes, groups, positionsFinalized: true, updatedAt: new Date().toISOString() },
    })
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

  // ── Environment profiles ──────────────────────────────────
  // All profile mutations use setSilently: profiles are off-canvas config and must never be
  // reachable by Ctrl+Z. Note they also rewrite flow.nodes (callFlow subFlowProfileMapping),
  // so the subscription's graphChanged net would NOT catch them — the suppression is required.

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
    setSilently({ currentFlow: updatedFlow })
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
    setSilently({ currentFlow: updatedFlow })
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
    setSilently({
      currentFlow: updatedFlow,
      activeProfileId: activeProfileId === id ? (updatedProfiles[0]?.id ?? null) : activeProfileId,
    })
    await window.electronAPI.saveFlow(updatedFlow).catch(console.error)
  },

  duplicateProfile: async (id) => {
    const flow = get().currentFlow
    if (!flow) return
    const source = (flow.profiles ?? []).find((p) => p.id === id)
    if (!source) return
    const newProfile: FlowProfile = {
      id: uuidv4(),
      name: `${source.name}-副本`,
      // Unlike addProfile, a copy must carry the per-environment overrides too.
      vars: source.vars.map((v) => ({
        key: v.key,
        value: v.value,
        description: v.description ?? '',
        ...(v.envValues ? { envValues: { ...v.envValues } } : {}),
      })),
    }
    // Extend all callFlow node mappings, inheriting the source profile's mapping.
    const updatedNodes = flow.nodes.map((n) => {
      if (n.action.type === 'callFlow' && n.action.subFlowProfileMapping) {
        return {
          ...n,
          action: {
            ...n.action,
            subFlowProfileMapping: {
              ...n.action.subFlowProfileMapping,
              [newProfile.id]: n.action.subFlowProfileMapping[id] ?? null,
            },
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
    setSilently({ currentFlow: updatedFlow })
    await window.electronAPI.saveFlow(updatedFlow).catch(console.error)
  },

  commitProfileVars: async (profileId, rows, envId) => {
    const flow = get().currentFlow
    if (!flow) return
    const profiles = flow.profiles ?? []

    const updatedProfiles = profiles.map((p) => {
      const isEdited = p.id === profileId
      const vars = rows.map((row) => {
        // Existing row: keep this profile's own value/description/envValues, take only the key
        // from the draft (keys are shared across every profile).
        const base =
          row.origIndex !== null
            ? p.vars[row.origIndex]
            : undefined
        const kept = base ?? { key: row.key, value: '', description: '' }
        if (!isEdited) return { ...kept, key: row.key }

        // The edited profile additionally takes value/description from the draft. With an
        // active environment the value lands on envValues[envId] rather than the base value.
        if (envId) {
          return {
            ...kept,
            key: row.key,
            description: row.description,
            envValues: { ...kept.envValues, [envId]: row.value },
          }
        }
        return { ...kept, key: row.key, value: row.value, description: row.description }
      })
      return { ...p, vars }
    })

    const updatedFlow: Flow = {
      ...flow,
      profiles: updatedProfiles,
      updatedAt: new Date().toISOString(),
    }
    // Atomic whole-table write — exactly the kind of invisible bulk change Ctrl+Z must not touch.
    setSilently({ currentFlow: updatedFlow })
    await window.electronAPI.saveFlow(updatedFlow).catch(console.error)
  },

  setProjects: (projects) => set({ projects }),
  setCurrentProject: (project) => set({ currentProject: project }),
  setActiveEnvironment: (envId) => set({ activeEnvironmentId: envId }),

  createProject: async (name, envName = DEFAULT_ENV_NAME, domain = DEFAULT_DOMAIN) => {
    // Every project starts with one environment holding the fixed `domain` env var.
    const env: ProjectEnvironment = { id: uuidv4(), name: envName }
    const project: Project = {
      id: uuidv4(),
      name,
      environments: [env],
      envVars: [{ key: DOMAIN_ENV_KEY, values: { [env.id]: domain } }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await window.electronAPI.saveProject(project)
    const list = await window.electronAPI.listProjects()
    set({ projects: list })
    return project
  },

  // In-place project mutators set() BEFORE saving (mirroring the flow actions), because the
  // history subscription can only observe a set() transition and undo has to be able to
  // re-persist whatever it restored.
  addEnvironmentToProject: async (name) => {
    const project = get().currentProject
    if (!project) return
    const newEnv: ProjectEnvironment = { id: uuidv4(), name }
    const updatedProject: Project = { ...project, environments: [...project.environments, newEnv] }
    set({ currentProject: updatedProject })
    await window.electronAPI.saveProject(updatedProject).catch(console.error)
  },

  renameEnvironment: async (envId, name) => {
    const project = get().currentProject
    if (!project) return
    const updatedProject: Project = {
      ...project,
      environments: project.environments.map((e) => (e.id === envId ? { ...e, name } : e)),
    }
    set({ currentProject: updatedProject })
    await window.electronAPI.saveProject(updatedProject).catch(console.error)
  },

  duplicateEnvironment: async (envId) => {
    const project = get().currentProject
    if (!project) return
    const source = project.environments.find((e) => e.id === envId)
    if (!source) return
    const newEnv: ProjectEnvironment = { id: uuidv4(), name: `${source.name}-副本` }
    const updatedProject: Project = {
      ...project,
      environments: [...project.environments, newEnv],
      // Copy the source environment's value for every env var into the new environment.
      envVars: (project.envVars ?? []).map((v) => ({
        ...v,
        values: { ...v.values, [newEnv.id]: v.values[envId] ?? '' },
      })),
    }
    set({ currentProject: updatedProject, activeEnvironmentId: newEnv.id })
    await window.electronAPI.saveProject(updatedProject).catch(console.error)
  },

  deleteEnvironment: async (envId) => {
    const project = get().currentProject
    if (!project) return
    const updatedProject: Project = {
      ...project,
      environments: project.environments.filter((e) => e.id !== envId),
      // Drop the deleted environment's value from every project env var
      envVars: (project.envVars ?? []).map((v) => {
        const { [envId]: _removed, ...rest } = v.values
        return { ...v, values: rest }
      }),
    }
    const { activeEnvironmentId } = get()
    set({
      currentProject: updatedProject,
      activeEnvironmentId:
        activeEnvironmentId === envId
          ? (updatedProject.environments[0]?.id ?? null)
          : activeEnvironmentId,
    })
    await window.electronAPI.saveProject(updatedProject).catch(console.error)
  },

  deleteProject: async (projectId) => {
    // Deleting a project deletes every flow that belongs to it (no orphaned flows left behind).
    const allFlows = await window.electronAPI.listFlows()
    const flowsToDelete = allFlows.filter((f) => (f.projectId ?? DEFAULT_PROJECT_ID) === projectId)
    for (const f of flowsToDelete) {
      await window.electronAPI.deleteFlow(f.id)
    }
    await window.electronAPI.deleteProject(projectId)
    const list = await window.electronAPI.listProjects()
    const { currentProject, currentFlow } = get()
    const currentFlowDeleted =
      !!currentFlow && (currentFlow.projectId ?? DEFAULT_PROJECT_ID) === projectId
    // setCurrentFlow(null) already clears currentProject/activeEnvironmentId along with
    // selection/replay/history state, so only handle the "project open but no flow" case separately.
    if (currentFlowDeleted) {
      get().setCurrentFlow(null)
    }
    set({
      projects: list,
      ...(!currentFlowDeleted && currentProject?.id === projectId
        ? { currentProject: null, activeEnvironmentId: null }
        : {}),
    })
  },

  renameProject: async (projectId, name) => {
    const full = await window.electronAPI.loadProject(projectId)
    if (!full) return
    const updated: Project = { ...full, name, updatedAt: new Date().toISOString() }
    // Set before saving when this is the open project, so the rename lands on the undo stack.
    // Renaming a project that is NOT open has no in-memory snapshot and stays un-undoable.
    if (get().currentProject?.id === projectId) set({ currentProject: updated })
    await window.electronAPI.saveProject(updated).catch(console.error)
    const list = await window.electronAPI.listProjects()
    set({ projects: list })
  },

  duplicateProject: async (projectId) => {
    const full = await window.electronAPI.loadProject(projectId)
    if (!full) return
    const now = new Date().toISOString()
    // New project id (else saveProject overwrites the original). Environment ids are
    // kept verbatim so envVars.values maps and flow profile envValues stay aligned.
    const newProject: Project = {
      ...full,
      id: uuidv4(),
      name: `${full.name}-副本`,
      environments: full.environments.map((e) => ({ ...e })),
      envVars: (full.envVars ?? []).map((v) => ({ ...v, values: { ...v.values } })),
      createdAt: now,
      updatedAt: now,
    }
    await window.electronAPI.saveProject(newProject)

    // Copy every flow belonging to the source project. Node/profile ids are kept verbatim
    // (so subFlowExitNodeId / subFlowProfileMapping stay valid); only flow ids change.
    const all = await window.electronAPI.listFlows()
    const sourceFlows = all.filter((f) => f.projectId === projectId)
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
      await window.electronAPI.saveFlow(copy)
    }

    set({ projects: await window.electronAPI.listProjects() })
  },

  // Project membership is flow metadata, not the node graph — not undoable.
  assignFlowToProject: async (flowId, projectId) => {
    const flowData = await window.electronAPI.getFlow(flowId)
    if (!flowData) return
    const updatedFlow: Flow = { ...flowData, projectId: projectId ?? undefined }
    await window.electronAPI.saveFlow(updatedFlow)
    const { currentFlow } = get()
    if (currentFlow?.id === flowId) {
      setSilently({ currentFlow: updatedFlow })
    }
  },

  commitProjectEnvVars: async (rows, envId) => {
    const project = get().currentProject
    if (!project) return
    const existing = project.envVars ?? []
    const byKey = new Map(existing.map((v) => [v.key, v]))

    const envVars = rows.map((row) => {
      // Existing row: carry every other environment's value across, keyed by the ORIGINAL key
      // (the draft may have renamed it). New row: start from an empty value map.
      const base = row.origKey !== null ? byKey.get(row.origKey) : undefined
      // `domain` is reserved — its key can never change, whatever the draft says.
      const key = base?.key === DOMAIN_ENV_KEY ? DOMAIN_ENV_KEY : row.key
      return {
        ...(base ?? {}),
        key,
        values: { ...(base?.values ?? {}), [envId]: row.value },
      }
    })

    const updatedProject: Project = { ...project, envVars }
    set({ currentProject: updatedProject })
    await window.electronAPI.saveProject(updatedProject).catch(console.error)
  },
}))

// Record undo history whenever an edit replaces currentFlow with a new object. One
// subscription covers every mutator, since all edits update currentFlow immutably.
// currentProject is deliberately NOT watched — project environments and env vars are
// off-canvas config and must never be reachable by Ctrl+Z (see the header comment).
useFlowStore.subscribe((state, prev) => {
  if (isTimeTraveling || historySuppressed()) return
  if (state.isRecording || state.isReplaying) return // skip live capture

  const cf = state.currentFlow
  const pf = prev.currentFlow
  if (!cf || !pf || cf === pf) return
  if (cf.id !== pf.id) return // switched flows, not an edit
  // Safety net: a config-only write (profiles / name / projectId / baseURL) can never enter
  // history even if it forgot to use setSilently. Does NOT catch writes that touch both
  // config and nodes — those still need explicit suppression.
  if (!graphChanged(cf, pf)) return

  useFlowStore.setState((s) => ({
    past: [...s.past, pf].slice(-HISTORY_LIMIT),
    future: [],
  }))
})
