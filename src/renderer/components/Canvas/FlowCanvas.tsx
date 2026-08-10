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
  useReactFlow,
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
import { AddNodeModal } from '../AddNodeModal/AddNodeModal'
import type { Action, Flow } from '@shared/types'
import { computeTreeLayout } from '../../utils/treeLayout'
import { validateExtraction, extractSubflow } from '../../utils/subflowExtraction'
import { getGroupBoundary, groupBoxRect } from '../../utils/groups'
import { Menu, MenuItem } from '../common/Menu'
import { notify } from '../../stores/confirmStore'

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
    runWithoutHistory,
    runAsOneHistoryStep,
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
    addNodeAt,
  } = useFlowStore()
  const { replayToNode, startBranchRecording } = usePlaywright()
  const { screenToFlowPosition } = useReactFlow()
  const [contextMenu, setContextMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null)
  const [callFlowModal, setCallFlowModal] = useState<{ mode: 'insertBefore' | 'appendAfter'; targetNodeId: string } | null>(null)
  // Empty-canvas right-click menu + "加入節點" dialog. flowX/flowY = canvas coords where the node lands.
  const [paneMenu, setPaneMenu] = useState<{ x: number; y: number; flowX: number; flowY: number } | null>(null)
  const [addNodeModal, setAddNodeModal] = useState<{ flowX: number; flowY: number } | null>(null)

  // Multi-select state (local — PropertyPanel/context menu still use Zustand selectedNodeId)
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set())
  const [extractModal, setExtractModal] = useState(false)
  const [extractionInfo, setExtractionInfo] = useState<{ entryNodeId: string; exitNodeId: string } | null>(null)
  const [groupModal, setGroupModal] = useState(false)

  // Debounced disk save ref
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The exact flow a debounced drag save is still owed to. Held so the flush effect can
  // persist it even after the store has already moved on to a different flow.
  const pendingSaveRef = useRef<Flow | null>(null)
  // Latest position per node seen during an in-progress drag (drag-stop events omit position)
  const dragPosRef = useRef<Map<string, { x: number; y: number }>>(new Map())

  // Flip a group's collapsed state / dissolve a group. Both actions persist themselves.
  const onToggleGroup = useCallback(
    (groupId: string) => toggleGroupCollapsed(groupId),
    [toggleGroupCollapsed],
  )
  const onUngroup = useCallback(
    (groupId: string) => ungroupGroup(groupId),
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
  // store (one source of truth), so render and drag share the same positions. Persists itself.
  useEffect(() => {
    if (!currentFlow || currentFlow.positionsFinalized || !currentFlow.rootNodeId) return
    const layout = computeTreeLayout(currentFlow.nodes, currentFlow.rootNodeId)
    // History suppression lives inside materializeLayout — this is automatic, not a user edit.
    materializeLayout(layout)
  }, [currentFlow?.id, materializeLayout])

  // Flush any debounced drag save before the flow changes or the canvas unmounts — otherwise
  // a drag followed by a quick flow switch is silently lost.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      const pending = pendingSaveRef.current
      pendingSaveRef.current = null
      // Only drag saves are ever pending here, so the same touch:false applies.
      if (pending) window.electronAPI.saveFlow(pending, false).catch(console.error)
    }
  }, [currentFlow?.id])

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
          // Rounded: sub-pixel coordinates are invisible on screen but show up as
          // noise in the flow's JSON every time it is committed.
          const { x, y } = (c as any).position
          dragPosRef.current.set((c as any).id, { x: Math.round(x), y: Math.round(y) })
        }
      }

      const dragStops = changes.filter(
        (c): c is NodeChange & { type: 'position'; id: string; dragging: false } =>
          c.type === 'position' && (c as any).dragging === false,
      )

      if (dragStops.length > 0) {
        // Position-only drag updates must not pollute the undo stack — otherwise
        // every small reposition would flood history. Persist them silently.
        runWithoutHistory(() => {
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
        })

        // Debounce disk save. The flow is captured now rather than re-read when the timer
        // fires, so switching flows inside the 500 ms window can't write the wrong document
        // (or silently drop the drag — the flush effect below persists what was captured).
        pendingSaveRef.current = useFlowStore.getState().currentFlow ?? null
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = setTimeout(() => {
          saveTimerRef.current = null
          const pending = pendingSaveRef.current
          pendingSaveRef.current = null
          // touch:false — moving a node is not a content change, and bumping
          // updatedAt on every drag makes the JSON conflict in git for nothing.
          if (pending) window.electronAPI.saveFlow(pending, false).catch(console.error)
        }, 500)
      }
    },
    [onNodesChange, updateNode, runWithoutHistory],
  )

  const onSelectionChange = useCallback(({ nodes: selNodes }: OnSelectionChangeParams) => {
    // Group nodes/boxes are not real flow nodes — exclude them from multi-select operations
    setSelectedNodeIds(new Set(selNodes.map((n) => n.id).filter((id) => !id.startsWith('group'))))
  }, [])

  const onPaneClick = useCallback(() => {
    setContextMenu(null)
    setPaneMenu(null)
    selectNode(null)
    setSelectedNodeIds(new Set())
  }, [selectNode])

  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault()
      setContextMenu(null)
      const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      setPaneMenu({ x: event.clientX, y: event.clientY, flowX: flow.x, flowY: flow.y })
    },
    [screenToFlowPosition],
  )

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
    },
    [connectNodes],
  )

  const handleExtractClick = useCallback(() => {
    if (!currentFlow) return
    const validation = validateExtraction(currentFlow.nodes, selectedNodeIds)
    if (!validation.valid) {
      void notify({ title: '無法另存為子流程', message: validation.error })
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
      void notify({ title: '無法組成群組', message: validation.error })
      return
    }
    setGroupModal(true)
  }, [currentFlow, selectedNodeIds])

  const handleGroupConfirm = useCallback(
    (name: string) => {
      createGroup(Array.from(selectedNodeIds), name)
      setSelectedNodeIds(new Set())
      setGroupModal(false)
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
            // Node deletion is deliberately NOT confirmed: it is a high-frequency editing
            // gesture and Ctrl+Z already restores the node (and its subtree). Every other
            // destructive action in the app does confirm — this is the intended exception.
            onDelete={() => {
              deleteNode(contextMenu.nodeId)
            }}
            deleteOnlyLabel={deleteOnlyLabel}
            onDeleteNodeOnly={() => {
              const ids = multi ? Array.from(selectedNodeIds) : [contextMenu.nodeId]
              deleteNodesOnly(ids)
              setSelectedNodeIds(new Set())
            }}
            isRecording={isRecording}
            isReplaying={isReplaying}
            hasValue={hasValue}
            currentCaptureAs={contextNode?.action.captureAs}
            onCaptureAsVar={(varName) => {
              if (!contextNode) return
              // Session variables are config — kept out of undo history so the canvas and the
              // SessionVarList 🗑 behave the same way (see flowStore's history header comment).
              // updateNode persists itself (this isn't a position-only update).
              runWithoutHistory(() => {
                updateNode(contextNode.id, {
                  action: { ...contextNode.action, captureAs: varName },
                })
              })
            }}
            onInsertCallFlowBefore={() => setCallFlowModal({ mode: 'insertBefore', targetNodeId: contextMenu.nodeId })}
            onAppendCallFlowAfter={() => setCallFlowModal({ mode: 'appendAfter', targetNodeId: contextMenu.nodeId })}
            showExtract={multi}
            selectedCount={selectedNodeIds.size}
            onExtract={handleExtractClick}
            onGroup={handleGroupClick}
            onDisconnect={() => {
              const ids = multi ? Array.from(selectedNodeIds) : [contextMenu.nodeId]
              // One gesture = one Ctrl+Z, however many nodes were selected.
              runAsOneHistoryStep(() => ids.forEach((id) => disconnectNode(id)))
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
          onConfirm={(callFlowAction: Action) => {
            // Insert + relayout is one gesture — batch so a single Ctrl+Z reverses both.
            // Both actions persist themselves; relayoutAll's save (running last) wins.
            runAsOneHistoryStep(() => {
              if (callFlowModal.mode === 'insertBefore') {
                insertCallFlowBefore(callFlowModal.targetNodeId, callFlowAction)
                // Inserting (esp. before the root) shifts the tree; re-layout so the
                // new node and its subtree don't overlap other flows on the canvas.
                relayoutAll()
              } else {
                appendCallFlowAfter(callFlowModal.targetNodeId, callFlowAction)
              }
            })
            setCallFlowModal(null)
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

      {/* Empty-canvas right-click menu */}
      {paneMenu && (
        <Menu x={paneMenu.x} y={paneMenu.y} minWidth={140} onClose={() => setPaneMenu(null)}>
          <MenuItem
            icon="➕"
            label="加入節點"
            onClick={() => {
              setAddNodeModal({ flowX: paneMenu.flowX, flowY: paneMenu.flowY })
              setPaneMenu(null)
            }}
          />
        </Menu>
      )}

      {addNodeModal && (
        <AddNodeModal
          onClose={() => setAddNodeModal(null)}
          onConfirm={(action: Action) => {
            addNodeAt(action, { x: addNodeModal.flowX, y: addNodeModal.flowY })
            selectNode(action.id)
            setAddNodeModal(null)
          }}
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
        onPaneContextMenu={onPaneContextMenu}
        onSelectionChange={onSelectionChange}
        onConnect={onConnect}
        onNodesDelete={() => { /* no-op: node deletion only via context menu */ }}
        onEdgesDelete={(edgesToDelete) => {
          // One gesture = one Ctrl+Z, however many edges were selected. disconnectNodes
          // persists itself on each call; the last one wins.
          runAsOneHistoryStep(() => {
            edgesToDelete.forEach((e) => disconnectNodes(e.source, e.target))
          })
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
