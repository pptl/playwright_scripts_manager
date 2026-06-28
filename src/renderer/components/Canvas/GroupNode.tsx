import React, { memo } from 'react'
import { Handle, Position, NodeProps } from 'reactflow'

export interface GroupNodeData {
  groupId: string
  name: string
  count: number
  onToggle: (groupId: string) => void
  onUngroup: (groupId: string) => void
}

const ACCENT = '#818cf8'

/** Collapsed in-place group: renders as a single node occupying the group's slot. */
function GroupNodeComponent({ data }: NodeProps<GroupNodeData>) {
  return (
    <div
      onClick={() => data.onToggle(data.groupId)}
      title="點擊展開群組"
      style={{
        background: '#1e1b4b',
        border: `2px solid ${ACCENT}`,
        borderRadius: 8,
        padding: '8px 12px',
        minWidth: 180,
        maxWidth: 220,
        cursor: 'pointer',
        position: 'relative',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: '#555', width: 8, height: 8 }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 15 }}>⊞</span>
        <span
          style={{
            fontSize: 11,
            color: ACCENT,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          群組
        </span>
        <span style={{ fontSize: 10, color: '#6366f1', marginLeft: 'auto' }}>{data.count} 個節點</span>
        <span
          role="button"
          title="解散群組"
          onClick={(e) => {
            e.stopPropagation()
            data.onUngroup(data.groupId)
          }}
          style={{ fontSize: 11, color: '#475569', cursor: 'pointer', padding: '0 2px' }}
        >
          ✕
        </span>
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
        title={data.name}
      >
        {data.name}
      </div>

      <Handle type="source" position={Position.Bottom} style={{ background: '#555', width: 8, height: 8 }} />
    </div>
  )
}

export const GroupNode = memo(GroupNodeComponent)
