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
import { SelectionToolbar } from './SelectionToolbar'
import { ExtractSubflowModal } from './ExtractSubflowModal'
import type { ActionNodeData } from './ActionNode'
import { usePlaywright } from '../../hooks/usePlaywright'
import { CallFlowModal } from '../CallFlowModal/CallFlowModal'
import type { Action } from '@shared/types'
import { computeTreeLayout } from '../../utils/treeLayout'
import { validateExtraction, extractSubflow } from '../../utils/subflowExtraction'

const nodeTypes = { actionNode: ActionNode }
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
    updateNode,
    insertCallFlowBefore,
    appendCallFlowAfter,
    materializeLayout,
    connectNodes,
    disconnectNodes,
  } = useFlowStore()
  const { replayToNode, startBranchRecording } = usePlaywright()
  const [contextMenu, setContextMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null)
  const [callFlowModal, setCallFlowModal] = useState<{ mode: 'insertBefore' | 'appendAfter'; targetNodeId: string } | null>(null)

  // Multi-select state (local — PropertyPanel/context menu still use Zustand selectedNodeId)
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set())
  const [extractModal, setExtractModal] = useState(false)
  const [extractionInfo, setExtractionInfo] = useState<{ entryNodeId: string; exitNodeId: string } | null>(null)

  // Debounced disk save ref
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Latest position per node seen during an in-progress drag (drag-stop events omit position)
  const dragPosRef = useRef<Map<string, { x: number; y: number }>>(new Map())

  // fn.position is the single source of truth for rendering. When a freshly-loaded flow
  // has not had its layout finalized yet, materializeLayout (below) writes the tree-layout
  // positions into the store first, so this never needs to compute layout at render time.
  const rfNodes = useMemo(() => {
    if (!currentFlow) return []
    return currentFlow.nodes.map((fn) => ({
      id: fn.id,
      type: 'actionNode',
      position: fn.position,
      data: { flowNode: fn },
      selected: selectedNodeIds.size <= 1 ? fn.id === selectedNodeId : selectedNodeIds.has(fn.id),
    }))
  }, [currentFlow, selectedNodeId, selectedNodeIds])

  const rfEdges: Edge[] = useMemo(() => {
    if (!currentFlow) return []
    const edges: Edge[] = []
    for (const node of currentFlow.nodes) {
      for (const childId of node.childIds) {
        const child = currentFlow.nodes.find((n) => n.id === childId)
        edges.push({
          id: `${node.id}->${childId}`,
          source: node.id,
          target: childId,
          type: 'branchEdge',
          data: { label: child?.branchLabel },
        })
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
            updateNode(c.id, { position: pos })
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
    setSelectedNodeIds(new Set(selNodes.map((n) => n.id)))
  }, [])

  const onPaneClick = useCallback(() => {
    selectNode(null)
    setContextMenu(null)
    setSelectedNodeIds(new Set())
  }, [selectNode])

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault()
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
            isRoot={contextNode?.parentId === null}
            isLeaf={(contextNode?.childIds.length ?? 0) === 0}
            onInsertCallFlowBefore={() => setCallFlowModal({ mode: 'insertBefore', targetNodeId: contextMenu.nodeId })}
            onAppendCallFlowAfter={() => setCallFlowModal({ mode: 'appendAfter', targetNodeId: contextMenu.nodeId })}
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

      {/* Multi-select toolbar */}
      {selectedNodeIds.size >= 2 && !isRecording && !isReplaying && (
        <SelectionToolbar
          selectedCount={selectedNodeIds.size}
          onExtract={handleExtractClick}
          onClear={() => setSelectedNodeIds(new Set())}
        />
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
        deleteKeyCode="Backspace"
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
