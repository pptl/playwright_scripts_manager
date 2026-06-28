import type { FlowNode, FlowGroup, NodePosition } from '@shared/types'
import { computeTreeLayout, computeAllRootsLayout, NODE_WIDTH, NODE_HEIGHT, type SizeOf } from './treeLayout'

// Expanded-group box geometry — shared by the layout (space reservation) and the renderer
// (GroupBox / FlowCanvas) so the drawn frame exactly matches the slot the layout reserves.
export const GROUP_BOX_HEADER = 26
export const GROUP_PAD_X = 18
export const GROUP_HEADER_GAP = 10
export const GROUP_PAD_BOTTOM = 18

export interface GroupBoundary {
  memberIds: Set<string>
  entryId: string
  exitId: string
}

/** Resolve a group's member set plus its single entry (parent outside the group) and single
 *  exit (all children outside the group). Returns null if the group is empty or malformed. */
export function getGroupBoundary(nodes: FlowNode[], groupId: string): GroupBoundary | null {
  const members = nodes.filter((n) => n.groupId === groupId)
  if (members.length === 0) return null
  const memberIds = new Set(members.map((m) => m.id))
  const entry = members.find((m) => m.parentId === null || !memberIds.has(m.parentId))
  const exit = members.find((m) => m.childIds.every((c) => !memberIds.has(c)))
  if (!entry || !exit) return null
  return { memberIds, entryId: entry.id, exitId: exit.id }
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Lay out a group's members in isolation (rooted at its entry) and return their relative
 *  positions plus the bounding box, used both to size the box and to place the members. */
function layoutMembers(
  members: FlowNode[],
  boundary: GroupBoundary,
): { positions: Map<string, NodePosition>; minX: number; minY: number; width: number; height: number } | null {
  const memberNodes = members.map((m) => ({
    ...m,
    parentId: m.id === boundary.entryId ? null : m.parentId,
    childIds: m.childIds.filter((c) => boundary.memberIds.has(c)),
  }))
  const positions = computeTreeLayout(memberNodes, boundary.entryId)
  if (positions.size === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  positions.forEach((p) => {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + NODE_WIDTH)
    maxY = Math.max(maxY, p.y + NODE_HEIGHT)
  })
  return { positions, minX, minY, width: maxX - minX, height: maxY - minY }
}

/** The box rectangle to draw around a set of already-positioned member nodes. */
export function groupBoxRect(members: FlowNode[]): Rect | null {
  if (members.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const m of members) {
    minX = Math.min(minX, m.position.x)
    minY = Math.min(minY, m.position.y)
    maxX = Math.max(maxX, m.position.x + NODE_WIDTH)
    maxY = Math.max(maxY, m.position.y + NODE_HEIGHT)
  }
  const x = minX - GROUP_PAD_X
  const y = minY - GROUP_BOX_HEADER - GROUP_HEADER_GAP
  return {
    x,
    y,
    width: maxX + GROUP_PAD_X - x,
    height: maxY + GROUP_PAD_BOTTOM - y,
  }
}

/**
 * Lay out the flow with groups treated as single slots in the outer tree.
 *
 * Every group becomes one synthetic node (`group:<id>`) wired at its entry/exit boundary.
 * A collapsed group is sized like a normal node; an expanded group is sized to its full box
 * footprint (member bounding box + header + padding), so the standard inter-node gaps keep
 * the box clear of neighbours. After the outer layout places each synthetic node, expanded
 * members are positioned inside the reserved box and the collapsed entry takes the slot.
 *
 * Returns positions keyed by REAL node id (collapsed members other than the entry are omitted).
 */
export function computeGroupAwareLayout(
  nodes: FlowNode[],
  groups: FlowGroup[],
): Map<string, NodePosition> {
  if (groups.length === 0) return computeAllRootsLayout(nodes)

  const groupById = new Map(groups.map((g) => [g.id, g]))
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const groupOf = (n: FlowNode | undefined) =>
    n && n.groupId && groupById.has(n.groupId) ? groupById.get(n.groupId)! : undefined
  const reprOf = (id: string | null): string | null => {
    if (id == null) return null
    const g = groupOf(nodeById.get(id))
    return g ? `group:${g.id}` : id
  }

  // Internal layout + footprint per group
  const boundaries = new Map<string, GroupBoundary>()
  const internals = new Map<string, NonNullable<ReturnType<typeof layoutMembers>>>()
  for (const g of groups) {
    const b = getGroupBoundary(nodes, g.id)
    if (!b) continue
    boundaries.set(g.id, b)
    const members = nodes.filter((n) => n.groupId === g.id)
    const laid = layoutMembers(members, b)
    if (laid) internals.set(g.id, laid)
  }

  // Build the outer view graph: one synthetic node per group + every non-member node
  const view: FlowNode[] = []
  for (const g of groups) {
    const b = boundaries.get(g.id)
    if (!b) continue
    const entry = nodeById.get(b.entryId)!
    const exit = nodeById.get(b.exitId)!
    const childIds = Array.from(
      new Set(exit.childIds.filter((c) => !b.memberIds.has(c)).map((c) => reprOf(c)!).filter(Boolean)),
    )
    view.push({
      id: `group:${g.id}`,
      action: { type: 'callFlow' } as FlowNode['action'],
      position: entry.position,
      parentId: reprOf(entry.parentId),
      childIds,
      branchLabel: entry.branchLabel,
    })
  }
  for (const n of nodes) {
    if (groupOf(n)) continue
    view.push({
      ...n,
      parentId: reprOf(n.parentId),
      childIds: Array.from(new Set(n.childIds.map((c) => reprOf(c)!).filter(Boolean))),
    })
  }

  const sizeOf: SizeOf = (id) => {
    if (id.startsWith('group:')) {
      const gid = id.slice('group:'.length)
      const g = groupById.get(gid)
      const f = internals.get(gid)
      if (g && !g.collapsed && f) {
        return {
          width: f.width + 2 * GROUP_PAD_X,
          height: GROUP_BOX_HEADER + GROUP_HEADER_GAP + f.height + GROUP_PAD_BOTTOM,
        }
      }
    }
    return { width: NODE_WIDTH, height: NODE_HEIGHT }
  }

  const viewPos = computeAllRootsLayout(view, sizeOf)

  const result = new Map<string, NodePosition>()
  for (const n of nodes) {
    if (groupOf(n)) continue
    const p = viewPos.get(n.id)
    if (p) result.set(n.id, p)
  }
  for (const g of groups) {
    const b = boundaries.get(g.id)
    if (!b) continue
    const gp = viewPos.get(`group:${g.id}`)
    if (!gp) continue
    if (g.collapsed) {
      result.set(b.entryId, gp) // collapsed group node renders at the entry's slot
      continue
    }
    const f = internals.get(g.id)
    if (!f) continue
    // The box top-left equals gp; align members so their box lands exactly there.
    const dx = gp.x + GROUP_PAD_X - f.minX
    const dy = gp.y + GROUP_BOX_HEADER + GROUP_HEADER_GAP - f.minY
    f.positions.forEach((p, id) => result.set(id, { x: p.x + dx, y: p.y + dy }))
  }
  return result
}
