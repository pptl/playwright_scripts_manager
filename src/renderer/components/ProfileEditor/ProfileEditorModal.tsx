import React, { useEffect, useMemo, useRef, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useFlowStore } from '../../stores/flowStore'
import { DOMAIN_ENV_KEY, SECRET_ENVELOPE_PREFIX, SECRET_MASK } from '@shared/types'
import type { ProfileVariable } from '@shared/types'
import { confirm } from '../../stores/confirmStore'
import { useVault } from '../../hooks/useVault'

const isCiphertext = (v: string): boolean => v.startsWith(SECRET_ENVELOPE_PREFIX)

interface ProfileEditorModalProps {
  onClose: () => void
}

/** One row of the variable table. `fallback` is display-only (the base value behind an env override). */
interface VarRow {
  key: string
  value: string
  description: string
  fallback: string
  /** Private: the stored value is ciphertext and the UI masks it. Shared across profiles. */
  secret: boolean
}

/** A row as edited in the table. `_rid` is a stable client id (used for React keys and for the
 *  value-input caret map); `_origIndex` is the row's index in the store at load time —
 *  `commitProfileVars` reads it to tell added rows from edited ones.
 *  `_storedValue` is what is on disk (ciphertext for private rows); `value` only carries
 *  plaintext once the user types it. */
type EditRow = VarRow & {
  _rid: string
  _origIndex: number | null
  _storedValue: string
  _dirty: boolean
}

/** Store variables → table rows, resolved for the active environment. */
function toEditRows(vars: ProfileVariable[], envId: string | null): EditRow[] {
  return vars.map((v, i) => {
    const stored = envId ? (v.envValues?.[envId] ?? '') : v.value
    return {
      key: v.key,
      // A private row starts masked: its plaintext is never loaded into the renderer.
      value: v.secret ? '' : stored,
      description: v.description ?? '',
      // The fallback is shown in the placeholder, so it must be masked too.
      fallback: v.secret ? SECRET_MASK : v.value,
      secret: !!v.secret,
      _rid: `src:${i}`,
      _origIndex: i,
      _storedValue: stored,
      _dirty: false,
    }
  })
}

