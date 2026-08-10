import React, { useState } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import type { ProjectEnvironment } from '@shared/types'
import { confirm } from '../../stores/confirmStore'
import { cellInputStyle } from '../common/varTable'
import { token } from '../../styles/tokens'

/**
 * The pinned strip above the project env-var table: pick an environment, and
 * add / rename / duplicate / delete one. Three mutually exclusive modes —
 * adding, renaming, and the default row of controls.
 *
 * The inline add/rename buffers are local to this strip, so they live here rather
 * than in the modal. `selectedEnv` is NOT: the table needs the same value for its
 * reload key, its column header and its commit, so the modal owns it.
 */
export function EnvironmentToolbar({ selectedEnv }: { selectedEnv: ProjectEnvironment | null }) {
  const {
    currentProject,
    setActiveEnvironment,
    addEnvironmentToProject,
    renameEnvironment,
    duplicateEnvironment,
    deleteEnvironment,
  } = useProjectStore()

  const environments = currentProject?.environments ?? []

  const [renamingEnv, setRenamingEnv] = useState(false)
  const [envRenameValue, setEnvRenameValue] = useState('')
  const [addingEnv, setAddingEnv] = useState(false)
  const [newEnvName, setNewEnvName] = useState('')

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
    const ok = await confirm({
      title: `刪除環境「${selectedEnv.name}」？`,
      detail: '此環境在所有環境變數上的值將一併移除。',
      confirmLabel: '刪除',
      danger: true,
    })
    if (!ok) return
    await deleteEnvironment(selectedEnv.id)
  }

  if (environments.length === 0) return null

  return (
    <div
      style={{
        padding: '6px 16px',
        borderBottom: `1px solid ${token.border}`,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: 11, color: token.textMuted, whiteSpace: 'nowrap' }}>環境:</span>
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
            style={{ ...cellInputStyle, width: 200, border: `1px solid ${token.accent}` }}
          />
          <button onClick={commitAddEnv} title="確認" style={{ ...envBtnStyle, borderColor: token.accent, color: token.accentFg }}>✓</button>
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
            style={{ ...cellInputStyle, width: 160, border: `1px solid ${token.accent}` }}
          />
          <button onClick={commitRenameEnv} title="確認" style={{ ...envBtnStyle, borderColor: token.accent, color: token.accentFg }}>✓</button>
          <button onClick={() => setRenamingEnv(false)} title="取消" style={envBtnStyle}>✕</button>
        </>
      ) : (
        <>
          <select
            value={selectedEnv?.id ?? ''}
            // The value column is per-environment — switching reloads the table.
            onChange={(e) => setActiveEnvironment(e.target.value || null)}
            style={{
              background: token.bgPage,
              border: `1px solid ${token.border}`,
              borderRadius: 4,
              color: token.text,
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
              color: environments.length <= 1 ? token.borderStrong : token.dangerFg,
              borderColor: environments.length <= 1 ? token.border : token.dangerDark,
              cursor: environments.length <= 1 ? 'not-allowed' : 'pointer',
            }}
          >
            🗑 刪除
          </button>
          <button
            onClick={() => { setNewEnvName(''); setAddingEnv(true) }}
            title="新增環境"
            style={{ ...envBtnStyle, borderColor: token.accent, color: token.accentFg }}
          >
            ＋ 新增
          </button>
        </>
      )}
    </div>
  )
}

const envBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: `1px solid ${token.border}`,
  borderRadius: 4,
  color: token.textBody,
  fontSize: 12,
  padding: '2px 8px',
  cursor: 'pointer',
  lineHeight: 1.4,
}
