import React, { useState } from 'react'
import { useFlowStore } from '../../stores/flowStore'
import type { FlowProfile } from '@shared/types'

interface ProfileEditorModalProps {
  onClose: () => void
}

export function ProfileEditorModal({ onClose }: ProfileEditorModalProps) {
  const {
    currentFlow,
    activeProfileId,
    setActiveProfile,
    addProfile,
    updateProfile,
    deleteProfile,
    addVarToAllProfiles,
    updateVarKeyInAllProfiles,
    deleteVarFromAllProfiles,
  } = useFlowStore()

  const profiles = currentFlow?.profiles ?? []
  const [selectedProfileId, setSelectedProfileId] = useState<string>(
    () => activeProfileId ?? profiles[0]?.id ?? '',
  )
  const [newProfileName, setNewProfileName] = useState('')
  const [addingProfile, setAddingProfile] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameInput, setRenameInput] = useState('')

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId) ?? profiles[0] ?? null

  // ── Profile list actions ──────────────────────────────────

  const handleAddProfile = async () => {
    const name = newProfileName.trim()
    if (!name) return
    await addProfile(name)
    const updated = useFlowStore.getState().currentFlow?.profiles ?? []
    const last = updated[updated.length - 1]
    if (last) setSelectedProfileId(last.id)
    setNewProfileName('')
    setAddingProfile(false)
  }

  const handleRenameCommit = async (id: string) => {
    const name = renameInput.trim()
    if (name) await updateProfile(id, { name })
    setRenamingId(null)
    setRenameInput('')
  }

  const handleDeleteProfile = async (id: string) => {
    if (profiles.length <= 1) return
    const nextProfile = profiles.find((p) => p.id !== id)
    await deleteProfile(id)
    if (selectedProfileId === id && nextProfile) {
      setSelectedProfileId(nextProfile.id)
    }
  }

  // ── Variable actions ──────────────────────────────────────

  /** Update value or description on the selected profile only */
  const handleVarField = (index: number, field: 'value' | 'description', raw: string) => {
    if (!selectedProfile) return
    const newVars = selectedProfile.vars.map((v, i) =>
      i === index ? { ...v, [field]: raw } : v,
    )
    updateProfile(selectedProfile.id, { vars: newVars })
  }

  // ── Render ────────────────────────────────────────────────

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
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          background: '#1e293b',
          border: '1px solid #334155',
          borderRadius: 12,
          width: 780,
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
          <span style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0' }}>環境配置管理</span>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: '#64748b', fontSize: 18, cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>

        {/* Body: two columns */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Left: profile list */}
          <div
            style={{
              width: 200,
              borderRight: '1px solid #334155',
              display: 'flex',
              flexDirection: 'column',
              flexShrink: 0,
            }}
          >
            <div
              style={{
                padding: '8px 12px',
                fontSize: 11,
                color: '#64748b',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                borderBottom: '1px solid #334155',
              }}
            >
              配置列表
            </div>

            <div style={{ overflowY: 'auto', flex: 1 }}>
              {profiles.map((p) => {
                const isSelected = p.id === selectedProfileId
                const isRenaming = renamingId === p.id
                return (
                  <div
                    key={p.id}
                    onClick={() => { if (!isRenaming) setSelectedProfileId(p.id) }}
                    style={{
                      padding: '8px 12px',
                      background: isSelected ? '#1e3a5f' : 'transparent',
                      color: isSelected ? '#93c5fd' : '#cbd5e1',
                      cursor: 'pointer',
                      borderBottom: '1px solid #0f172a',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                    onMouseEnter={(e) => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = '#0f172a' }}
                    onMouseLeave={(e) => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
                  >
                    {isRenaming ? (
                      <input
                        autoFocus
                        value={renameInput}
                        onChange={(e) => setRenameInput(e.target.value)}
                        onBlur={() => handleRenameCommit(p.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRenameCommit(p.id)
                          if (e.key === 'Escape') { setRenamingId(null); setRenameInput('') }
                        }}
                        onClick={(e) => e.stopPropagation()}
                        style={inlineInputStyle}
                      />
                    ) : (
                      <>
                        <span
                          style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}
                          onDoubleClick={(e) => {
                            e.stopPropagation()
                            setRenamingId(p.id)
                            setRenameInput(p.name)
                          }}
                          title="按兩下重新命名"
                        >
                          {p.name}
                        </span>
                        {p.id === activeProfileId && (
                          <span style={{ fontSize: 9, color: '#4ade80', flexShrink: 0 }}>使用中</span>
                        )}
                        {profiles.length > 1 && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteProfile(p.id) }}
                            title="刪除此配置"
                            style={{
                              flexShrink: 0,
                              background: 'transparent',
                              border: 'none',
                              cursor: 'pointer',
                              color: '#f87171',
                              fontSize: 13,
                              padding: '1px 3px',
                              borderRadius: 3,
                              opacity: 0.7,
                              lineHeight: 1,
                            }}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '1' }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.7' }}
                          >
                            ✕
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Add profile */}
            <div style={{ padding: 10, borderTop: '1px solid #334155', flexShrink: 0 }}>
              {addingProfile ? (
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    autoFocus
                    value={newProfileName}
                    onChange={(e) => setNewProfileName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAddProfile()
                      if (e.key === 'Escape') { setAddingProfile(false); setNewProfileName('') }
                    }}
                    placeholder="配置名稱"
                    style={{ ...inlineInputStyle, flex: 1 }}
                  />
                  <button
                    onClick={handleAddProfile}
                    style={{ padding: '4px 8px', borderRadius: 4, border: 'none', background: '#3b82f6', color: '#fff', fontSize: 12, cursor: 'pointer' }}
                  >
                    新增
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setAddingProfile(true)}
                  style={{
                    width: '100%',
                    padding: '5px 0',
                    borderRadius: 4,
                    border: '1px dashed #334155',
                    background: 'transparent',
                    color: '#3b82f6',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  ＋ 新增配置
                </button>
              )}
            </div>
          </div>

          {/* Right: variable editor */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {selectedProfile ? (
              <>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 16px',
                    borderBottom: '1px solid #334155',
                    flexShrink: 0,
                  }}
                >
                  <div>
                    <span style={{ fontSize: 13, color: '#e2e8f0', fontWeight: 600 }}>
                      {selectedProfile.name}
                    </span>
                    <span style={{ fontSize: 11, color: '#64748b', marginLeft: 8 }}>
                      的變數（可用 {'{{key}}'} 引用）
                    </span>
                  </div>
                  <button
                    onClick={() => {
                      setActiveProfile(selectedProfile.id)
                      onClose()
                    }}
                    style={{
                      padding: '4px 12px',
                      borderRadius: 4,
                      border: 'none',
                      background: activeProfileId === selectedProfile.id ? '#374151' : '#3b82f6',
                      color: activeProfileId === selectedProfile.id ? '#6b7280' : '#fff',
                      fontSize: 12,
                      cursor: activeProfileId === selectedProfile.id ? 'default' : 'pointer',
                    }}
                  >
                    {activeProfileId === selectedProfile.id ? '目前使用中' : '切換為此配置'}
                  </button>
                </div>

                <div style={{ overflowY: 'auto', flex: 1, padding: '8px 0' }}>
                  {/* Column headers */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr 1fr 32px',
                      gap: 8,
                      padding: '4px 16px 8px',
                      borderBottom: '1px solid #0f172a',
                    }}
                  >
                    <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>參數名稱</span>
                    <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>值</span>
                    <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>敘述（選填）</span>
                    <span />
                  </div>

                  {selectedProfile.vars.map((v, i) => (
                    <div
                      key={i}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr 1fr 32px',
                        gap: 8,
                        padding: '5px 16px',
                        alignItems: 'center',
                      }}
                    >
                      <input
                        value={v.key}
                        onChange={(e) => updateVarKeyInAllProfiles(i, e.target.value)}
                        placeholder="key"
                        style={cellInputStyle}
                        title="修改參數名稱將同步至所有配置"
                      />
                      <input
                        value={v.value}
                        onChange={(e) => handleVarField(i, 'value', e.target.value)}
                        placeholder="value"
                        style={cellInputStyle}
                      />
                      <input
                        value={v.description ?? ''}
                        onChange={(e) => handleVarField(i, 'description', e.target.value)}
                        placeholder="說明此參數用途…"
                        style={{ ...cellInputStyle, color: '#94a3b8' }}
                      />
                      <button
                        onClick={() => deleteVarFromAllProfiles(i)}
                        title="從所有配置刪除此變數"
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

                  {selectedProfile.vars.length === 0 && (
                    <div style={{ padding: '16px', color: '#64748b', fontSize: 12 }}>
                      尚無變數。點擊下方「新增變數」。
                    </div>
                  )}
                </div>

                <div style={{ padding: 12, borderTop: '1px solid #334155', flexShrink: 0 }}>
                  <button
                    onClick={() => addVarToAllProfiles()}
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
                    ＋ 新增變數（所有配置同步）
                  </button>
                </div>
              </>
            ) : (
              <div style={{ padding: 24, color: '#64748b', fontSize: 13 }}>
                請從左側選擇或建立一個配置。
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid #334155',
            display: 'flex',
            justifyContent: 'flex-end',
            flexShrink: 0,
          }}
        >
          <button onClick={onClose} style={closeBtnStyle}>
            關閉
          </button>
        </div>
      </div>
    </div>
  )
}

const inlineInputStyle: React.CSSProperties = {
  padding: '3px 7px',
  background: '#0f172a',
  border: '1px solid #3b82f6',
  borderRadius: 4,
  color: '#e2e8f0',
  fontSize: 12,
  outline: 'none',
  width: '100%',
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