export function ProfileEditorModal({ onClose }: ProfileEditorModalProps) {
  const {
    currentFlow,
    activeProfileId,
    setActiveProfile,
    addProfile,
    updateProfile,
    deleteProfile,
    duplicateProfile,
    commitProfileVars,
    currentProject,
    activeEnvironmentId,
    setActiveEnvironment,
  } = useFlowStore()

  const { ensureUsable } = useVault()

  const profiles = currentFlow?.profiles ?? []
  const environments = currentProject?.environments ?? []
  const projectEnvVars = currentProject?.envVars ?? []
  const [selectedProfileId, setSelectedProfileId] = useState<string>(
    () => activeProfileId ?? profiles[0]?.id ?? '',
  )
  const [newProfileName, setNewProfileName] = useState('')
  const [addingProfile, setAddingProfile] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameInput, setRenameInput] = useState('')

  // Project env var reference popover (collapsed by default — never steals height from the table)
  const [envPopoverAnchor, setEnvPopoverAnchor] = useState<DOMRect | null>(null)
  const [envSearch, setEnvSearch] = useState('')
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [copiedMode, setCopiedMode] = useState<'insert' | 'copy'>('copy')

  const envBtnRef = useRef<HTMLButtonElement | null>(null)
  const envPopoverRef = useRef<HTMLDivElement | null>(null)
  const valueInputRefs = useRef<Record<string, HTMLInputElement | null>>({})
  /** Caret position of the last-focused value input, so a picked env var can be inserted there.
   *  Keyed by the draft row id, which is stable across re-renders and unique per profile. */
  const lastValueCaret = useRef<{ rid: string; start: number; end: number } | null>(null)

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId) ?? profiles[0] ?? null
  const activeEnvName = environments.find((e) => e.id === activeEnvironmentId)?.name

  // ── Profile list actions ──────────────────────────────────

  /** Switching profiles reloads the variable table from the store; anything not saved is dropped.
   *  Blur before switching: React rewrites the focused value input during the re-render, which
   *  fires a `select` event that would otherwise re-arm the caret we just cleared. */
  const selectProfile = (id: string) => {
    if (id === selectedProfileId) return
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur()
    lastValueCaret.current = null
    setSelectedProfileId(id)
  }

  /** Same as selectProfile but for programmatic jumps after add/duplicate. */
  const jumpToProfile = (id: string) => {
    lastValueCaret.current = null
    setSelectedProfileId(id)
  }

  const handleAddProfile = async () => {
    const name = newProfileName.trim()
    if (!name) return
    await addProfile(name)
    const updated = useFlowStore.getState().currentFlow?.profiles ?? []
    const last = updated[updated.length - 1]
    if (last) jumpToProfile(last.id)
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
    if (last) jumpToProfile(last.id)
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
    lastValueCaret.current = null
    if (selectedProfileId === id && nextProfile) {
      jumpToProfile(nextProfile.id)
    }
  }

  // ── Variable table (edit locally → 儲存) ───────────────────

  /** One row per variable. Key is shared across profiles; value/description are per-profile. */
  const varSource = useMemo<EditRow[]>(
    () => toEditRows(selectedProfile?.vars ?? [], activeEnvironmentId),
    [selectedProfile, activeEnvironmentId],
  )

  const [rows, setRows] = useState<EditRow[]>([])
  const [error, setError] = useState<string | null>(null)

  // The value column is per-profile AND per-environment, so both belong in the reload key.
  // Reloading overwrites whatever was typed but not saved — deliberately, and silently.
  const tableKey = selectedProfile
    ? `${currentFlow?.id ?? ''}:${selectedProfile.id}:${activeEnvironmentId ?? ''}`
    : ''
  useEffect(() => {
    setRows(varSource)
    setError(null)
    // varSource is intentionally out of the deps: it changes identity on every store write,
    // and re-running then would wipe rows the user is still editing.
  }, [tableKey])

  const setCell = <K extends keyof VarRow>(rid: string, key: K, v: VarRow[K]) => {
    setRows((prev) =>
      prev.map((r) => (r._rid === rid ? { ...r, [key]: v, _dirty: key === 'value' ? true : r._dirty } : r)),
    )
  }

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      {
        key: '', value: '', description: '', fallback: '', secret: false,
        _rid: `new:${uuidv4()}`, _origIndex: null, _storedValue: '', _dirty: true,
      },
    ])
  }

  /** Flip a row's private flag. Turning it ON needs a usable vault to encrypt with;
   *  turning it OFF needs one to recover the plaintext being un-encrypted. */
  const toggleSecret = async (rid: string) => {
    const row = rows.find((r) => r._rid === rid)
    if (!row || !ensureUsable()) return

    if (!row.secret) {
      setRows((prev) => prev.map((r) => (r._rid === rid ? { ...r, secret: true, _dirty: true } : r)))
      return
    }
    let plain = row.value
    if (!row._dirty && isCiphertext(row._storedValue)) {
      try {
        plain = await window.electronAPI.revealSecret(row._storedValue)
      } catch {
        return setError('無法解密此變數，請先解鎖保險庫')
      }
    }
    setRows((prev) =>
      prev.map((r) => (r._rid === rid ? { ...r, secret: false, value: plain, _dirty: true } : r)),
    )
  }

  /** What actually gets written for a row: ciphertext for private values, and the
   *  untouched stored ciphertext when the user never revealed or edited it. */
  const storedValueFor = async (r: EditRow): Promise<string> => {
    if (r.secret) {
      return !r._dirty && isCiphertext(r._storedValue)
        ? r._storedValue
        : await window.electronAPI.encryptSecret(r.value)
    }
    if (!r._dirty && isCiphertext(r._storedValue)) {
      return await window.electronAPI.revealSecret(r._storedValue)
    }
    return r.value
  }

  const handleSave = async () => {
    if (!selectedProfile) return
    const keys = rows.map((r) => r.key.trim())
    if (keys.some((k) => !k)) return setError('變數名稱不可為空')
    const dup = keys.find((k, i) => keys.indexOf(k) !== i)
    if (dup) return setError(`變數名稱重複：${dup}`)
    if (rows.some((r) => r.secret) && !ensureUsable()) return
    setError(null)

    let values: string[]
    try {
      values = await Promise.all(rows.map(storedValueFor))
    } catch (err) {
      return setError(`加密失敗：${String(err instanceof Error ? err.message : err)}`)
    }

    await commitProfileVars(
      selectedProfile.id,
      rows.map((r, i) => ({
        origIndex: r._origIndex,
        key: r.key.trim(),
        value: values[i],
        description: r.description,
        secret: r.secret,
      })),
      activeEnvironmentId,
    )
    // Re-load from the store: rows added here still carry `_origIndex: null`, so a second
    // 儲存 would append them all over again.
    const saved = useFlowStore.getState().currentFlow?.profiles?.find((p) => p.id === selectedProfile.id)
    setRows(toEditRows(saved?.vars ?? [], activeEnvironmentId))
  }

  /** Enter saves the whole table; spread onto the cell inputs. */
  const cellKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void handleSave()
    }
  }

  /** Variable keys are shared across every profile, so deleting one removes it everywhere. */
  const handleDeleteVar = async (rid: string) => {
    const key = rows.find((r) => r._rid === rid)?.key ?? ''
    const ok = await confirm({
      title: key ? `刪除變數 {{${key}}}？` : '刪除此變數？',
      detail: '此變數將從「所有配置」中移除，引用它的節點將無法解析。儲存後生效。',
      confirmLabel: '刪除',
      danger: true,
    })
    if (!ok) return
    setRows((prev) => prev.filter((r) => r._rid !== rid))
  }

  // ── Project env var picker ────────────────────────────────

  const rememberCaret = (rid: string, el: HTMLInputElement) => {
    lastValueCaret.current = {
      rid,
      start: el.selectionStart ?? el.value.length,
      end: el.selectionEnd ?? el.value.length,
    }
  }

  const envVarValueFor = (ev: { values: Record<string, string>; secret?: boolean }) =>
    ev.secret ? SECRET_MASK : activeEnvironmentId ? (ev.values[activeEnvironmentId] ?? '') : ''

  const visibleEnvVars = (() => {
    const q = envSearch.trim().toLowerCase()
    if (!q) return projectEnvVars
    return projectEnvVars.filter(
      (ev) =>
        ev.key.toLowerCase().includes(q) ||
        // Private values are excluded from the search corpus — matching on them would
        // turn the filter box into an oracle for the very value being hidden.
        (!ev.secret && (ev.values[activeEnvironmentId ?? ''] ?? '').toLowerCase().includes(q)),
    )
  })()

  /** Insert {{key}} at the last-focused value input's caret; fall back to the clipboard. */
  const handlePickEnvVar = (key: string) => {
    const token = `{{${key}}}`
    const caret = lastValueCaret.current
    const row = caret ? rows.find((r) => r._rid === caret.rid) : undefined

    if (caret && row) {
      const current = row.value
      setCell(row._rid, 'value', current.slice(0, caret.start) + token + current.slice(caret.end))
      const pos = caret.start + token.length
      lastValueCaret.current = { rid: caret.rid, start: pos, end: pos }
      requestAnimationFrame(() => {
        const el = valueInputRefs.current[caret.rid]
        el?.focus()
        el?.setSelectionRange(pos, pos)
      })
      setCopiedMode('insert')
    } else {
      navigator.clipboard?.writeText(token)
      setCopiedMode('copy')
    }
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 1500)
  }

  const closeEnvPopover = () => {
    setEnvPopoverAnchor(null)
    setEnvSearch('')
  }

  // Dismiss the popover on outside click / Escape (this modal has no Escape handler of its own)
  useEffect(() => {
    if (!envPopoverAnchor) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (envPopoverRef.current?.contains(target) || envBtnRef.current?.contains(target)) return
      closeEnvPopover()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeEnvPopover()
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [envPopoverAnchor])

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
    >
      <div
        style={{
          background: '#1e293b',
          border: '1px solid #334155',
          borderRadius: 12,
          width: 960,
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
                    onClick={() => { if (!isRenaming) selectProfile(p.id) }}
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
                          style={renameActionBtnStyle('#4ade80')}
                        >
                          ✓
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); cancelRename() }}
                          title="取消"
                          style={renameActionBtnStyle('#94a3b8')}
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
                          <span style={{ fontSize: 9, color: '#4ade80', flexShrink: 0 }}>使用中</span>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); setRenamingId(p.id); setRenameInput(p.name) }}
                          title="重新命名"
                          style={{
                            flexShrink: 0,
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                            color: '#93c5fd',
                            fontSize: 12,
                            padding: '1px 3px',
                            borderRadius: 3,
                            opacity: 0.5,
                            lineHeight: 1,
                          }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '1' }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.5' }}
                        >
                          ✏
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDuplicateProfile(p.id) }}
                          title="建立此配置的副本"
                          style={{
                            flexShrink: 0,
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                            color: '#93c5fd',
                            fontSize: 12,
                            padding: '1px 3px',
                            borderRadius: 3,
                            opacity: 0.5,
                            lineHeight: 1,
                          }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '1' }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.5' }}
                        >
                          ⧉
                        </button>
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {projectEnvVars.length > 0 && (
                      <button
                        ref={envBtnRef}
                        onClick={() =>
                          envPopoverAnchor
                            ? closeEnvPopover()
                            : setEnvPopoverAnchor(envBtnRef.current?.getBoundingClientRect() ?? null)
                        }
                        title={`瀏覽專案環境變數，點擊插入或複製 ${'{{key}}'}`}
                        style={{
                          ...envRefBtnStyle,
                          ...(envPopoverAnchor ? { borderColor: '#4ade80' } : {}),
                        }}
                      >
                        🌐 專案環境變數 ({projectEnvVars.length}) {envPopoverAnchor ? '▴' : '▾'}
                      </button>
                    )}
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
                </div>

                {/* Project env var picker — `fixed` so the right column's overflow:hidden can't clip it */}
                {envPopoverAnchor && (
                  <div
                    ref={envPopoverRef}
                    style={{
                      position: 'fixed',
                      top: envPopoverAnchor.bottom + 4,
                      left: Math.max(8, envPopoverAnchor.right - 340),
                      width: 340,
                      zIndex: 2100,
                      background: '#1e293b',
                      border: '1px solid #334155',
                      borderRadius: 8,
                      boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                      display: 'flex',
                      flexDirection: 'column',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        padding: '8px 10px',
                        borderBottom: '1px solid #334155',
                        flexShrink: 0,
                      }}
                    >
                      <input
                        autoFocus
                        value={envSearch}
                        onChange={(e) => setEnvSearch(e.target.value)}
                        placeholder="🔍 搜尋變數…"
                        style={cellInputStyle}
                      />
                      <div style={{ fontSize: 10, color: '#64748b', marginTop: 5 }}>
                        {rows.some((r) => r._rid === lastValueCaret.current?.rid)
                          ? '點擊插入至編輯中的「值」欄位'
                          : `點擊複製 ${'{{key}}'}（先點一個「值」欄位可直接插入）`}
                      </div>
                    </div>

                    <div style={{ overflowY: 'auto', maxHeight: 240 }}>
                      {visibleEnvVars.map((ev) => {
                        const value = envVarValueFor(ev)
                        return (
                          <div
                            key={ev.key}
                            onClick={() => handlePickEnvVar(ev.key)}
                            title={`{{${ev.key}}}`}
                            style={{
                              padding: '6px 10px',
                              cursor: 'pointer',
                              borderBottom: '1px solid #0f172a',
                              userSelect: 'none',
                            }}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#08140c' }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <code
                                style={{
                                  fontSize: 11,
                                  background: '#0f172a',
                                  color: '#4ade80',
                                  padding: '1px 5px',
                                  borderRadius: 3,
                                  border: '1px solid #166534',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {`{{${ev.key}}}`}
                              </code>
                              {ev.key === DOMAIN_ENV_KEY && (
                                <span style={{ fontSize: 10 }} title="保留變數">🔒</span>
                              )}
                              {ev.secret && (
                                <span style={{ fontSize: 10 }} title="私密資料（加密儲存）">🔐</span>
                              )}
                              <div style={{ flex: 1 }} />
                              {copiedKey === ev.key && (
                                <span style={{ fontSize: 10, color: '#4ade80', flexShrink: 0 }}>
                                  {copiedMode === 'insert' ? '已插入' : '已複製'}
                                </span>
                              )}
                            </div>
                            <div
                              style={{
                                fontSize: 10,
                                color: value ? '#78716c' : '#475569',
                                marginTop: 2,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {activeEnvironmentId ? (value || '(空)') : '—'}
                            </div>
                          </div>
                        )
                      })}

                      {visibleEnvVars.length === 0 && (
                        <div style={{ padding: 12, fontSize: 11, color: '#64748b' }}>
                          找不到符合的變數
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Env switcher — only when flow belongs to a project with environments */}
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
                    <span style={{ fontSize: 11, color: '#64748b', whiteSpace: 'nowrap' }}>環境值:</span>
                    <select
                      value={activeEnvironmentId ?? ''}
                      // The value column is per-environment — switching reloads the table.
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
                      <option value="">— 預設值 —</option>
                      {environments.map((env) => (
                        <option key={env.id} value={env.id}>{env.name}</option>
                      ))}
                    </select>
                  </div>
                )}

                <div style={{ overflowY: 'auto', flex: 1, padding: '8px 0' }}>
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
                    <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>參數名稱</span>
                    <span style={{ fontSize: 11, color: activeEnvironmentId ? '#4ade80' : '#64748b', fontWeight: 600 }}>
                      值{activeEnvName ? ` (${activeEnvName})` : ''}
                    </span>
                    <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>敘述（選填）</span>
                    <span
                      style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textAlign: 'center' }}
                      title="私密資料：加密後才寫入檔案"
                    >
                      🔐
                    </span>
                    <span />
                  </div>

                  {rows.map((row) => {
                    return (
                    <div
                      key={row._rid}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: gridCols,
                        gap: 8,
                        padding: '5px 16px',
                        alignItems: 'center',
                      }}
                    >
                      <input
                        value={row.key}
                        onChange={(e) => setCell(row._rid, 'key', e.target.value)}
                        onKeyDown={cellKeyDown}
                        placeholder="key"
                        style={cellInputStyle}
                        title="修改參數名稱將同步至所有配置（儲存後生效）"
                      />
                      <input
                        ref={(el) => { valueInputRefs.current[row._rid] = el }}
                        type={row.secret ? 'password' : 'text'}
                        value={row.value}
                        onChange={(e) => { rememberCaret(row._rid, e.currentTarget); setCell(row._rid, 'value', e.target.value) }}
                        onFocus={(e) => rememberCaret(row._rid, e.currentTarget)}
                        onSelect={(e) => rememberCaret(row._rid, e.currentTarget)}
                        onKeyDown={cellKeyDown}
                        // A private row loads masked with no plaintext in the renderer, and its
                        // fallback is masked too (toEditRows) so the placeholder can't leak it.
                        placeholder={
                          row.secret && !row._dirty
                            ? '（已加密，輸入以覆寫）'
                            : activeEnvironmentId
                              ? `預設: ${row.fallback || '(空)'}`
                              : 'value'
                        }
                        style={{
                          ...cellInputStyle,
                          ...(row.secret
                            ? { borderColor: '#a16207' }
                            : activeEnvironmentId
                              ? { borderColor: '#166534' }
                              : {}),
                        }}
                      />
                      <input
                        value={row.description}
                        onChange={(e) => setCell(row._rid, 'description', e.target.value)}
                        onKeyDown={cellKeyDown}
                        placeholder="說明此參數用途…"
                        style={{ ...cellInputStyle, color: '#94a3b8' }}
                      />
                      <button
                        onClick={() => void toggleSecret(row._rid)}
                        title={row.secret ? '目前為私密資料（加密儲存）— 點擊取消' : '設為私密資料（加密後才寫入檔案，所有配置共用）'}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          fontSize: 13,
                          padding: 2,
                          opacity: row.secret ? 1 : 0.3,
                          filter: row.secret ? undefined : 'grayscale(1)',
                        }}
                      >
                        🔐
                      </button>
                      <button
                        onClick={() => handleDeleteVar(row._rid)}
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
                  )
                  })}

                  {rows.length === 0 && (
                    <div style={{ padding: '16px', color: '#64748b', fontSize: 12 }}>
                      尚無變數。點擊下方「新增變數」。
                    </div>
                  )}
                </div>

                <div
                  style={{
                    padding: 12,
                    borderTop: '1px solid #334155',
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  <button
                    onClick={addRow}
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
                  <div style={{ flex: 1 }} />
                  {error && (
                    <span style={{ fontSize: 11, color: '#f87171', whiteSpace: 'nowrap' }}>{error}</span>
                  )}
                  <button
                    onClick={() => void handleSave()}
                    style={{
                      padding: '6px 16px',
                      borderRadius: 4,
                      border: 'none',
                      fontSize: 12,
                      fontWeight: 600,
                      background: '#3b82f6',
                      color: '#fff',
                      cursor: 'pointer',
                    }}
                  >
                    儲存
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

/** 參數名稱 / 值 / 敘述 / 🔐 / 🗑 — the value column is weighted since it holds long URLs and tokens. */
const gridCols = '1fr 1.3fr 1fr 28px 32px'

const envRefBtnStyle: React.CSSProperties = {
  padding: '3px 10px',
  borderRadius: 4,
  border: '1px solid #166534',
  background: '#14532d',
  color: '#4ade80',
  fontSize: 11,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
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
