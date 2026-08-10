import { useMemo } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { DOMAIN_ENV_KEY } from '@shared/types'
import type { ProjectEnvVar } from '@shared/types'
import { confirm } from '../../stores/confirmStore'
import { useVault } from '../../hooks/useVault'
import { useDraftRows, newRowId, submitOnEnter } from '../../hooks/useDraftRows'
import type { DraftRowBase } from '../../hooks/useDraftRows'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import {
  cellInputStyle,
  SECRET_FIELD_BORDER,
  SecretToggleButton,
  DeleteRowButton,
  TableEmptyState,
  varHeaderStyle,
  varRowStyle,
} from '../common/varTable'
import { EnvironmentToolbar } from './EnvironmentToolbar'
import { token, radius } from '../../styles/tokens'

/** A row as edited in the table. `_origKey` is the key this row had in the store at load
 *  time — `commitProjectEnvVars` uses it to carry other environments' values across a
 *  rename, and `null` marks a row added here. The rest comes from `DraftRowBase`. */
type EditRow = DraftRowBase & { _origKey: string | null }

/** Store env vars → table rows, resolved for the selected environment. */
function toEditRows(vars: ProjectEnvVar[], envId: string | null): EditRow[] {
  return vars.map((v, i) => {
    const stored = (envId && v.values[envId]) ?? ''
    return {
      key: v.key,
      // A private row starts masked: its plaintext is not in the renderer at all.
      value: v.secret ? '' : stored,
      secret: !!v.secret,
      _rid: `src:${i}`,
      _origKey: v.key,
      _storedValue: stored,
      _dirty: false,
    }
  })
}

interface ProjectEnvVarModalProps {
  onClose: () => void
}

/**
 * Editor for project-level environment variables. One key per row with a single
 * value column for the currently selected environment (switched via EnvironmentToolbar,
 * mirroring ProfileEditorModal's 環境值 selector). Flow profile variable values
 * can reference these via {{key}}.
 */
