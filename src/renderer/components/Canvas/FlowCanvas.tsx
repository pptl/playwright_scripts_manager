import React, { useCallback, useMemo, useEffect, useState, useRef } from 'react'
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  Node,
  Edge,
  NodeMouseHandler,
  NodeChange,
  ReactFlowProvider,
  Connection,
  OnSelectionChangeParams,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { v4 as uuidv4 } from 'uuid'
import { useFlowStore } from '../../stores/flowStore'
import { ActionNode } from './ActionNode'
import { BranchEdge } from './BranchEdge'
import { NodeContextMenu } from './NodeContextMenu'
import { CanvasStatusBar } from './CanvasStatusBar'
import { ExtractSubflowModal } from './ExtractSubflowModal'
import { GroupNameModal } from './GroupNameModal'
import type { ActionNodeData } from './ActionNode'
import { GroupNode } from './GroupNode'
import { GroupBox } from './GroupBox'
import { usePlaywright } from '../../hooks/usePlaywright'
import { CallFlowModal } from '../CallFlowModal/CallFlowModal'
import type { Action } from '@shared/types'
import { computeTreeLayout } from '../../utils/treeLayout'
import { validateExtraction, extractSubflow } from '../../utils/subflowExtraction'
import { getGroupBoundary, groupBoxRect } from '../../utils/groups'

const nodeTypes = { actionNode: ActionNode, groupNode: GroupNode, groupBox: GroupBox }
const edgeTypes = { branchEdge: BranchEdge }

