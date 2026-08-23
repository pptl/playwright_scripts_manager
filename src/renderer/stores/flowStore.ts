import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { Flow, FlowListItem, FlowNode, Action, NodePosition, FlowProfile } from '../../shared/types'
import { computeGroupAwareLayout } from '../utils/groups'
import { persistFlow } from './persistence'
import { reportError } from './errorStore'

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
 * profiles, flow rename, and project assignment. Those live off-canvas, so a Ctrl+Z would
 * silently revert data the user cannot see — including a whole variable table at once,
 * since the commit actions are atomic. They are protected by delete confirmations instead.
 *
 * Projects, their environments and their env vars are not listed above because they are
 * excluded STRUCTURALLY, not by policy: they live in `projectStore`, and history here holds
 * `Flow[]` snapshots, so no project write can reach it.
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
  /** Counts wholesale replacements of the open document (`setCurrentFlow` only), never
   *  edits to it. Nothing renders from it — it exists so an effect can depend on "the
   *  document was swapped" even when the flow id is unchanged. */
  flowEpoch: number
  selectedNodeId: string | null
  replayingNodeId: string | null
  replayStatus: Record<string, 'running' | 'success' | 'error' | 'cancelled'>
  /** Why a node failed, keyed by node id. Like `replayStatus` this is NOT part of `Flow`,
   *  so the undo subscription (which snapshots `currentFlow`) never sees it. */
  replayErrors: Record<string, string>
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
  /** Assign any flow (by ID) to a project. Pass null to detach. Despite the name this is
   *  pure flow metadata — it writes `Flow.projectId` and reads no project state, which is
   *  why it belongs here and not in projectStore. */
  assignFlowToProject: (flowId: string, projectId: string | null) => Promise<void>

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
  setReplayStatus: (
    nodeId: string,
    status: 'running' | 'success' | 'error' | 'cancelled',
    error?: string,
  ) => void
  clearReplayStatus: () => void
  /** End-of-run repaint for a cancelled replay. */
  markReplayCancelled: () => void

  // Recording flag
  setIsRecording: (v: boolean) => void
  setIsReplaying: (v: boolean) => void
  setReplaySpeed: (ms: number) => void

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
    rows: {
      origIndex: number | null
      key: string
      value: string
      description: string
      /** Applied to this key in EVERY profile — secrecy is a property of the key. */
      secret?: boolean
    }[],
    envId: string | null,
  ) => Promise<void>
}

/** Migrate legacy callFlow actions that have subFlowProfileId but no subFlowProfileMapping.
 *  Creates a mapping where every current parent profile maps to the same subFlowProfileId.
 *  Applied in-memory only (no auto-save). Kept because subFlowProfileId is still the
 *  runtime fallback in Replayer/ScriptExporter, so legacy nodes must reach the mapping UI. */
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


/** Copy without one key. Only worth a helper because doing it inline inside a `set()`
 *  updater needs a statement body. */
function omitKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map
  const { [key]: _removed, ...rest } = map
  return rest
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
  flowEpoch: 0,
  selectedNodeId: null,
  replayingNodeId: null,
  replayStatus: {},
  replayErrors: {},
  isRecording: false,
  isReplaying: false,
  recordingHeadId: null,
  replaySpeed: 500,
  past: [],
  future: [],
  activeProfileId: null,

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

  // Flow state only. The project context that goes with a flow is loaded (and preserved or
  // reset) by `useFlowManager.openFlow`, which owns the flow↔project sequence.
  setCurrentFlow: (flow) => {
    // Bumped here and nowhere else, so it counts wholesale REPLACEMENTS of the open
    // document rather than edits to it. FlowCanvas watches it to notice the case an id
    // comparison cannot see: the same flow replaced by its disk copy (focus reload, or the
    // reload a passphrase change pushes), where a pending drag save is holding a version
    // that is now stale in a way that matters — see the flush effect there.
    const flowEpoch = get().flowEpoch + 1
    if (!flow) {
      set({
        currentFlow: null, selectedNodeId: null, replayStatus: {}, replayErrors: {},
        recordingHeadId: null, activeProfileId: null, past: [], future: [], flowEpoch,
      })
      return
    }
    const profiles = flow.profiles ?? []
    // Migrate callFlow nodes with static subFlowProfileId to per-profile mapping.
    // Pass `flow` through untouched — spreading a defaulted `profiles: []` onto a flow
    // that legitimately has none would materialize the empty array and get autosaved.
    const migratedFlow = migrateCallFlowProfiles(flow)
    set({
      currentFlow: migratedFlow,
      selectedNodeId: null,
      replayStatus: {},
      replayErrors: {},
      recordingHeadId: null,
      activeProfileId: profiles[0]?.id ?? null,
      past: [],
      future: [],
      flowEpoch,
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
    void persistFlow(previous)
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
    void persistFlow(next)
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
    await persistFlow(updatedFlow)
  },

  // Also flow metadata, not the node graph — not undoable. It lives here rather than in
  // projectStore because it writes `Flow.projectId` and reads no project state at all.
  assignFlowToProject: async (flowId, projectId) => {
    const flowData = await window.electronAPI.getFlow(flowId)
    if (!flowData) return
    const updatedFlow: Flow = { ...flowData, projectId: projectId ?? undefined }
    await persistFlow(updatedFlow)
    const { currentFlow } = get()
    if (currentFlow?.id === flowId) {
      setSilently({ currentFlow: updatedFlow })
    }
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
    void persistFlow(updatedFlow)
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
    void persistFlow(updatedFlow)
    return node
  },

  // Position-only updates come from node dragging, which already saves itself via a 500ms
  // debounce in FlowCanvas (touch:false — repositioning isn't a content change). Auto-saving
  // here too would defeat that debounce and write on every pixel of a drag. Any other field
  // change (PropertyPanel, capture-as-var toggle, session var delete, ...) saves immediately —
  // this used to be the caller's job and was easy to forget.
  updateNode: (nodeId, updates) => {
    const flow = get().currentFlow
    if (!flow) return
    const updatedFlow: Flow = {
      ...flow,
      nodes: flow.nodes.map((n) => (n.id === nodeId ? { ...n, ...updates } : n)),
      updatedAt: new Date().toISOString(),
    }
    set({ currentFlow: updatedFlow })
    const positionOnly = Object.keys(updates).length > 0 && Object.keys(updates).every((k) => k === 'position')
    if (!positionOnly) void persistFlow(updatedFlow)
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
    const updatedFlow: Flow = {
      ...flow,
      nodes: updatedNodes,
      rootNodeId: newRoot?.id ?? '',
      updatedAt: new Date().toISOString(),
    }
    set({ currentFlow: updatedFlow, selectedNodeId: null })
    void persistFlow(updatedFlow)
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
    const updatedFlow: Flow = {
      ...flow,
      nodes: updatedNodes,
      rootNodeId: newRoot?.id ?? '',
      updatedAt: new Date().toISOString(),
    }
    set({ currentFlow: updatedFlow, selectedNodeId: null })
    void persistFlow(updatedFlow)
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
    void persistFlow(updatedFlow)
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
    void persistFlow(updatedFlow)
    return callFlowNode
  },

  // One-time automatic bookkeeping on first load of a never-laid-out flow — not a user edit,
  // so it must not consume an undo slot. Suppression lives here rather than at the call site
  // so it can't be forgotten.
  materializeLayout: (positions) => {
    const flow = get().currentFlow
    if (!flow || flow.positionsFinalized) return
    const updatedFlow: Flow = {
      ...flow,
      nodes: flow.nodes.map((n) => {
        const pos = positions.get(n.id)
        return pos ? { ...n, position: pos } : n
      }),
      positionsFinalized: true,
      updatedAt: new Date().toISOString(),
    }
    setSilently({ currentFlow: updatedFlow })
    void persistFlow(updatedFlow)
  },

  relayoutAll: () => {
    const flow = get().currentFlow
    if (!flow) return
    const positions = computeGroupAwareLayout(flow.nodes, flow.groups ?? [])
    const updatedFlow: Flow = {
      ...flow,
      nodes: flow.nodes.map((n) => {
        const pos = positions.get(n.id)
        return pos ? { ...n, position: pos } : n
      }),
      positionsFinalized: true,
      updatedAt: new Date().toISOString(),
    }
    set({ currentFlow: updatedFlow })
    void persistFlow(updatedFlow)
  },

  connectNodes: (sourceId, targetId, branchLabel) => {
    if (sourceId === targetId) return
    const flow = get().currentFlow
    if (!flow) return
    const target = flow.nodes.find((n) => n.id === targetId)
    if (!target) return
    if (target.parentId !== null) {
      // The dragged edge just disappears, so say why — otherwise the gesture reads as
      // a bug in the canvas rather than as a rule about the graph.
      reportError('無法連接節點', undefined, {
        tone: 'warning',
        detail: '目標節點已經有父節點了。一個節點只能有一個父節點 —— 請先中斷它原本的連線。',
      })
      return
    }
    const updatedNodes = flow.nodes.map((n) => {
      if (n.id === sourceId) return { ...n, childIds: [...n.childIds, targetId] }
      if (n.id === targetId) return { ...n, parentId: sourceId, branchLabel }
      return n
    })
    // If the node just given a parent was the flow's recorded root, the tree above
    // `sourceId` is now the true root — walk up to find it (source may itself be
    // mid-chain, e.g. reconnecting a detached branch elsewhere in the graph).
    let rootNodeId = flow.rootNodeId
    if (targetId === flow.rootNodeId) {
      const nodeMap = new Map(updatedNodes.map((n) => [n.id, n]))
      const seen = new Set<string>()
      let cur = nodeMap.get(sourceId)
      while (cur?.parentId && !seen.has(cur.id)) {
        seen.add(cur.id)
        cur = nodeMap.get(cur.parentId)
      }
      rootNodeId = cur?.id ?? rootNodeId
    }
    const updatedFlow: Flow = { ...flow, nodes: updatedNodes, rootNodeId, updatedAt: new Date().toISOString() }
    set({ currentFlow: updatedFlow })
    void persistFlow(updatedFlow)
  },

  disconnectNodes: (parentId, childId) => {
    const flow = get().currentFlow
    if (!flow) return
    const updatedNodes = flow.nodes.map((n) => {
      if (n.id === parentId) return { ...n, childIds: n.childIds.filter((c) => c !== childId) }
      if (n.id === childId) return { ...n, parentId: null, branchLabel: undefined }
      return n
    })
    const updatedFlow: Flow = { ...flow, nodes: updatedNodes, updatedAt: new Date().toISOString() }
    set({ currentFlow: updatedFlow })
    void persistFlow(updatedFlow)
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
    const updatedFlow: Flow = { ...flow, nodes: updatedNodes, updatedAt: new Date().toISOString() }
    set({ currentFlow: updatedFlow })
    void persistFlow(updatedFlow)
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
    const updatedFlow: Flow = { ...flow, nodes, groups, positionsFinalized: true, updatedAt: new Date().toISOString() }
    set({ currentFlow: updatedFlow, selectedNodeId: null })
    void persistFlow(updatedFlow)
    return groupId
  },

  // Collapse/expand is pure view state. It rewrites every node position (group-aware relayout),
  // which would otherwise land on the undo stack and let a few toggles evict real edits.
  toggleGroupCollapsed: (groupId) => {
    const flow = get().currentFlow
    if (!flow) return
    const groups = (flow.groups ?? []).map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g))
    const positions = computeGroupAwareLayout(flow.nodes, groups)
    const nodes = flow.nodes.map((n) => {
      const pos = positions.get(n.id)
      return pos ? { ...n, position: pos } : n
    })
    const updatedFlow: Flow = { ...flow, nodes, groups, positionsFinalized: true, updatedAt: new Date().toISOString() }
    setSilently({ currentFlow: updatedFlow })
    void persistFlow(updatedFlow)
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
    const updatedFlow: Flow = { ...flow, nodes, groups, positionsFinalized: true, updatedAt: new Date().toISOString() }
    set({ currentFlow: updatedFlow })
    void persistFlow(updatedFlow)
  },

  setReplayingNode: (nodeId) => set({ replayingNodeId: nodeId }),

  setReplayStatus: (nodeId, status, error) =>
    set((state) => ({
      replayStatus: { ...state.replayStatus, [nodeId]: status },
      // Keyed alongside the status so a re-run of the same node clears the stale reason
      // rather than leaving last run's message hanging off a now-green node.
      replayErrors: error
        ? { ...state.replayErrors, [nodeId]: error }
        : omitKey(state.replayErrors, nodeId),
    })),

  clearReplayStatus: () => set({ replayStatus: {}, replayErrors: {}, replayingNodeId: null }),

  // Every node still mid-flight goes amber — the interrupted node AND, for a sub-flow, the
  // parent callFlow node, since both were started and neither reached a verdict. Verdicts
  // already recorded (green / red) are left alone; they really did happen. The next replay
  // wipes the lot via clearReplayStatus.
  markReplayCancelled: () =>
    set((state) => ({
      replayStatus: Object.fromEntries(
        Object.entries(state.replayStatus).map(([id, st]) => [id, st === 'running' ? 'cancelled' : st]),
      ),
      replayingNodeId: null,
    })),

  setIsRecording: (v) => set({ isRecording: v }),
  setIsReplaying: (v) => set({ isReplaying: v }),
  setReplaySpeed: (ms) => set({ replaySpeed: ms }),

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
      // Carry envValues and secret across: a new profile that silently dropped the
      // private flag would store the same key in the clear.
      vars: existingVars.map((v) => ({
        key: v.key,
        value: v.value,
        description: v.description ?? '',
        ...(v.envValues ? { envValues: { ...v.envValues } } : {}),
        ...(v.secret ? { secret: true } : {}),
      })),
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
    await persistFlow(updatedFlow)
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
    await persistFlow(updatedFlow)
  },

  deleteProfile: async (id) => {
    const flow = get().currentFlow
    if (!flow) return
    const updatedProfiles = (flow.profiles ?? []).filter((p) => p.id !== id)
    // Remove the deleted profile ID from all callFlow node mappings
    const updatedNodes = flow.nodes.map((n) => {
      if (n.action.type === 'callFlow' && n.action.subFlowProfileMapping && id in n.action.subFlowProfileMapping) {
        // `_removed` exists only to omit that key from `rest` — it is never read.
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
    await persistFlow(updatedFlow)
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
        ...(v.secret ? { secret: true } : {}),
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
    await persistFlow(updatedFlow)
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
        // `secret` travels with the KEY, not the value, so every profile gets it — otherwise
        // the same key would be encrypted in one profile and in the clear in another.
        const shared = { key: row.key, secret: row.secret }
        if (!isEdited) return { ...kept, ...shared }

        // The edited profile additionally takes value/description from the draft. With an
        // active environment the value lands on envValues[envId] rather than the base value.
        if (envId) {
          return {
            ...kept,
            ...shared,
            description: row.description,
            envValues: { ...kept.envValues, [envId]: row.value },
          }
        }
        return { ...kept, ...shared, value: row.value, description: row.description }
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
    await persistFlow(updatedFlow)
  },

}))

// Record undo history whenever an edit replaces currentFlow with a new object. One
// subscription covers every mutator, since all edits update currentFlow immutably.
// Project state is not merely unwatched here — it lives in `projectStore`, which this
// subscription cannot observe at all, so Ctrl+Z can never reach it.
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
