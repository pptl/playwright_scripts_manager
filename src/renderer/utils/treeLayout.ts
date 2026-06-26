import type { FlowNode, NodePosition } from '@shared/types'

export const NODE_WIDTH = 200
export const NODE_HEIGHT = 70
export const H_MARGIN = 25
export const V_GAP = 30

export function computeTreeLayout(nodes: FlowNode[], rootNodeId: string): Map<string, NodePosition> {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const positions = new Map<string, NodePosition>()

  function subtreeWidth(nodeId: string): number {
    const node = nodeMap.get(nodeId)
    if (!node || node.childIds.length === 0) return NODE_WIDTH
    const childWidths = node.childIds.map(subtreeWidth)
    const total = childWidths.reduce((a, b) => a + b, 0) + (node.childIds.length - 1) * H_MARGIN
    return Math.max(NODE_WIDTH, total)
  }

  function place(nodeId: string, centerX: number, y: number) {
    positions.set(nodeId, { x: centerX - NODE_WIDTH / 2, y })
    const node = nodeMap.get(nodeId)
    if (!node || node.childIds.length === 0) return
    const childWidths = node.childIds.map(subtreeWidth)
    const totalW = childWidths.reduce((a, b) => a + b, 0) + (node.childIds.length - 1) * H_MARGIN
    let x = centerX - totalW / 2
    for (let i = 0; i < node.childIds.length; i++) {
      place(node.childIds[i], x + childWidths[i] / 2, y + NODE_HEIGHT + V_GAP)
      x += childWidths[i] + H_MARGIN
    }
  }

  if (rootNodeId && nodeMap.has(rootNodeId)) {
    const totalW = subtreeWidth(rootNodeId)
    place(rootNodeId, totalW / 2, 0)
  }

  return positions
}

/** Horizontal gap between adjacent root trees in computeAllRootsLayout. */
export const TREE_H_GAP = 80

/**
 * Lay out every root tree side by side: each root (parentId === null) becomes its own
 * tree laid out by computeTreeLayout (subtree centering), then shifted left-to-right so
 * trees don't overlap. Roots are ordered by their current x to preserve relative ordering.
 */
export function computeAllRootsLayout(nodes: FlowNode[]): Map<string, NodePosition> {
  const result = new Map<string, NodePosition>()
  const roots = nodes
    .filter((n) => n.parentId === null)
    .sort((a, b) => a.position.x - b.position.x)

  let xCursor = 0
  const placeTree = (rootId: string) => {
    const treePos = computeTreeLayout(nodes, rootId)
    if (treePos.size === 0) return
    let minX = Infinity
    let maxX = -Infinity
    treePos.forEach((p) => {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
    })
    const shift = xCursor - minX
    treePos.forEach((p, id) => result.set(id, { x: p.x + shift, y: p.y }))
    xCursor += maxX - minX + NODE_WIDTH + TREE_H_GAP
  }

  for (const root of roots) placeTree(root.id)

  // Fallback: any node not reachable from a root (e.g. parentId references a missing node)
  // is treated as its own root and appended to the right, so every node gets a position.
  for (const n of nodes) {
    if (!result.has(n.id)) placeTree(n.id)
  }

  return result
}
