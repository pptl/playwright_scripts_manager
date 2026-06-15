import React, { useCallback, useMemo, useEffect, useState } from 'react'
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
} from 'reactflow'
import 'reactflow/dist/style.css'
import { useFlowStore } from '../../stores/flowStore'
import { ActionNode } from './ActionNode'
import { BranchEdge } from './BranchEdge'
import type { ActionNodeData } from './ActionNode'
import { usePlaywright } from '../../hooks/usePlaywright'
import type { FlowNode, NodePosition } from '@shared/types'

const nodeTypes = { actionNode: ActionNode }
const edgeTypes = { branchEdge: BranchEdge }

const NODE_WIDTH = 200
const NODE_HEIGHT = 70
const H_MARGIN = 25
const V_GAP = 30

function computeTreeLayout(nodes: FlowNode[], rootNodeId: string): Map<string, NodePosition> {
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

function FlowCanvasInner() {
  const { currentFlow, selectNode, selectedNodeId, isRecording, deleteNode } =
    useFlowStore()
  const { replayToNode } = usePlaywright()
  const [replaySpeed] = useState(500)

  // Convert FlowNodes to React Flow nodes and edges
  const rfNodes: Node<ActionNodeData>[] = useMemo(() => {
    if (!currentFlow) return []
    const layout = currentFlow.rootNodeId
      ? computeTreeLayout(currentFlow.nodes, currentFlow.rootNodeId)
      : new Map<string, NodePosition>()
    return currentFlow.nodes.map((fn) => ({
      id: fn.id,
      type: 'actionNode',
      position: layout.get(fn.id) ?? fn.position,
      data: { flowNode: fn },
      selected: fn.id === selectedNodeId,
    }))
  }, [currentFlow, selectedNodeId])

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

  // Sync Zustand store → ReactFlow internal state
  // (only recomputes when currentFlow nodes or selectedNodeId changes)
  useEffect(() => {
    setNodes(rfNodes)
  }, [rfNodes, setNodes])

  useEffect(() => {
    setEdges(rfEdges)
  }, [rfEdges, setEdges])

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => {
      selectNode(node.id)
    },
    [selectNode],
  )

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes)
    },
    [onNodesChange],
  )

  const onPaneClick = useCallback(() => {
    selectNode(null)
  }, [selectNode])

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault()
      const action = window.prompt(
        `節點: ${(node.data as ActionNodeData).flowNode.action.description}\n\n選擇動作:\n1 - 重播到此節點\n2 - 從此分支錄製\n3 - 刪除此節點\n\n輸入數字:`,
      )
      if (action === '1') {
        replayToNode(node.id, replaySpeed)
      } else if (action === '2') {
        const label = window.prompt('輸入分支名稱:') ?? ''
        // Start branch recording — handled by parent via store
        // For now, select node and user can use toolbar
        selectNode(node.id)
      } else if (action === '3') {
        if (window.confirm('確定要刪除此節點及其所有下游節點嗎?')) {
          deleteNode(node.id)
        }
      }
    },
    [replayToNode, replaySpeed, selectNode, deleteNode],
  )

  if (!currentFlow) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#475569',
          fontSize: 16,
        }}
      >
        選擇或建立一個流程以開始
      </div>
    )
  }

  return (
    <div style={{ flex: 1, position: 'relative' }}>
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

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        style={{ background: '#0f172a' }}
        deleteKeyCode={null}
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