function FlowCanvasInner() {
  const {
    currentFlow,
    selectNode,
    selectedNodeId,
    isRecording,
    isReplaying,
    replaySpeed,
    deleteNode,
    deleteNodesOnly,
    updateNode,
    insertCallFlowBefore,
    appendCallFlowAfter,
    materializeLayout,
    relayoutAll,
    connectNodes,
    disconnectNodes,
    disconnectNode,
    createGroup,
    toggleGroupCollapsed,
    ungroupGroup,
  } = useFlowStore()
  const { replayToNode, startBranchRecording } = usePlaywright()
  const [contextMenu, setContextMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null)
  const [callFlowModal, setCallFlowModal] = useState<{ mode: 'insertBefore' | 'appendAfter'; targetNodeId: string } | null>(null)

  // Multi-select state (local — PropertyPanel/context menu still use Zustand selectedNodeId)
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set())
  const [extractModal, setExtractModal] = useState(false)
  const [extractionInfo, setExtractionInfo] = useState<{ entryNodeId: string; exitNodeId: string } | null>(null)
  const [groupModal, setGroupModal] = useState(false)

  // Debounced disk save ref
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Latest position per node seen during an in-progress drag (drag-stop events omit position)
  const dragPosRef = useRef<Map<string, { x: number; y: number }>>(new Map())

  // Flip a group's collapsed state / dissolve a group, then persist.
  const onToggleGroup = useCallback(
    (groupId: string) => {
      toggleGroupCollapsed(groupId)
      const updated = useFlowStore.getState().currentFlow
      if (updated) window.electronAPI.saveFlow(updated).catch(console.error)
    },
    [toggleGroupCollapsed],
  )
  const onUngroup = useCallback(
    (groupId: string) => {
      ungroupGroup(groupId)
      const updated = useFlowStore.getState().currentFlow
      if (updated) window.electronAPI.saveFlow(updated).catch(console.error)
    },
    [ungroupGroup],
  )

  // fn.position is the single source of truth for rendering. Collapsed groups hide their
  // members and render a single group node in the entry's slot; expanded groups render a
  // background box framing their member nodes.
  const rfNodes = useMemo(() => {
    if (!currentFlow) return []
    const groups = currentFlow.groups ?? []
    const groupById = new Map(groups.map((g) => [g.id, g]))
    const nodeById = new Map(currentFlow.nodes.map((n) => [n.id, n]))
    const out: Node[] = []

    // Expanded-group background boxes first → render behind member nodes
    for (const g of groups) {
      if (g.collapsed) continue
      const members = currentFlow.nodes.filter((n) => n.groupId === g.id)
      const rect = groupBoxRect(members)
      if (!rect) continue
      out.push({
        id: `groupbox:${g.id}`,
        type: 'groupBox',
        position: { x: rect.x, y: rect.y },
        data: { groupId: g.id, name: g.name, width: rect.width, height: rect.height, onToggle: onToggleGroup, onUngroup },
        draggable: false,
        selectable: false,
        zIndex: 0,
      })
    }

    // Visible action nodes (collapsed-group members are hidden)
    for (const fn of currentFlow.nodes) {
      const g = fn.groupId ? groupById.get(fn.groupId) : undefined
      if (g && g.collapsed) continue
      out.push({
        id: fn.id,
        type: 'actionNode',
        position: fn.position,
        data: { flowNode: fn },
        selected: selectedNodeIds.size <= 1 ? fn.id === selectedNodeId : selectedNodeIds.has(fn.id),
        zIndex: g ? 1 : undefined,
      })
    }

    // Collapsed group nodes, placed at their entry node's slot
    for (const g of groups) {
      if (!g.collapsed) continue
      const b = getGroupBoundary(currentFlow.nodes, g.id)
      if (!b) continue
      const entry = nodeById.get(b.entryId)!
      out.push({
        id: `group:${g.id}`,
        type: 'groupNode',
        position: entry.position,
        data: { groupId: g.id, name: g.name, count: b.memberIds.size, onToggle: onToggleGroup, onUngroup },
        zIndex: 1,
      })
    }
    return out
  }, [currentFlow, selectedNodeId, selectedNodeIds, onToggleGroup, onUngroup])

  const rfEdges: Edge[] = useMemo(() => {
    if (!currentFlow) return []
    const groups = currentFlow.groups ?? []
    const collapsedIds = new Set(groups.filter((g) => g.collapsed).map((g) => g.id))
    const nodeById = new Map(currentFlow.nodes.map((n) => [n.id, n]))
    // Route an endpoint through its collapsed group node, if any
    const repr = (id: string) => {
      const n = nodeById.get(id)
      if (n && n.groupId && collapsedIds.has(n.groupId)) return `group:${n.groupId}`
      return id
    }
    const edges: Edge[] = []
    const seen = new Set<string>()
    for (const node of currentFlow.nodes) {
      for (const childId of node.childIds) {
        const s = repr(node.id)
        const t = repr(childId)
        if (s === t) continue // internal edge of a collapsed group
        const id = `${s}->${t}`
        if (seen.has(id)) continue
        seen.add(id)
        const child = nodeById.get(childId)
        edges.push({ id, source: s, target: t, type: 'branchEdge', data: { label: child?.branchLabel } })
      }
    }
    return edges
  }, [currentFlow])

  const [nodes, setNodes, onNodesChange] = useNodesState<ActionNodeData>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])

  // On flow load: if positions were never finalized, materialize the tree layout into the
  // store (one source of truth) and persist, so render and drag share the same positions.
  useEffect(() => {
    if (!currentFlow || currentFlow.positionsFinalized || !currentFlow.rootNodeId) return
    const layout = computeTreeLayout(currentFlow.nodes, currentFlow.rootNodeId)
    materializeLayout(layout)
    const updated = useFlowStore.getState().currentFlow
    if (updated) window.electronAPI.saveFlow(updated).catch(console.error)
  }, [currentFlow?.id, materializeLayout])

  useEffect(() => {
    setNodes(rfNodes)
  }, [rfNodes, setNodes])

  useEffect(() => {
    setEdges(rfEdges)
  }, [rfEdges, setEdges])

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => {
      // Group nodes/boxes handle their own clicks (expand/collapse); ignore here
      if (node.id.startsWith('group:') || node.id.startsWith('groupbox:')) return
      // Only update property panel target on single-select clicks
      if (selectedNodeIds.size <= 1) {
        selectNode(node.id)
      }
    },
    [selectNode, selectedNodeIds],
  )

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes)

      // ReactFlow's drag-stop event (dragging:false) does NOT carry a position field —
      // the final position only appears on the dragging:true events. Track the latest
      // position per node from those, then persist it when the drag stops.
      for (const c of changes) {
        if (c.type === 'position' && (c as any).position) {
          dragPosRef.current.set((c as any).id, (c as any).position)
        }
      }

      const dragStops = changes.filter(
        (c): c is NodeChange & { type: 'position'; id: string; dragging: false } =>
          c.type === 'position' && (c as any).dragging === false,
      )

      if (dragStops.length > 0) {
        dragStops.forEach((c) => {
          const pos = dragPosRef.current.get(c.id)
          if (pos) {
            // A collapsed group node is rendered at its entry node's slot — persist the drag
            // onto the entry node so it stays put. Group boxes are not draggable.
            let targetId = c.id
            if (c.id.startsWith('group:')) {
              const gid = c.id.slice('group:'.length)
              const cf = useFlowStore.getState().currentFlow
              const entryId = cf ? getGroupBoundary(cf.nodes, gid)?.entryId : undefined
              if (!entryId) {
                dragPosRef.current.delete(c.id)
                return
              }
              targetId = entryId
            }
            updateNode(targetId, { position: pos })
            dragPosRef.current.delete(c.id)
          }
        })

        // Debounce disk save
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = setTimeout(async () => {
          const updated = useFlowStore.getState().currentFlow
          if (updated) await window.electronAPI.saveFlow(updated).catch(console.error)
        }, 500)
      }
    },
    [onNodesChange, updateNode],
  )

  const onSelectionChange = useCallback(({ nodes: selNodes }: OnSelectionChangeParams) => {
    // Group nodes/boxes are not real flow nodes — exclude them from multi-select operations
    setSelectedNodeIds(new Set(selNodes.map((n) => n.id).filter((id) => !id.startsWith('group'))))
  }, [])

  const onPaneClick = useCallback(() => {
    selectNode(null)
    setContextMenu(null)
    setSelectedNodeIds(new Set())
  }, [selectNode])

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault()
      // No context menu on group nodes/boxes — use their inline controls
      if (node.id.startsWith('group:') || node.id.startsWith('groupbox:')) return
      selectNode(node.id)
      setContextMenu({ nodeId: node.id, x: event.clientX, y: event.clientY })
    },
    [selectNode],
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      connectNodes(connection.source, connection.target)
      const updated = useFlowStore.getState().currentFlow
      if (updated) window.electronAPI.saveFlow(updated).catch(console.error)
    },
    [connectNodes],
  )

  const handleExtractClick = useCallback(() => {
    if (!currentFlow) return
    const validation = validateExtraction(currentFlow.nodes, selectedNodeIds)
    if (!validation.valid) {
      alert(validation.error)
      return
    }
    setExtractionInfo({ entryNodeId: validation.entryNodeId!, exitNodeId: validation.exitNodeId! })
    setExtractModal(true)
  }, [currentFlow, selectedNodeIds])

  // Form an in-place visual group from the current multi-selection (same shape constraints
  // as sub-flow extraction: single entry, single exit, fully connected).
  const handleGroupClick = useCallback(() => {
    if (!currentFlow) return
    const validation = validateExtraction(currentFlow.nodes, selectedNodeIds)
    if (!validation.valid) {
      alert(validation.error)
      return
    }
    setGroupModal(true)
  }, [currentFlow, selectedNodeIds])

  const handleGroupConfirm = useCallback(
    (name: string) => {
      createGroup(Array.from(selectedNodeIds), name)
      setSelectedNodeIds(new Set())
      setGroupModal(false)
      const updated = useFlowStore.getState().currentFlow
      if (updated) window.electronAPI.saveFlow(updated).catch(console.error)
    },
    [selectedNodeIds, createGroup],
  )

  const handleExtractConfirm = useCallback(
    async (subFlowName: string) => {
      if (!currentFlow || !extractionInfo) return
      const subFlowId = uuidv4()
      const callFlowNodeId = uuidv4()
      const { newSubFlow, updatedParentFlow } = extractSubflow(
        currentFlow,
        selectedNodeIds,
        extractionInfo.entryNodeId,
        extractionInfo.exitNodeId,
        subFlowName,
        subFlowId,
        callFlowNodeId,
      )
      await window.electronAPI.saveFlow(newSubFlow)
      useFlowStore.getState().setCurrentFlow(updatedParentFlow)
      await window.electronAPI.saveFlow(updatedParentFlow)
      const list = await window.electronAPI.listFlows()
      useFlowStore.getState().setFlows(list)
      setSelectedNodeIds(new Set())
      setExtractModal(false)
    },
    [currentFlow, extractionInfo, selectedNodeIds],
  )

  if (!currentFlow) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#64748b',
          fontSize: 16,
        }}
      >
        選擇或建立一個流程以開始
      </div>
    )
  }

  const entryNode = extractionInfo
    ? currentFlow.nodes.find((n) => n.id === extractionInfo.entryNodeId)
    : null
  const exitNode = extractionInfo
    ? currentFlow.nodes.find((n) => n.id === extractionInfo.exitNodeId)
    : null

  return (
    <div style={{ flex: 1, position: 'relative' }}>
      {contextMenu && (() => {
        const contextNode = currentFlow?.nodes.find((n) => n.id === contextMenu.nodeId)
        const VALUE_TYPES = new Set(['fill', 'selectOption', 'goto', 'press', 'assertText', 'assertValue'])
        const hasValue = !!(contextNode?.action.value && VALUE_TYPES.has(contextNode.action.type))
        const multi = selectedNodeIds.size >= 2 && selectedNodeIds.has(contextMenu.nodeId)
        const deleteOnlyLabel = multi ? `刪除選取的 ${selectedNodeIds.size} 個節點` : '刪除此節點'
        const disconnectLabel = multi ? `斷開選取的 ${selectedNodeIds.size} 個節點連綫` : '斷開此節點連綫'
        return (
          <NodeContextMenu
            nodeId={contextMenu.nodeId}
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
            onReplay={() => replayToNode(contextMenu.nodeId, replaySpeed)}
            onBranchRecord={() => startBranchRecording(contextMenu.nodeId)}
            onDelete={async () => {
              deleteNode(contextMenu.nodeId)
              const updated = useFlowStore.getState().currentFlow
              if (updated) await window.electronAPI.saveFlow(updated)
            }}
            deleteOnlyLabel={deleteOnlyLabel}
            onDeleteNodeOnly={async () => {
              const ids = multi ? Array.from(selectedNodeIds) : [contextMenu.nodeId]
              deleteNodesOnly(ids)
              setSelectedNodeIds(new Set())
              const updated = useFlowStore.getState().currentFlow
              if (updated) await window.electronAPI.saveFlow(updated)
            }}
            isRecording={isRecording}
            isReplaying={isReplaying}
            hasValue={hasValue}
            currentCaptureAs={contextNode?.action.captureAs}
            onCaptureAsVar={async (varName) => {
              if (!contextNode) return
              updateNode(contextNode.id, {
                action: { ...contextNode.action, captureAs: varName },
              })
              const updated = useFlowStore.getState().currentFlow
              if (updated) await window.electronAPI.saveFlow(updated)
            }}
            onInsertCallFlowBefore={() => setCallFlowModal({ mode: 'insertBefore', targetNodeId: contextMenu.nodeId })}
            onAppendCallFlowAfter={() => setCallFlowModal({ mode: 'appendAfter', targetNodeId: contextMenu.nodeId })}
            showExtract={multi}
            selectedCount={selectedNodeIds.size}
            onExtract={handleExtractClick}
            onGroup={handleGroupClick}
            onDisconnect={async () => {
              const ids = multi ? Array.from(selectedNodeIds) : [contextMenu.nodeId]
              ids.forEach((id) => disconnectNode(id))
              const updated = useFlowStore.getState().currentFlow
              if (updated) await window.electronAPI.saveFlow(updated)
            }}
            disconnectLabel={disconnectLabel}
          />
        )
      })()}
      {callFlowModal && (
        <CallFlowModal
          mode={callFlowModal.mode}
          targetNodeId={callFlowModal.targetNodeId}
          onClose={() => setCallFlowModal(null)}
          onConfirm={async (callFlowAction: Action) => {
            if (callFlowModal.mode === 'insertBefore') {
              insertCallFlowBefore(callFlowModal.targetNodeId, callFlowAction)
              // Inserting (esp. before the root) shifts the tree; re-layout so the
              // new node and its subtree don't overlap other flows on the canvas.
              relayoutAll()
            } else {
              appendCallFlowAfter(callFlowModal.targetNodeId, callFlowAction)
            }
            setCallFlowModal(null)
            const updated = useFlowStore.getState().currentFlow
            if (updated) await window.electronAPI.saveFlow(updated).catch(console.error)
          }}
        />
      )}
      {extractModal && (
        <ExtractSubflowModal
          selectedCount={selectedNodeIds.size}
          entryNodeDescription={entryNode?.action.description ?? ''}
          exitNodeDescription={exitNode?.action.description ?? ''}
          onConfirm={handleExtractConfirm}
          onClose={() => setExtractModal(false)}
        />
      )}
      {groupModal && (
        <GroupNameModal
          selectedCount={selectedNodeIds.size}
          onConfirm={handleGroupConfirm}
          onClose={() => setGroupModal(false)}
        />
      )}

      {/* Recording indicator */}
      {isRecording && (
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 10,
            background: '#dc2626',
            color: '#fff',
            padding: '4px 14px',
            borderRadius: 20,
            fontSize: 13,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            animation: 'pulse 1.2s infinite',
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: '#fff',
              display: 'inline-block',
            }}
          />
          錄製中
        </div>
      )}

      {/* Multi-select status bar */}
      {selectedNodeIds.size >= 2 && !isRecording && !isReplaying && (
        <CanvasStatusBar selectedCount={selectedNodeIds.size} />
      )}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={onPaneClick}
        onSelectionChange={onSelectionChange}
        onConnect={onConnect}
        onNodesDelete={() => { /* no-op: node deletion only via context menu */ }}
        onEdgesDelete={(edgesToDelete) => {
          edgesToDelete.forEach((e) => disconnectNodes(e.source, e.target))
          const updated = useFlowStore.getState().currentFlow
          if (updated) window.electronAPI.saveFlow(updated).catch(console.error)
        }}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        multiSelectionKeyCode="Shift"
        selectionOnDrag={false}
        deleteKeyCode={null}
        fitView
        style={{ background: '#0f172a' }}
      >
        <Background color="#1e293b" gap={20} />
        <Controls />
        <MiniMap
          nodeColor={(n) => {
            const d = n.data as ActionNodeData
            const type = d?.flowNode?.action?.type
            const colors: Record<string, string> = {
              goto: '#3b82f6',
              fill: '#8b5cf6',
              selectOption: '#8b5cf6',
              click: '#6b7280',
            }
            return colors[type] ?? '#6b7280'
          }}
          style={{ background: '#1e293b' }}
        />
      </ReactFlow>
    </div>
  )
}

export function FlowCanvas() {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner />
    </ReactFlowProvider>
  )
}