export function ProjectEnvVarModal({ onClose }: ProjectEnvVarModalProps) {
  const { currentProject, activeEnvironmentId, commitProjectEnvVars } = useProjectStore()
  const { ensureUsable } = useVault()

  const environments = currentProject?.environments ?? []
  const envVars = currentProject?.envVars ?? []

  // Display fallback only — the global activeEnvironmentId is untouched until
  // the user picks from the dropdown.
  const selectedEnv =
    environments.find((e) => e.id === activeEnvironmentId) ?? environments[0] ?? null

  // ── Variable table (edit locally → 儲存) ───────────────────

  const varSource = useMemo<EditRow[]>(
    () => toEditRows(envVars, selectedEnv?.id ?? null),
    [envVars, selectedEnv],
  )

  // The value column is per-environment, so the environment belongs in the reload key.
  // Reloading overwrites whatever was typed but not saved — deliberately, and silently.
  const { rows, setRows, error, setCell, addRow, removeRow, toggleSecret, prepareValues } =
    useDraftRows<EditRow>({
      source: varSource,
      reloadKey: currentProject && selectedEnv ? `${currentProject.id}:${selectedEnv.id}` : '',
      blankRow: () => ({
        key: '', value: '', secret: false,
        _rid: newRowId(), _origKey: null, _storedValue: '', _dirty: true,
      }),
      ensureUsable,
      // `domain` is baked into goto URLs as a literal, so it can never be private.
      canToggleSecret: (row) => row.key !== DOMAIN_ENV_KEY,
    })

  const handleSave = async () => {
    if (!selectedEnv) return
    const values = await prepareValues((keys) =>
      // `domain` is reserved: it must survive and keep its name.
      keys.includes(DOMAIN_ENV_KEY) ? null : `${DOMAIN_ENV_KEY} 為保留變數，不可刪除或改名`,
    )
    if (!values) return

    await commitProjectEnvVars(
      rows.map((r, i) => ({ origKey: r._origKey, key: r.key.trim(), value: values[i], secret: r.secret })),
      selectedEnv.id,
    )
    // Re-load from the store: rows added here still carry `_origKey: null`, so a second
    // 儲存 would append them all over again.
    setRows(toEditRows(useProjectStore.getState().currentProject?.envVars ?? [], selectedEnv.id))
  }

  const cellKeyDown = submitOnEnter(() => void handleSave())

  const handleDeleteVar = async (rid: string) => {
    const key = rows.find((r) => r._rid === rid)?.key ?? ''
    const ok = await confirm({
      title: key ? `刪除環境變數 {{${key}}}？` : '刪除此變數？',
      detail: '此變數在所有環境上的值將一併移除，引用它的配置變數將無法解析。儲存後生效。',
      confirmLabel: '刪除',
      danger: true,
    })
    if (!ok) return
    removeRow(rid)
  }

  const gridCols = '1fr 1fr 28px 32px'

  return (
    <Modal
      variant="panel"
      width={640}
      onClose={onClose}
      // Same reasoning as ProfileEditorModal: a stray backdrop click would silently
      // discard the whole in-progress table, and there is no dirty tracking by design.
      closeOnBackdrop={false}
      closeOnEscape={false}
      // The env switcher is pinned and only the table scrolls, so the body has to be
      // a flex column — Modal's default body is a plain scroll box.
      bodyStyle={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      title={
        <div>
          <span style={{ fontSize: 15, fontWeight: 700, color: token.text }}>專案環境變數</span>
          <span style={{ fontSize: 12, color: token.textMuted, marginLeft: 10 }}>
            {currentProject?.name ?? ''}（配置可用 {'{{key}}'} 引用）
          </span>
        </div>
      }
      footer={
        <>
          {environments.length > 0 && (
            <button
              onClick={addRow}
              className="ft-btn"
              style={{
                padding: '6px 14px',
                borderRadius: radius.sm,
                border: `1px dashed ${token.border}`,
                background: 'transparent',
                color: token.accent,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              ＋ 新增變數
            </button>
          )}
          <div style={{ flex: 1 }} />
          {error && <span style={{ fontSize: 11, color: token.dangerFg, whiteSpace: 'nowrap' }}>{error}</span>}
          <Button tone="primary" onClick={() => void handleSave()}>
            儲存
          </Button>
          <Button size="md" onClick={onClose}>
            關閉
          </Button>
        </>
      }
    >
      <>
        <EnvironmentToolbar selectedEnv={selectedEnv} />

        {/* Body */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '8px 0' }}>
          {environments.length === 0 ? (
            <div style={{ padding: 24, color: token.warning, fontSize: 13 }}>
              此專案尚無環境。請先在工具列的 🌐 環境選單新增環境（如 DEV / UAT / PRD），才能填寫各環境的值。
            </div>
          ) : (
            <>
              {/* Column headers */}
              <div style={varHeaderStyle(gridCols)}>
                <span style={{ fontSize: 11, color: token.textMuted, fontWeight: 600 }}>變數名稱</span>
                <span style={{ fontSize: 11, color: token.successFg, fontWeight: 600 }}>
                  值{selectedEnv ? ` (${selectedEnv.name})` : ''}
                </span>
                <span style={{ fontSize: 11, color: token.textMuted, fontWeight: 600, textAlign: 'center' }} title="私密資料：加密後才寫入檔案">
                  🔐
                </span>
                <span />
              </div>

              {rows.map((row) => {
                // `domain` is a reserved env var (drives goto-URL origin substitution) — its key
                // is locked and it cannot be deleted; only its per-environment value is editable.
                const isDomain = row.key === DOMAIN_ENV_KEY
                return (
                <div key={row._rid} style={varRowStyle(gridCols)}>
                  <input
                    value={row.key}
                    readOnly={isDomain}
                    onChange={(e) => setCell(row._rid, 'key', e.target.value)}
                    onKeyDown={cellKeyDown}
                    placeholder="key"
                    style={isDomain ? { ...cellInputStyle, color: token.textSecondary, cursor: 'not-allowed' } : cellInputStyle}
                    title={isDomain ? 'domain 為保留變數，無法改名或刪除' : '變數名稱（配置以 {{key}} 引用）'}
                  />
                  <input
                    type={row.secret ? 'password' : 'text'}
                    value={row.value}
                    onChange={(e) => setCell(row._rid, 'value', e.target.value)}
                    onKeyDown={cellKeyDown}
                    // A private row loads masked with no plaintext in the renderer at all,
                    // so say so rather than showing a misleading empty field.
                    placeholder={row.secret && !row._dirty ? '（已加密，輸入以覆寫）' : '(空)'}
                    style={{ ...cellInputStyle, borderColor: row.secret ? SECRET_FIELD_BORDER : token.successDark }}
                  />
                  {isDomain ? (
                    <span
                      title="domain 會被寫入 goto 網址，無法設為私密"
                      style={{ textAlign: 'center', color: token.borderStrong, fontSize: 11 }}
                    >
                      —
                    </span>
                  ) : (
                    <SecretToggleButton
                      secret={row.secret}
                      title={row.secret ? '目前為私密資料（加密儲存）— 點擊取消' : '設為私密資料（加密後才寫入檔案）'}
                      onClick={() => void toggleSecret(row._rid)}
                    />
                  )}
                  {isDomain ? (
                    <span title="domain 為保留變數，無法刪除" style={{ textAlign: 'center', color: token.borderStrong, fontSize: 13 }}>🔒</span>
                  ) : (
                    <DeleteRowButton title="刪除此變數" onClick={() => handleDeleteVar(row._rid)} />
                  )}
                </div>
                )
              })}

              {rows.length === 0 && <TableEmptyState>尚無環境變數。點擊下方「新增變數」。</TableEmptyState>}
            </>
          )}
        </div>
      </>
    </Modal>
  )
}
