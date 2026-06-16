import React, { memo } from 'react'
import { Handle, Position, NodeProps } from 'reactflow'
import type { FlowNode } from '../../../../shared/types'
import { useFlowStore } from '../../stores/flowStore'

const TYPE_COLORS: Record<string, string> = {
  goto: '#3b82f6',
  click: '#6b7280',
  fill: '#8b5cf6',
  selectOption: '#8b5cf6',
  check: '#10b981',
  uncheck: '#f59e0b',
  press: '#ec4899',
  wait: '#f97316',
  upload: '#06b6d4',
  assertVisible: '#22c55e',
  assertText: '#22c55e',
  assertValue: '#22c55e',
}

const TYPE_ICONS: Record<string, string> = {
  goto: '🌐',
  click: '👆',
  fill: '✏️',
  selectOption: '📋',
  check: '✅',
  uncheck: '☐',
  press: '⌨️',
  wait: '⏳',
  upload: '📁',
  assertVisible: '👁',
  assertText: '📝',
  assertValue: '🔢',
}

export interface ActionNodeData {
  flowNode: FlowNode
}

function ActionNodeComponent({ data, selected }: NodeProps<ActionNodeData>) {
  const { flowNode } = data
  const { action } = flowNode
  const { replayStatus, replayingNodeId } = useFlowStore()

  const nodeStatus = replayStatus[flowNode.id]
  const isReplaying = replayingNodeId === flowNode.id

  let borderColor = TYPE_COLORS[action.type] ?? '#6b7280'
  if (selected) borderColor = '#60a5fa'
  if (nodeStatus === 'success') borderColor = '#22c55e'
  if (nodeStatus === 'error') borderColor = '#ef4444'

  const borderWidth = action.isPageNavigation ? 3 : 1.5
  const animation = isReplaying ? 'pulse 0.8s infinite' : 'none'

  return (
    <div
      style={{
        background: '#1e1e3a',
        border: `${borderWidth}px solid ${borderColor}`,
        borderRadius: 8,
        padding: '8px 12px',
        minWidth: 180,
        maxWidth: 220,
        cursor: 'pointer',
        boxShadow: selected ? `0 0 0 2px ${borderColor}40` : 'none',
        animation,
        position: 'relative',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: '#555', pointerEvents: 'none', width: 8, height: 8 }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 16 }}>{TYPE_ICONS[action.type] ?? '⚡'}</span>
        <span
          style={{
            fontSize: 11,
            color: borderColor,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          {action.type}
        </span>
        {action.assertion && (
          <span
            title="Has assertion"
            style={{
              position: 'absolute',
              top: 4,
              right: 6,
              fontSize: 10,
              color: '#22c55e',
            }}
          >
            ✓
          </span>
        )}
      </div>

      <div
        style={{
          fontSize: 12,
          color: '#cbd5e1',
          marginTop: 4,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={action.description}
      >
        {action.description}
      </div>

      {action.selector && (
        <div
          style={{
            fontSize: 10,
            color: '#64748b',
            marginTop: 2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={action.selector}
        >
          {action.selector}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} style={{ background: '#555', pointerEvents: 'none', width: 8, height: 8 }} />
    </div>
  )
}

export const ActionNode = memo(ActionNodeComponent)
