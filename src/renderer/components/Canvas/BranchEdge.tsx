import React from 'react'
import {
  EdgeProps,
  getBezierPath,
  EdgeLabelRenderer,
  BaseEdge,
} from 'reactflow'

export interface BranchEdgeData {
  label?: string
}

export function BranchEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  selected,
}: EdgeProps<BranchEdgeData>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={{ stroke: selected ? '#60a5fa' : '#475569', strokeWidth: selected ? 2.5 : 2 }} />
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              background: '#1e1e3a',
              border: '1px solid #475569',
              borderRadius: 4,
              padding: '2px 6px',
              fontSize: 11,
              color: '#94a3b8',
              pointerEvents: 'all',
              whiteSpace: 'nowrap',
            }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
