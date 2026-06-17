import React, { useState } from 'react'
import { BUILT_IN_VARIABLES } from '@shared/variableResolver'

export function VariableList() {
  const [copiedName, setCopiedName] = useState<string | null>(null)

  const copyToClipboard = (placeholder: string, name: string) => {
    navigator.clipboard.writeText(placeholder).then(() => {
      setCopiedName(name)
      setTimeout(() => setCopiedName(null), 1500)
    })
  }

  return (
    <div
      style={{
        background: '#1e293b',
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
        }}
      >
        全域變數
      </div>

      <div>
        {/* TODO: phase 2 — add/edit/delete variables */}
        {BUILT_IN_VARIABLES.map((v) => (
          <div
            key={v.name}
            onClick={() => copyToClipboard(v.placeholder, v.name)}
            title={`點擊複製 ${v.placeholder}`}
            style={{
              padding: '8px 14px',
              cursor: 'pointer',
              borderBottom: '1px solid #0f172a',
              userSelect: 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <code
                style={{
                  fontSize: 11,
                  background: '#0f172a',
                  color: '#7dd3fc',
                  padding: '1px 5px',
                  borderRadius: 3,
                  border: '1px solid #1e40af',
                }}
              >
                {v.placeholder}
              </code>
              {copiedName === v.name && (
                <span style={{ fontSize: 10, color: '#4ade80' }}>已複製</span>
              )}
            </div>
            <div style={{ fontSize: 10, color: '#64748b' }}>{v.description}</div>
            <div style={{ fontSize: 10, color: '#475569', marginTop: 1 }}>
              例：{v.example}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
