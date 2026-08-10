import React, { useState } from 'react'
import { useFlowStore } from '../../stores/flowStore'
import type { FlowProfile } from '@shared/types'
import { confirm } from '../../stores/confirmStore'
import { token } from '../../styles/tokens'

/**
 * The left column of ProfileEditorModal: the profile list, plus add / rename /
 * duplicate / delete.
 *
 * The inline add and rename buffers are local to this column, so they live here.
 * `selectedProfileId` is NOT: the variable table on the right is keyed on it, so
 * the modal owns it and hands it down with `onSelect`.
 */
export function ProfileList({
  profiles,
  activeProfileId,
  selectedProfileId,
  onSelect,
}: {
  profiles: FlowProfile[]
  activeProfileId: string | null
  selectedProfileId: string
  onSelect: (id: string) => void
}) {
  const { addProfile, updateProfile, deleteProfile, duplicateProfile } = useFlowStore()

  const [newProfileName, setNewProfileName] = useState('')
  const [addingProfile, setAddingProfile] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameInput, setRenameInput] = useState('')

  const handleAddProfile = async () => {
    const name = newProfileName.trim()
    if (!name) return
    await addProfile(name)
    const updated = useFlowStore.getState().currentFlow?.profiles ?? []
    const last = updated[updated.length - 1]
    if (last) onSelect(last.id)
    setNewProfileName('')
    setAddingProfile(false)
  }

  /** Explicit commit only (✓ / Enter). Blur must NOT commit — that was the app's last
   *  onBlur-write and it made "click elsewhere" an unpredictable save. */
  const handleRenameCommit = async (id: string) => {
    const name = renameInput.trim()
    if (name) await updateProfile(id, { name })
    setRenamingId(null)
    setRenameInput('')
  }

  const cancelRename = () => {
    setRenamingId(null)
    setRenameInput('')
  }

  const handleDuplicateProfile = async (id: string) => {
    await duplicateProfile(id)
    const updated = useFlowStore.getState().currentFlow?.profiles ?? []
    const last = updated[updated.length - 1]
    if (last) onSelect(last.id)
  }

  const handleDeleteProfile = async (id: string) => {
    const name = profiles.find((p) => p.id === id)?.name ?? ''
    const ok = await confirm({
      title: `刪除配置「${name}」？`,
      detail: '此配置的所有變數值將一併移除。',
      confirmLabel: '刪除',
      danger: true,
    })
    if (!ok) return
    const nextProfile = profiles.find((p) => p.id !== id)
    await deleteProfile(id)
    if (selectedProfileId === id && nextProfile) onSelect(nextProfile.id)
  }

  return (
    <div
      style={{
        width: 200,
        borderRight: `1px solid ${token.border}`,
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          padding: '8px 12px',
          fontSize: 11,
          color: token.textMuted,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          borderBottom: `1px solid ${token.border}`,
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
              onClick={() => { if (!isRenaming) onSelect(p.id) }}
              style={{
                padding: '8px 12px',
                background: isSelected ? token.bgSelected : 'transparent',
                color: isSelected ? token.accentFg : token.textBody,
                cursor: 'pointer',
                borderBottom: `1px solid ${token.bgPage}`,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
              onMouseEnter={(e) => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = token.bgPage }}
              onMouseLeave={(e) => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
            >
              {isRenaming ? (
                <>
                  <input
                    autoFocus
                    value={renameInput}
                    onChange={(e) => setRenameInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRenameCommit(p.id)
                      if (e.key === 'Escape') cancelRename()
                    }}
                    onClick={(e) => e.stopPropagation()}
                    style={inlineInputStyle}
                  />
                  <button
                    onClick={(e) => { e.stopPropagation(); handleRenameCommit(p.id) }}
                    title="確認"
                    style={renameActionBtnStyle(token.successFg)}
                  >
                    ✓
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); cancelRename() }}
                    title="取消"
                    style={renameActionBtnStyle(token.textSecondary)}
                  >
                    ✕
                  </button>
                </>
              ) : (
                <>
                  <span
                    style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}
                  >
                    {p.name}
                  </span>
                  {p.id === activeProfileId && (
                    <span style={{ fontSize: 9, color: token.successFg, flexShrink: 0 }}>使用中</span>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); setRenamingId(p.id); setRenameInput(p.name) }}
                    title="重新命名"
                    style={rowActionBtnStyle(token.accentFg, 12, 0.5)}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '1' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.5' }}
                  >
                    ✏
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDuplicateProfile(p.id) }}
                    title="建立此配置的副本"
                    style={rowActionBtnStyle(token.accentFg, 12, 0.5)}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '1' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.5' }}
                  >
                    ⧉
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteProfile(p.id) }}
                    title="刪除此配置"
                    style={rowActionBtnStyle(token.dangerFg, 13, 0.7)}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '1' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.7' }}
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>

      {/* Add profile */}
      <div style={{ padding: 10, borderTop: `1px solid ${token.border}`, flexShrink: 0 }}>
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
              style={{ padding: '4px 8px', borderRadius: 4, border: 'none', background: token.accent, color: token.textOnAccent, fontSize: 12, cursor: 'pointer' }}
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
              border: `1px dashed ${token.border}`,
              background: 'transparent',
              color: token.accent,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            ＋ 新增配置
          </button>
        )}
      </div>
    </div>
  )
}

const inlineInputStyle: React.CSSProperties = {
  padding: '3px 7px',
  background: token.bgPage,
  border: `1px solid ${token.accent}`,
  borderRadius: 4,
  color: token.text,
  fontSize: 12,
  outline: 'none',
  width: '100%',
}

/** ✓ / ✕ buttons beside the inline rename input (rename commits explicitly, never on blur). */
const renameActionBtnStyle = (color: string): React.CSSProperties => ({
  flexShrink: 0,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  color,
  fontSize: 12,
  padding: '1px 3px',
  borderRadius: 3,
  lineHeight: 1,
})

/** ✏ / ⧉ / ✕ on a profile row — same shape, different colour, size and resting opacity. */
const rowActionBtnStyle = (color: string, fontSize: number, opacity: number): React.CSSProperties => ({
  flexShrink: 0,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  color,
  fontSize,
  padding: '1px 3px',
  borderRadius: 3,
  opacity,
  lineHeight: 1,
})
