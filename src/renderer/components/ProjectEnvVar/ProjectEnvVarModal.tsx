import React, { useState } from 'react'
import { useFlowStore } from '../../stores/flowStore'

interface ProjectEnvVarModalProps {
  onClose: () => void
}

/**
 * Editor for project-level environment variables. One key per row with a single
 * value column for the currently selected environment (switched via the dropdown,
 * mirroring ProfileEditorModal's 環境值 selector). Flow profile variable values
 * can reference these via {{key}}.
 */
export function ProjectEnvVarModal({ onClose }: ProjectEnvVarModalProps) {
  const {
    currentProject,
    activeEnvironmentId,
    setActiveEnvironment,
    addProjectEnvVar,
    renameProjectEnvVarKey,
    deleteProjectEnvVar,
    setProjectEnvVarValue,
  } = useFlowStore()

  const environments = currentProject?.environments ?? []
  const envVars = currentProject?.envVars ?? []

  // Display fallback only — the global activeEnvironmentId is untouched until
  // the user picks from the dropdown.
  const selectedEnv =
    environments.find((e) => e.id === activeEnvironmentId) ?? environments[0] ?? null

  const [newKey, setNewKey] = useState('')
  const [adding, setAdding] = useState(false)

  const handleAdd = async () => {
    const key = newKey.trim()
    if (!key) return
    await addProjectEnvVar(key)
    setNewKey('')
    setAdding(false)
  }

  const gridCols = '1fr 1fr 32px'

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
      }}
    >
      <div
        style={{
          background: '#1e293b',
          border: '1px solid #334155',
          borderRadius: 12,
          width: 640,
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 20px',
            borderBottom: '1px solid #334155',
            flexShrink: 0,
          }}
        >
          <div>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0' }}>專案環境變數</span>
            <span style={{ fontSize: 12, color: '#64748b', marginLeft: 10 }}>
              {currentProject?.name ?? ''}（配置可用 {'{{key}}'} 引用）
            </span>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: '#64748b', fontSize: 18, cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>

        {/* Env switcher */}
        {environments.length > 0 && (
          <div
            style={{
              padding: '6px 16px',
              borderBottom: '1px solid #334155',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 11, color: '#64748b', whiteSpace: 'nowrap' }}>環境:</span>
            <select
              value={selectedEnv?.id ?? ''}
              onChange={(e) => setActiveEnvironment(e.target.value || null)}
              style={{
                background: '#0f172a',
                border: '1px solid #334155',
                borderRadius: 4,
                color: '#e2e8f0',
                fontSize: 12,
                padding: '2px 6px',
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              {environments.map((env) => (
                <option key={env.id} value={env.id}>{env.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Body */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '8px 0' }}>
          {environments.length === 0 ? (
            <div style={{ padding: 24, color: '#f59e0b', fontSize: 13 }}>
              此專案尚無環境。請先在工具列的 🌐 環境選單新增環境（如 DEV / UAT / PRD），才能填寫各環境的值。
            </div>
          ) : (
            <>
              {/* Column headers */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: gridCols,
                  gap: 8,
                  padding: '4px 16px 8px',
                  borderBottom: '1px solid #0f172a',
                }}
              >
                <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>變數名稱</span>
                <span style={{ fontSize: 11, color: '#4ade80', fontWeight: 600 }}>
                  值{selectedEnv ? ` (${selectedEnv.name})` : ''}
                </span>
                <span />
              </div>

              {envVars.map((v) => (
                <div
                  key={v.key}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: gridCols,
                    gap: 8,
                    padding: '5px 16px',
                    alignItems: 'center',
                  }}
                >
                  <input
                    defaultValue={v.key}
                    onBlur={(e) => {
                      const next = e.target.value.trim()
                      if (next && next !== v.key) renameProjectEnvVarKey(v.key, next)
                      else e.target.value = v.key
                    }}
                    placeholder="key"
                    style={cellInputStyle}
                    title="變數名稱（配置以 {{key}} 引用）"
                  />
                  <input
                    value={(selectedEnv && v.values[selectedEnv.id]) ?? ''}
                    onChange={(e) => {
                      if (selectedEnv) setProjectEnvVarValue(v.key, selectedEnv.id, e.target.value)
                    }}
                    placeholder="(空)"
                    style={{ ...cellInputStyle, borderColor: '#166534' }}
                  />
                  <button
                    onClick={() => deleteProjectEnvVar(v.key)}
                    title="刪除此變數"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      color: '#f87171',
                      fontSize: 16,
                      padding: '2px',
                      borderRadius: 3,
                      lineHeight: 1,
                      opacity: 0.7,
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '1' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.7' }}
                  >
                    🗑
                  </button>
                </div>
              ))}

              {envVars.length === 0 && (
                <div style={{ padding: '16px', color: '#64748b', fontSize: 12 }}>
                  尚無環境變數。點擊下方「新增變數」。
                </div>
              )}
            </>
          )}
        </div>

        {/* Add + footer */}
        <div style={{ padding: 12, borderTop: '1px solid #334155', flexShrink: 0, display: 'flex', gap: 8, alignItems: 'center' }}>
          {environments.length > 0 && (
            adding ? (
              <div style={{ display: 'flex', gap: 6, flex: 1 }}>
                <input
                  autoFocus
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAdd()
                    if (e.key === 'Escape') { setAdding(false); setNewKey('') }
                  }}
                  placeholder="變數名稱，例如 leave_user_name"
                  style={{ ...cellInputStyle, flex: 1, border: '1px solid #3b82f6' }}
                />
                <button
                  onClick={handleAdd}
                  style={{ padding: '4px 12px', borderRadius: 4, border: 'none', background: '#3b82f6', color: '#fff', fontSize: 12, cursor: 'pointer' }}
                >
                  新增
                </button>
              </div>
            ) : (
              <button
                onClick={() => setAdding(true)}
                style={{
                  padding: '6px 14px',
                  borderRadius: 4,
                  border: '1px dashed #334155',
                  background: 'transparent',
                  color: '#3b82f6',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                ＋ 新增變數
              </button>
            )
          )}
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={closeBtnStyle}>關閉</button>
        </div>
      </div>
    </div>
  )
}

const cellInputStyle: React.CSSProperties = {
  padding: '4px 8px',
  background: '#0f172a',
  border: '1px solid #1e293b',
  borderRadius: 4,
  color: '#e2e8f0',
  fontSize: 12,
  outline: 'none',
  width: '100%',
  transition: 'border-color 0.15s',
}

const closeBtnStyle: React.CSSProperties = {
  padding: '7px 20px',
  borderRadius: 6,
  border: '1px solid #475569',
  background: 'transparent',
  color: '#94a3b8',
  cursor: 'pointer',
  fontSize: 13,
}
