import React, { useState } from 'react'
import { useFlowStore } from '../../stores/flowStore'

export function SessionVarList() {
  const { currentFlow, updateNode } = useFlowStore()
  const [copiedName, setCopiedName] = useState<string | null>(null)

  const sessionVars = (currentFlow?.nodes ?? [])
    .filter((n) => !!n.action.captureAs)
    .map((n) => ({
      nodeId: n.id,
      varName: n.action.captureAs!,
      placeholder: `{{${n.action.captureAs}}}`,
      description: n.action.description,
      value: n.action.value ?? '',
    }))

  const deleteVar = (nodeId: string) => {
    const node = currentFlow?.nodes.find((n) => n.id === nodeId)
    if (!node) return
    updateNode(nodeId, { action: { ...node.action, captureAs: undefined } })
    const updated = useFlowStore.getState().currentFlow
    if (updated) window.electronAPI.saveFlow(updated).catch(console.error)
  }

  const copyToClipboard = (placeholder: string, varName: string) => {
    navigator.clipboard.writeText(placeholder).then(() => {
      setCopiedName(varName)
      setTimeout(() => setCopiedName(null), 1500)
    })
  }

  return (
    <div
      style={{
        background: '#1e293b',
        borderTop: '1px solid #334155',
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        overflow: 'hidden',
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
          flexShrink: 0,
        }}
      >
        區域變數
      </div>

      <div style={{ overflowY: 'auto', flex: 1 }}>
        {sessionVars.length === 0 ? (
          <div style={{ padding: '16px 14px', color: '#64748b', fontSize: 12 }}>
            尚無區域變數。
            <br />
            <span style={{ color: '#334155', marginTop: 6, display: 'block' }}>
              右鍵節點 →「將值儲存為區域變數」
            </span>
          </div>
        ) : (
          sessionVars.map((v) => (
            <div
              key={v.varName}
              onClick={() => copyToClipboard(v.placeholder, v.varName)}
              title={`點擊複製 ${v.placeholder}`}
              style={{
                padding: '8px 14px',
                cursor: 'pointer',
                borderBottom: '1px solid #0f172a',
                userSelect: 'none',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = '#1e3a5f'
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = 'transparent'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                <code
                  style={{
                    fontSize: 11,
                    background: '#0f172a',
                    color: '#a78bfa',
                    padding: '1px 5px',
                    borderRadius: 3,
                    border: '1px solid #4c1d95',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {v.placeholder}
                </code>
                {copiedName === v.varName && (
                  <span style={{ fontSize: 10, color: '#4ade80', flexShrink: 0 }}>已複製</span>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteVar(v.nodeId)
                  }}
                  title="刪除變數"
                  style={{
                    flexShrink: 0,
                    marginLeft: 'auto',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    color: '#f87171',
                    padding: '2px 4px',
                    borderRadius: 3,
                    fontSize: 16,
                    lineHeight: 1,
                    opacity: 0.85,
                  }}
                  onMouseEnter={(e) => {
                    e.stopPropagation()
                    ;(e.currentTarget as HTMLButtonElement).style.opacity = '1'
                    ;(e.currentTarget as HTMLButtonElement).style.background = '#450a0a'
                  }}
                  onMouseLeave={(e) => {
                    e.stopPropagation()
                    ;(e.currentTarget as HTMLButtonElement).style.opacity = '0.7'
                    ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
                  }}
                >
                  🗑
                </button>
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: '#94a3b8',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {v.description}
              </div>
              {v.value && (
                <div
                  style={{
                    fontSize: 10,
                    color: '#64748b',
                    marginTop: 2,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  值：{v.value}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
