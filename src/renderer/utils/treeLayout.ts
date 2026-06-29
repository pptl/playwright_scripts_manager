import type { FlowNode, NodePosition } from '@shared/types'

export const NODE_WIDTH = 200
export const NODE_HEIGHT = 70
export const H_MARGIN = 25
export const V_GAP = 30

export interface NodeSize {
  width: number
  height: number
}

/** Per-node footprint used by the layout. Defaults to the standard action-node size.
 *  An expanded group passes its full box footprint here so the tree reserves space for it. */
export type SizeOf = (nodeId: string) => NodeSize
const defaultSizeOf: SizeOf = () => ({ width: NODE_WIDTH, height: NODE_HEIGHT })

export function computeTreeLayout(
  nodes: FlowNode[],
  rootNodeId: string,
  sizeOf: SizeOf = defaultSizeOf,
): Map<string, NodePosition> {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const positions = new Map<string, NodePosition>()

  function subtreeWidth(nodeId: string): number {
    const node = nodeMap.get(nodeId)
    const w = sizeOf(nodeId).width
    if (!node || node.childIds.length === 0) return w
    const childWidths = node.childIds.map(subtreeWidth)
    const total = childWidths.reduce((a, b) => a + b, 0) + (node.childIds.length - 1) * H_MARGIN
    return Math.max(w, total)
  }

  function place(nodeId: string, centerX: number, y: number) {
    const { width, height } = sizeOf(nodeId)
    positions.set(nodeId, { x: centerX - width / 2, y })
    const node = nodeMap.get(nodeId)
    if (!node || node.childIds.length === 0) return
    const childWidths = node.childIds.map(subtreeWidth)
    const totalW = childWidths.reduce((a, b) => a + b, 0) + (node.childIds.length - 1) * H_MARGIN
    let x = centerX - totalW / 2
    for (let i = 0; i < node.childIds.length; i++) {
      place(node.childIds[i], x + childWidths[i] / 2, y + height + V_GAP)
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
export function computeAllRootsLayout(
  nodes: FlowNode[],
  sizeOf: SizeOf = defaultSizeOf,
): Map<string, NodePosition> {
  const result = new Map<string, NodePosition>()
  const roots = nodes
    .filter((n) => n.parentId === null)
    .sort((a, b) => a.position.x - b.position.x)

  let xCursor = 0
  const placeTree = (rootId: string) => {
    const treePos = computeTreeLayout(nodes, rootId, sizeOf)
    if (treePos.size === 0) return
    let minX = Infinity
    let maxRight = -Infinity
    treePos.forEach((p, id) => {
      if (p.x < minX) minX = p.x
      const right = p.x + sizeOf(id).width
      if (right > maxRight) maxRight = right
    })
    const shift = xCursor - minX
    treePos.forEach((p, id) => result.set(id, { x: p.x + shift, y: p.y }))
    xCursor += maxRight - minX + TREE_H_GAP
  }

  for (const root of roots) placeTree(root.id)

  // Fallback: any node not reachable from a root (e.g. parentId references a missing node)
  // is treated as its own root and appended to the right, so every node gets a position.
  for (const n of nodes) {
    if (!result.has(n.id)) placeTree(n.id)
  }

  return result
}
