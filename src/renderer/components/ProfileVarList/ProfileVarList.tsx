import React, { useState } from 'react'
import { useFlowStore } from '../../stores/flowStore'

export function ProfileVarList() {
  const { currentFlow, activeProfileId } = useFlowStore()
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const profiles = currentFlow?.profiles ?? []
  const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? profiles[0] ?? null

  const copyToClipboard = (placeholder: string, key: string) => {
    navigator.clipboard.writeText(placeholder).then(() => {
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(null), 1500)
    })
  }

  return (
    <div
      style={{
        background: '#1e293b',
        borderTop: '1px solid #334155',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        maxHeight: 220,
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
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
        }}
      >
        <span>環境變數</span>
        {activeProfile && (
          <span
            style={{
              fontSize: 11,
              padding: '2px 6px',
              borderRadius: 3,
              background: '#78350f',
              color: '#fcd34d',
              fontWeight: 600,
              textTransform: 'none',
              letterSpacing: 0,
            }}
          >
            {activeProfile.name}
          </span>
        )}
      </div>

      <div style={{ overflowY: 'auto', flex: 1 }}>
        {!activeProfile || activeProfile.vars.length === 0 ? (
          <div style={{ padding: '12px 14px', color: '#64748b', fontSize: 12 }}>
            {activeProfile ? '此配置尚無變數。' : '尚無環境配置。'}
          </div>
        ) : (
          activeProfile.vars.map((v) => {
            const placeholder = `{{${v.key}}}`
            return (
              <div
                key={v.key}
                onClick={() => copyToClipboard(placeholder, v.key)}
                title={`點擊複製 ${placeholder}`}
                style={{
                  padding: '7px 14px',
                  cursor: 'pointer',
                  borderBottom: '1px solid #0f172a',
                  userSelect: 'none',
                }}
                onMouseEnter={(e) => {
                  ;(e.currentTarget as HTMLDivElement).style.background = '#1c1408'
                }}
                onMouseLeave={(e) => {
                  ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <code
                    style={{
                      fontSize: 11,
                      background: '#0f172a',
                      color: '#fcd34d',
                      padding: '1px 5px',
                      borderRadius: 3,
                      border: '1px solid #78350f',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {placeholder}
                  </code>
                  {copiedKey === v.key && (
                    <span style={{ fontSize: 10, color: '#4ade80', flexShrink: 0 }}>已複製</span>
                  )}
                </div>
                {v.description && (
                  <div
                    style={{
                      fontSize: 10,
                      color: '#94a3b8',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      marginBottom: 1,
                    }}
                  >
                    {v.description}
                  </div>
                )}
                {v.value && (
                  <div
                    style={{
                      fontSize: 10,
                      color: '#78716c',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {v.value}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
