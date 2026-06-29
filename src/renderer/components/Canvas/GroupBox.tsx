import React, { memo } from 'react'
import { NodeProps } from 'reactflow'
import { GROUP_BOX_HEADER } from '../../utils/groups'

export interface GroupBoxData {
  groupId: string
  name: string
  width: number
  height: number
  onToggle: (groupId: string) => void
  onUngroup: (groupId: string) => void
}

const ACCENT = '#818cf8'

/** Expanded in-place group: a non-interactive frame drawn behind its member nodes,
 *  with a header carrying the group name plus collapse / ungroup controls. */
function GroupBoxComponent({ data }: NodeProps<GroupBoxData>) {
  return (
    <div
      style={{
        width: data.width,
        height: data.height,
        background: 'rgba(129, 140, 248, 0.06)',
        border: `1.5px dashed ${ACCENT}`,
        borderRadius: 12,
        position: 'relative',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: GROUP_BOX_HEADER,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 10px',
          background: 'rgba(49, 46, 129, 0.55)',
          borderTopLeftRadius: 11,
          borderTopRightRadius: 11,
          pointerEvents: 'all',
        }}
      >
        <span style={{ fontSize: 12 }}>⊟</span>
        <span
          style={{
            fontSize: 11,
            color: '#c7d2fe',
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            minWidth: 0,
          }}
          title={data.name}
        >
          {data.name}
        </span>
        <span
          role="button"
          title="收合群組"
          onClick={() => data.onToggle(data.groupId)}
          style={{ fontSize: 10, color: ACCENT, cursor: 'pointer', fontWeight: 600 }}
        >
          收合
        </span>
        <span
          role="button"
          title="解散群組"
          onClick={() => data.onUngroup(data.groupId)}
          style={{ fontSize: 11, color: '#64748b', cursor: 'pointer' }}
        >
          ✕
        </span>
      </div>
    </div>
  )
}

export const GroupBox = memo(GroupBoxComponent)
