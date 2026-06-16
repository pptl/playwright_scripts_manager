import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { Flow, FlowNode, Action, NodePosition } from '../../shared/types'

const NODE_VERTICAL_GAP = 80
const NODE_START_Y = 50
const NODE_START_X = 300

interface FlowStore {
  // State
  flows: Pick<Flow, 'id' | 'name' | 'description' | 'updatedAt'>[]
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

  // Node management
  addActionNode: (action: Action, parentId?: string | null, branchLabel?: string) => FlowNode
  updateNode: (nodeId: string, updates: Partial<FlowNode>) => void
  deleteNode: (nodeId: string) => void
  selectNode: (nodeId: string | null) => void

  // Replay status
  setReplayingNode: (nodeId: string | null) => void
  setReplayStatus: (nodeId: string, status: 'running' | 'success' | 'error') => void
  clearReplayStatus: () => void

  // Recording flag
  setIsRecording: (v: boolean) => void
  setIsReplaying: (v: boolean) => void
  setReplaySpeed: (ms: number) => void
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

  setFlows: (flows) => set({ flows }),

  createFlow: (name, baseURL, description) => {
    const flow: Flow = {
      id: uuidv4(),
      name,
      description,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      baseURL,
      nodes: [],
      rootNodeId: '',
    }
    set({ currentFlow: flow })
    return flow
  },

  setCurrentFlow: (flow) => set({ currentFlow: flow, selectedNodeId: null, replayStatus: {}, recordingHeadId: null }),

  setRecordingHead: (id) => set({ recordingHeadId: id }),

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

    set({
      currentFlow: {
        ...flow,
        nodes: updatedNodes,
        updatedAt: new Date().toISOString(),
      },
      selectedNodeId: null,
    })
  },

  selectNode: (nodeId) => set({ selectedNodeId: nodeId }),

  setReplayingNode: (nodeId) => set({ replayingNodeId: nodeId }),

  setReplayStatus: (nodeId, status) =>
    set((state) => ({ replayStatus: { ...state.replayStatus, [nodeId]: status } })),

  clearReplayStatus: () => set({ replayStatus: {}, replayingNodeId: null }),

  setIsRecording: (v) => set({ isRecording: v }),
  setIsReplaying: (v) => set({ isReplaying: v }),
  setReplaySpeed: (ms) => set({ replaySpeed: ms }),
}))
