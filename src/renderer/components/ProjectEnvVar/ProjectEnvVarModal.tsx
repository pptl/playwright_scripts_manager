import React, { useState } from 'react'
import { useFlowStore } from '../../stores/flowStore'
import { DOMAIN_ENV_KEY } from '@shared/types'

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
    addEnvironmentToProject,
    renameEnvironment,
    duplicateEnvironment,
    deleteEnvironment,
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
  const [renamingEnv, setRenamingEnv] = useState(false)
  const [envRenameValue, setEnvRenameValue] = useState('')
  const [addingEnv, setAddingEnv] = useState(false)
  const [newEnvName, setNewEnvName] = useState('')

  const handleAdd = async () => {
    const key = newKey.trim()
    if (!key) return
    await addProjectEnvVar(key)
    setNewKey('')
    setAdding(false)
  }

  const startRenameEnv = () => {
    if (!selectedEnv) return
    setEnvRenameValue(selectedEnv.name)
    setRenamingEnv(true)
  }

  const commitRenameEnv = async () => {
    const name = envRenameValue.trim()
    if (selectedEnv && name && name !== selectedEnv.name) await renameEnvironment(selectedEnv.id, name)
    setRenamingEnv(false)
  }

  const handleDuplicateEnv = async () => {
    if (selectedEnv) await duplicateEnvironment(selectedEnv.id)
  }

  const commitAddEnv = async () => {
    const name = newEnvName.trim()
    if (!name) return
    await addEnvironmentToProject(name)
    setNewEnvName('')
    setAddingEnv(false)
  }

  const handleDeleteEnv = async () => {
    if (!selectedEnv) return
    if (environments.length <= 1) return
    if (!window.confirm(`刪除環境「${selectedEnv.name}」？\n此環境在所有環境變數上的值將一併移除。`)) return
    await deleteEnvironment(selectedEnv.id)
  }

  const gridCols = '1fr 1fr 32px'
  const envBtnStyle: React.CSSProperties = {
    background: 'transparent',
    border: '1px solid #334155',
    borderRadius: 4,
    color: '#cbd5e1',
    fontSize: 12,
    padding: '2px 8px',
    cursor: 'pointer',
    lineHeight: 1.4,
  }

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
            {addingEnv ? (
              <>
                <input
                  autoFocus
                  value={newEnvName}
                  onChange={(e) => setNewEnvName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitAddEnv()
                    if (e.key === 'Escape') { setAddingEnv(false); setNewEnvName('') }
                  }}
                  placeholder="環境名稱，例如 DEV / UAT / PRD"
                  style={{ ...cellInputStyle, width: 200, border: '1px solid #3b82f6' }}
                />
                <button onClick={commitAddEnv} title="確認" style={{ ...envBtnStyle, borderColor: '#3b82f6', color: '#93c5fd' }}>✓</button>
                <button onClick={() => { setAddingEnv(false); setNewEnvName('') }} title="取消" style={envBtnStyle}>✕</button>
              </>
            ) : renamingEnv ? (
              <>
                <input
                  autoFocus
                  value={envRenameValue}
                  onChange={(e) => setEnvRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRenameEnv()
                    if (e.key === 'Escape') setRenamingEnv(false)
                  }}
                  style={{ ...cellInputStyle, width: 160, border: '1px solid #3b82f6' }}
                />
                <button onClick={commitRenameEnv} title="確認" style={{ ...envBtnStyle, borderColor: '#3b82f6', color: '#93c5fd' }}>✓</button>
                <button onClick={() => setRenamingEnv(false)} title="取消" style={envBtnStyle}>✕</button>
              </>
            ) : (
              <>
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
                <div style={{ flex: 1 }} />
                <button onClick={startRenameEnv} disabled={!selectedEnv} title="重新命名環境" style={envBtnStyle}>✎ 改名</button>
                <button onClick={handleDuplicateEnv} disabled={!selectedEnv} title="建立此環境的副本" style={envBtnStyle}>⧉ 副本</button>
                <button
                  onClick={handleDeleteEnv}
                  disabled={!selectedEnv || environments.length <= 1}
                  title={environments.length <= 1 ? '至少需保留一個環境' : '刪除此環境'}
                  style={{
                    ...envBtnStyle,
                    color: environments.length <= 1 ? '#475569' : '#f87171',
                    borderColor: environments.length <= 1 ? '#334155' : '#7f1d1d',
                    cursor: environments.length <= 1 ? 'not-allowed' : 'pointer',
                  }}
                >
                  🗑 刪除
                </button>
                <button
                  onClick={() => { setNewEnvName(''); setAddingEnv(true) }}
                  title="新增環境"
                  style={{ ...envBtnStyle, borderColor: '#3b82f6', color: '#93c5fd' }}
                >
                  ＋ 新增
                </button>
              </>
            )}
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

              {envVars.map((v) => {
                // `domain` is a reserved env var (drives goto-URL origin substitution) — its key
                // is locked and it cannot be deleted; only its per-environment value is editable.
                const isDomain = v.key === DOMAIN_ENV_KEY
                return (
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
                    readOnly={isDomain}
                    onBlur={isDomain ? undefined : (e) => {
                      const next = e.target.value.trim()
                      if (next && next !== v.key) renameProjectEnvVarKey(v.key, next)
                      else e.target.value = v.key
                    }}
                    placeholder="key"
                    style={isDomain ? { ...cellInputStyle, color: '#94a3b8', cursor: 'not-allowed' } : cellInputStyle}
                    title={isDomain ? 'domain 為保留變數，無法改名或刪除' : '變數名稱（配置以 {{key}} 引用）'}
                  />
                  <input
                    value={(selectedEnv && v.values[selectedEnv.id]) ?? ''}
                    onChange={(e) => {
                      if (selectedEnv) setProjectEnvVarValue(v.key, selectedEnv.id, e.target.value)
                    }}
                    placeholder="(空)"
                    style={{ ...cellInputStyle, borderColor: '#166534' }}
                  />
                  {isDomain ? (
                    <span title="domain 為保留變數，無法刪除" style={{ textAlign: 'center', color: '#475569', fontSize: 13 }}>🔒</span>
                  ) : (
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
                  )}
                </div>
                )
              })}

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
