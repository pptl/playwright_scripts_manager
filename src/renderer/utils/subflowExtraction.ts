import type { Flow, FlowNode } from '@shared/types'
import { computeTreeLayout } from './treeLayout'

export interface ExtractionValidation {
  valid: boolean
  error?: string
  entryNodeId?: string
  exitNodeId?: string
}

export interface ExtractResult {
  newSubFlow: Flow
  updatedParentFlow: Flow
}

export function validateExtraction(
  allNodes: FlowNode[],
  selectedIds: Set<string>,
): ExtractionValidation {
  if (selectedIds.size < 2) {
    return { valid: false, error: '請至少選取 2 個節點' }
  }

  const nodeMap = new Map(allNodes.map((n) => [n.id, n]))

  // Entry: selected node whose parent is null or outside selection
  const entryNodes = allNodes.filter(
    (n) => selectedIds.has(n.id) && (n.parentId === null || !selectedIds.has(n.parentId)),
  )
  if (entryNodes.length !== 1) {
    return { valid: false, error: '選取的節點必須有唯一的入口節點（恰好一個節點的父節點在選取範圍之外）' }
  }

  // Exit: selected node where ALL children are outside selection (or has no children)
  const exitNodes = allNodes.filter(
    (n) => selectedIds.has(n.id) && n.childIds.every((cid) => !selectedIds.has(cid)),
  )
  if (exitNodes.length !== 1) {
    return {
      valid: false,
      error:
        exitNodes.length === 0
          ? '選取的節點必須有唯一的出口節點'
          : '選取的節點有多個出口（請確保選取範圍底部只有一個節點連接到外部）',
    }
  }

  // Connectivity: BFS from entry within selection — all selected nodes must be reachable
  const entryId = entryNodes[0].id
  const visited = new Set<string>()
  const queue = [entryId]
  while (queue.length > 0) {
    const cur = queue.shift()!
    if (visited.has(cur)) continue
    visited.add(cur)
    const node = nodeMap.get(cur)
    if (!node) continue
    for (const cid of node.childIds) {
      if (selectedIds.has(cid) && !visited.has(cid)) queue.push(cid)
    }
  }
  for (const id of selectedIds) {
    if (!visited.has(id)) {
      return { valid: false, error: '選取的節點必須是相互連接的（不能有孤立的節點）' }
    }
  }

  return { valid: true, entryNodeId: entryId, exitNodeId: exitNodes[0].id }
}

export function extractSubflow(
  parentFlow: Flow,
  selectedIds: Set<string>,
  entryNodeId: string,
  exitNodeId: string,
  subFlowName: string,
  subFlowId: string,
  callFlowNodeId: string,
): ExtractResult {
  const allNodes = parentFlow.nodes
  const nodeMap = new Map(allNodes.map((n) => [n.id, n]))

  const entryNode = nodeMap.get(entryNodeId)!
  const exitNode = nodeMap.get(exitNodeId)!

  // Build sub-flow nodes: copy selected nodes, re-root entry, trim cross-boundary childIds
  const subFlowNodes: FlowNode[] = Array.from(selectedIds).map((id) => {
    const n = nodeMap.get(id)!
    return {
      ...n,
      parentId: n.id === entryNodeId ? null : n.parentId,
      branchLabel: n.id === entryNodeId ? undefined : n.branchLabel,
      childIds: n.childIds.filter((cid) => selectedIds.has(cid)),
    }
  })

  // Apply clean layout to the sub-flow
  const subLayout = computeTreeLayout(subFlowNodes, entryNodeId)
  const subFlowNodesWithLayout = subFlowNodes.map((n) => ({
    ...n,
    position: subLayout.get(n.id) ?? n.position,
  }))

  const newSubFlow: Flow = {
    id: subFlowId,
    name: subFlowName,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    baseURL: parentFlow.baseURL,
    projectId: parentFlow.projectId,
    profiles: [],
    nodes: subFlowNodesWithLayout,
    rootNodeId: entryNodeId,
    positionsFinalized: false,
  }

  // Children of exit node that are OUTSIDE the selection become children of the callFlow node
  const callFlowChildren = exitNode.childIds.filter((cid) => !selectedIds.has(cid))

  const callFlowNode: FlowNode = {
    id: callFlowNodeId,
    action: {
      id: callFlowNodeId,
      type: 'callFlow',
      selector: '',
      description: `呼叫子流程: ${subFlowName}`,
      timestamp: Date.now(),
      url: '',
      isPageNavigation: false,
      subFlowId,
      subFlowExitNodeId: exitNodeId,
      subFlowProfileMapping: {},
    },
    position: entryNode.position,
    parentId: entryNode.parentId,
    childIds: callFlowChildren,
    branchLabel: entryNode.branchLabel,
  }

  // Build remaining nodes (all non-selected), rewiring parent/child references
  const remainingNodes = allNodes
    .filter((n) => !selectedIds.has(n.id))
    .map((n) => {
      // Entry's original parent: replace entryNodeId with callFlowNodeId in its childIds
      if (n.childIds.includes(entryNodeId)) {
        return {
          ...n,
          childIds: n.childIds.map((cid) => (cid === entryNodeId ? callFlowNodeId : cid)),
        }
      }
      // Nodes that were children of exit (outside selection): point to callFlowNode
      if (callFlowChildren.includes(n.id)) {
        return { ...n, parentId: callFlowNodeId }
      }
      return n
    })
  remainingNodes.push(callFlowNode)

  // If entry was the root, the callFlow node becomes the new root
  const newRootNodeId =
    entryNode.parentId === null ? callFlowNodeId : parentFlow.rootNodeId

  const updatedParentFlow: Flow = {
    ...parentFlow,
    nodes: remainingNodes,
    rootNodeId: newRootNodeId,
    updatedAt: new Date().toISOString(),
  }

  return { newSubFlow, updatedParentFlow }
}
