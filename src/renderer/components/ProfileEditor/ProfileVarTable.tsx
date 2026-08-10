import { useMemo, useRef } from 'react'
import { useFlowStore } from '../../stores/flowStore'
import { useProjectStore } from '../../stores/projectStore'
import { SECRET_MASK } from '@shared/types'
import type { FlowProfile, ProfileVariable } from '@shared/types'
import { confirm } from '../../stores/confirmStore'
import { useVault } from '../../hooks/useVault'
import { useDraftRows, newRowId, submitOnEnter } from '../../hooks/useDraftRows'
import type { DraftRowBase } from '../../hooks/useDraftRows'
import {
  cellInputStyle,
  SECRET_FIELD_BORDER,
  SecretToggleButton,
  DeleteRowButton,
  TableEmptyState,
  varHeaderStyle,
  varRowStyle,
} from '../common/varTable'
import { EnvVarPickerPopover } from './EnvVarPickerPopover'
import { token } from '../../styles/tokens'

/** A row as edited in the table. `_origIndex` is the row's index in the store at load
 *  time — `commitProfileVars` reads it to tell added rows from edited ones. `fallback`
 *  is display-only (the base value behind an env override). */
type EditRow = DraftRowBase & {
  description: string
  fallback: string
  _origIndex: number | null
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

/**
 * The right column of ProfileEditorModal: one profile's variable table, the environment
 * selector the value column is resolved against, and the env-var reference popover.
 *
 * Mounted with `key={profile.id}`, so switching profiles remounts this whole subtree.
 * That is what keeps the caret map below honest — see the note on `lastValueCaret`.
 */
export function ProfileVarTable({ profile, onClose }: { profile: FlowProfile; onClose: () => void }) {
  const { currentFlow, activeProfileId, setActiveProfile, commitProfileVars } = useFlowStore()
  const { currentProject, activeEnvironmentId, setActiveEnvironment } = useProjectStore()
  const { ensureUsable } = useVault()

  const environments = currentProject?.environments ?? []
  const projectEnvVars = currentProject?.envVars ?? []
  const activeEnvName = environments.find((e) => e.id === activeEnvironmentId)?.name

  /** rid → the value `<input>`, so a picked env var can be inserted and refocused. */
  const valueInputRefs = useRef<Record<string, HTMLInputElement | null>>({})
  /** Caret position of the last-focused value input, keyed by draft row id. Switching
   *  profiles remounts this component, so it resets without anyone clearing it. */
  const lastValueCaret = useRef<{ rid: string; start: number; end: number } | null>(null)

  const varSource = useMemo<EditRow[]>(
    () => toEditRows(profile.vars ?? [], activeEnvironmentId),
    [profile, activeEnvironmentId],
  )

  // The value column is per-profile AND per-environment. The profile half is handled by
  // the remount; the environment half needs the reload key.
  const { rows, setRows, error, setCell, addRow, removeRow, toggleSecret, prepareValues } =
    useDraftRows<EditRow>({
      source: varSource,
      reloadKey: `${currentFlow?.id ?? ''}:${profile.id}:${activeEnvironmentId ?? ''}`,
      blankRow: () => ({
        key: '', value: '', description: '', fallback: '', secret: false,
        _rid: newRowId(), _origIndex: null, _storedValue: '', _dirty: true,
      }),
      ensureUsable,
    })

  const handleSave = async () => {
    const values = await prepareValues()
    if (!values) return

    await commitProfileVars(
      profile.id,
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
    const saved = useFlowStore.getState().currentFlow?.profiles?.find((p) => p.id === profile.id)
    setRows(toEditRows(saved?.vars ?? [], activeEnvironmentId))
  }

  const cellKeyDown = submitOnEnter(() => void handleSave())

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
    removeRow(rid)
  }

  const rememberCaret = (rid: string, el: HTMLInputElement) => {
    lastValueCaret.current = {
      rid,
      start: el.selectionStart ?? el.value.length,
      end: el.selectionEnd ?? el.value.length,
    }
  }

  /** Insert {{key}} at the last-focused value input's caret; fall back to the clipboard. */
  const handlePickEnvVar = (key: string): 'insert' | 'copy' => {
    const placeholder = `{{${key}}}`
    const caret = lastValueCaret.current
    const row = caret ? rows.find((r) => r._rid === caret.rid) : undefined
    if (!caret || !row) {
      navigator.clipboard?.writeText(placeholder)
      return 'copy'
    }

    const current = row.value
    setCell(row._rid, 'value', current.slice(0, caret.start) + placeholder + current.slice(caret.end))
    const pos = caret.start + placeholder.length
    lastValueCaret.current = { rid: caret.rid, start: pos, end: pos }
    requestAnimationFrame(() => {
      const el = valueInputRefs.current[caret.rid]
      el?.focus()
      el?.setSelectionRange(pos, pos)
    })
    return 'insert'
  }

  const isActive = activeProfileId === profile.id

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 16px',
          borderBottom: `1px solid ${token.border}`,
          flexShrink: 0,
        }}
      >
        <div>
          <span style={{ fontSize: 13, color: token.text, fontWeight: 600 }}>{profile.name}</span>
          <span style={{ fontSize: 11, color: token.textMuted, marginLeft: 8 }}>
            的變數（可用 {'{{key}}'} 引用）
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <EnvVarPickerPopover
            envVars={projectEnvVars}
            activeEnvironmentId={activeEnvironmentId}
            onPick={handlePickEnvVar}
            canInsert={() => rows.some((r) => r._rid === lastValueCaret.current?.rid)}
          />
          <button
            onClick={() => { setActiveProfile(profile.id); onClose() }}
            style={{
              padding: '4px 12px',
              borderRadius: 4,
              border: 'none',
              background: isActive ? token.bgDisabled : token.accent,
              color: isActive ? token.textDisabled : token.textOnAccent,
              fontSize: 12,
              cursor: isActive ? 'default' : 'pointer',
            }}
          >
            {isActive ? '目前使用中' : '切換為此配置'}
          </button>
        </div>
      </div>

      {/* Env switcher — only when the flow belongs to a project with environments */}
      {environments.length > 0 && (
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
          <span style={{ fontSize: 11, color: token.textMuted, whiteSpace: 'nowrap' }}>環境值:</span>
          <select
            value={activeEnvironmentId ?? ''}
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
            <option value="">— 預設值 —</option>
            {environments.map((env) => (
              <option key={env.id} value={env.id}>{env.name}</option>
            ))}
          </select>
        </div>
      )}

      <div style={{ overflowY: 'auto', flex: 1, padding: '8px 0' }}>
        {/* Column headers */}
        <div style={varHeaderStyle(gridCols)}>
          <span style={{ fontSize: 11, color: token.textMuted, fontWeight: 600 }}>參數名稱</span>
          <span style={{ fontSize: 11, color: activeEnvironmentId ? token.successFg : token.textMuted, fontWeight: 600 }}>
            值{activeEnvName ? ` (${activeEnvName})` : ''}
          </span>
          <span style={{ fontSize: 11, color: token.textMuted, fontWeight: 600 }}>敘述（選填）</span>
          <span
            style={{ fontSize: 11, color: token.textMuted, fontWeight: 600, textAlign: 'center' }}
            title="私密資料：加密後才寫入檔案"
          >
            🔐
          </span>
          <span />
        </div>

        {rows.map((row) => (
          <div key={row._rid} style={varRowStyle(gridCols)}>
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
                  ? { borderColor: SECRET_FIELD_BORDER }
                  : activeEnvironmentId
                    ? { borderColor: token.successDark }
                    : {}),
              }}
            />
            <input
              value={row.description}
              onChange={(e) => setCell(row._rid, 'description', e.target.value)}
              onKeyDown={cellKeyDown}
              placeholder="說明此參數用途…"
              style={{ ...cellInputStyle, color: token.textSecondary }}
            />
            <SecretToggleButton
              secret={row.secret}
              title={row.secret ? '目前為私密資料（加密儲存）— 點擊取消' : '設為私密資料（加密後才寫入檔案，所有配置共用）'}
              onClick={() => void toggleSecret(row._rid)}
            />
            <DeleteRowButton title="從所有配置刪除此變數" onClick={() => handleDeleteVar(row._rid)} />
          </div>
        ))}

        {rows.length === 0 && <TableEmptyState>尚無變數。點擊下方「新增變數」。</TableEmptyState>}
      </div>

      <div
        style={{
          padding: 12,
          borderTop: `1px solid ${token.border}`,
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
            border: `1px dashed ${token.border}`,
            background: 'transparent',
            color: token.accent,
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          ＋ 新增變數（所有配置同步）
        </button>
        <div style={{ flex: 1 }} />
        {error && (
          <span style={{ fontSize: 11, color: token.dangerFg, whiteSpace: 'nowrap' }}>{error}</span>
        )}
        <button
          onClick={() => void handleSave()}
          style={{
            padding: '6px 16px',
            borderRadius: 4,
            border: 'none',
            fontSize: 12,
            fontWeight: 600,
            background: token.accent,
            color: token.textOnAccent,
            cursor: 'pointer',
          }}
        >
          儲存
        </button>
      </div>
    </div>
  )
}

/** 參數名稱 / 值 / 敘述 / 🔐 / 🗑 — the value column is weighted since it holds long URLs and tokens. */
const gridCols = '1fr 1.3fr 1fr 28px 32px'
