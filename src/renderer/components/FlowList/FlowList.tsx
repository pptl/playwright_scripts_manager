import React, { useEffect } from 'react'
import { useFlowStore } from '../../stores/flowStore'
import { useFlowManager } from '../../hooks/useFlowStore'

export function FlowList() {
  const { flows, currentFlow } = useFlowStore()
  const { refreshFlowList, openFlow } = useFlowManager()

  useEffect(() => {
    refreshFlowList()
  }, [refreshFlowList])

  return (
    <div
      style={{
        width: 200,
        background: '#1e293b',
        borderRight: '1px solid #334155',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          padding: '12px 14px',
          borderBottom: '1px solid #334155',
          fontSize: 12,
          color: '#64748b',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        流程列表
        <button
          onClick={refreshFlowList}
          title="重新整理"
          style={{
            background: 'transparent',
            border: 'none',
            color: '#64748b',
            cursor: 'pointer',
            fontSize: 14,
          }}
        >
          ↺
        </button>
      </div>

      <div style={{ overflowY: 'auto', flex: 1 }}>
        {flows.length === 0 && (
          <div style={{ padding: '16px 14px', color: '#64748b', fontSize: 12 }}>
            尚無流程
          </div>
        )}
        {flows.map((flow) => (
          <div
            key={flow.id}
            onClick={() => openFlow(flow.id)}
            style={{
              padding: '10px 14px',
              cursor: 'pointer',
              background: currentFlow?.id === flow.id ? '#1e3a5f' : 'transparent',
              borderBottom: '1px solid #0f172a',
              borderLeft:
                currentFlow?.id === flow.id ? '3px solid #3b82f6' : '3px solid transparent',
            }}
          >
            <div
              style={{
                fontSize: 13,
                color: currentFlow?.id === flow.id ? '#93c5fd' : '#cbd5e1',
                fontWeight: 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {flow.name}
            </div>
            <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
              {new Date(flow.updatedAt).toLocaleDateString('zh-TW', {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
