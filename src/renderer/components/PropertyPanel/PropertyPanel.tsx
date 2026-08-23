import React, { useState, useEffect, useCallback } from 'react'
import type { FlowProfile } from '@shared/types'
import { SECRET_ENVELOPE_PREFIX, SECRET_MASK } from '@shared/types'
import { hasValueField, isSecretable } from '@shared/actionFields'
import { useFlowStore } from '../../stores/flowStore'
import { useVault } from '../../hooks/useVault'
import { notify } from '../../stores/confirmStore'
import { formatError } from '../../stores/errorStore'
import { Input, FieldLabel } from '../common/Input'
import { Button } from '../common/Button'
import { token } from '../../styles/tokens'

/** Amber used for the private-value border. No token matches this exact shade
 *  (--ft-warning-dark is a darker #78350f) — kept as a local literal per the
 *  single-file-use convention documented in tokens.css. */
const SECRET_BORDER = '#a16207'

const isCiphertext = (v: string): boolean => v.startsWith(SECRET_ENVELOPE_PREFIX)

/** Same test Toolbar uses — main throws this message from assertUnlocked(). */
const isLockedError = (err: unknown): boolean => String(err).includes('保險庫已鎖定')

export function PropertyPanel() {
  const { currentFlow, selectedNodeId, updateNode } = useFlowStore()
  const selectedNode = currentFlow?.nodes.find((n) => n.id === selectedNodeId)
  const { ensureUsable, promptUnlock } = useVault()

  // callFlow-specific state (loaded async; not an edited field)
  const [subFlowProfiles, setSubFlowProfiles] = useState<FlowProfile[]>([])
  const [subFlowLoading, setSubFlowLoading] = useState(false)

  // Edited fields live here until 儲存 is pressed. Nothing tracks "unsaved" — switching
  // nodes just overwrites them with the new node's values.
  const [desc, setDesc] = useState('')
  const [selector, setSelector] = useState('')
  const [locatorExpr, setLocatorExpr] = useState('')
  const [value, setValue] = useState('')
  const [code, setCode] = useState('')
  const [profileMapping, setProfileMapping] = useState<Record<string, string | null>>({})
  const [secret, setSecret] = useState(false)
  /** What is on disk, so an untouched private value can be re-saved without re-encrypting. */
  const [storedValue, setStoredValue] = useState('')
  const [valueDirty, setValueDirty] = useState(false)

  // Re-sync on the node ID only — a new node OBJECT for the same node (drag, ACTION_UPDATED)
  // must not wipe what the user is typing.
  useEffect(() => {
    const node = useFlowStore.getState().currentFlow?.nodes.find((n) => n.id === selectedNodeId)
    const isSecret = !!node?.action.secret
    const stored = node?.action.value ?? ''
    setDesc(node?.action.description ?? '')
    setSelector(node?.action.selector ?? '')
    setLocatorExpr(node?.action.locatorExpr ?? '')
    // A private node's plaintext is never loaded into the renderer — the field starts blank.
    setValue(isSecret ? '' : stored)
    setCode(node?.action.code ?? '')
    setProfileMapping(node?.action.subFlowProfileMapping ?? {})
    setSecret(isSecret)
    setStoredValue(stored)
    setValueDirty(false)
  }, [selectedNodeId])

  /**
   * Flip the node's private flag.
   *
   * Turning it ON also scrubs the plaintext out of the description: the recorder writes
   * descriptions like 填入「hunter2」到「密碼」, and that string is committed to git,
   * drawn on the canvas, and emitted as the test.step() name. Masking only the value
   * would leave the secret in plain sight everywhere else.
   */
  const toggleSecret = async () => {
    if (!ensureUsable()) return
    if (!secret) {
      const plain = value
      if (plain) {
        setDesc((d) => d.split(plain).join(SECRET_MASK))
      }
      setSecret(true)
      setValueDirty(true)
      return
    }
    let plain = value
    if (!valueDirty && isCiphertext(storedValue)) {
      try {
        plain = await window.electronAPI.revealSecret(storedValue)
      } catch {
        return
      }
    }
    setSecret(false)
    setValue(plain)
    setValueDirty(true)
  }

  /**
   * Save re-reads the node from the store rather than using the captured `selectedNode`,
   * so fields the recorder wrote while the panel was open (opensPage, pageAlias, framePath,
   * clickCount…) are never clobbered by what the panel happens to be holding.
   */
  const saveNode = useCallback(async () => {
    if (!selectedNodeId) return
    const node = useFlowStore.getState().currentFlow?.nodes.find((n) => n.id === selectedNodeId)
    if (!node) return
    const isCallFlow = node.action.type === 'callFlow'
    let callFlowUpdates: object = {}
    if (isCallFlow) {
      // When only 1 mapping entry, update the legacy badge fields so ActionNode reflects the change
      const keys = Object.keys(profileMapping)
      if (keys.length === 1) {
        const subProfileId = profileMapping[keys[0]] ?? subFlowProfiles[0]?.id ?? null
        const subProfileName = subFlowProfiles.find((p) => p.id === subProfileId)?.name
        callFlowUpdates = {
          subFlowProfileMapping: profileMapping,
          ...(subProfileId ? { subFlowProfileId: subProfileId, subFlowProfileName: subProfileName } : {}),
        }
      } else {
        callFlowUpdates = { subFlowProfileMapping: profileMapping }
      }
    }
    // Upload paths are made workspace-relative before storing, so a flow shared
    // through git isn't pinned to the machine it was authored on.
    let uploadUpdates: object = {}
    let effectiveValue = value
    if (node.action.type === 'upload') {
      const typed = value.split(',').map((s) => s.trim()).filter(Boolean)
      const filePaths = await window.electronAPI.normalizePaths(typed)
      effectiveValue = filePaths.join(', ')
      uploadUpdates = { filePaths }
    }

    // Private values are stored as ciphertext. An untouched one is written back verbatim
    // so re-saving doesn't need the plaintext the panel never held.
    let storedForDisk = effectiveValue
    try {
      if (secret) {
        storedForDisk = !valueDirty && isCiphertext(storedValue)
          ? storedValue
          : await window.electronAPI.encryptSecret(effectiveValue)
      } else if (!valueDirty && isCiphertext(storedValue)) {
        storedForDisk = await window.electronAPI.revealSecret(storedValue)
      }
    } catch (err) {
      // A modal, not a toast: the user pressed 儲存 and this return is the whole reason
      // nothing happened. A locked vault is actionable, so raise the unlock dialog for it
      // instead of just describing the problem.
      if (isLockedError(err)) promptUnlock('儲存私密資料需要讀取保險庫，請先解鎖。')
      else await notify({ title: '儲存失敗', message: '私密資料處理失敗', detail: formatError(err) })
      return
    }

    updateNode(node.id, {
      action: {
        ...node.action,
        description: desc,
        selector,
        secret,
        // Written verbatim so a cleared field actually clears. Only include locatorExpr for
        // nodes that already have one, so nodes without a locator don't gain an empty string.
        ...(node.action.locatorExpr !== undefined ? { locatorExpr } : {}),
        value: storedForDisk,
        // Multi-select nodes keep values[] in sync with the comma-joined value field.
        // Skipped for private nodes — values[] would be a plaintext copy of what `value`
        // just encrypted.
        ...(node.action.values && !secret
          ? { values: value.split(',').map((s) => s.trim()).filter(Boolean) }
          : {}),
        // Upload nodes do the same for filePaths[], which replay/export read first
        ...uploadUpdates,
        ...(node.action.type === 'code' ? { code } : {}),
        ...callFlowUpdates,
      },
    })
    if (!secret && effectiveValue !== value) setValue(effectiveValue)
    setStoredValue(storedForDisk)
    setValueDirty(false)
    // updateNode persists itself (this isn't a position-only update).
  }, [selectedNodeId, subFlowProfiles, updateNode, desc, selector, locatorExpr, value, code, profileMapping, secret, storedValue, valueDirty, promptUnlock])

  /** Enter saves; spread onto the single-line inputs. */
  const fieldKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void saveNode()
    }
  }

  // When a callFlow node is selected, load sub-flow profiles and seed the mapping defaults.
  useEffect(() => {
    if (selectedNode?.action.type !== 'callFlow') {
      setSubFlowProfiles([])
      return
    }
    const subFlowId = selectedNode.action.subFlowId
    if (!subFlowId) return
    // Capture before async to avoid stale closure issues
    const existingMapping = selectedNode.action.subFlowProfileMapping ?? {}
    const legacySubProfileId = selectedNode.action.subFlowProfileId ?? null
    setSubFlowLoading(true)
    window.electronAPI.getFlow(subFlowId).then((flow) => {
      const profiles = flow?.profiles ?? []
      setSubFlowProfiles(profiles)
      // Pre-fill defaults for all parent profiles so the dropdown value is always persisted on save.
      // Priority: existing mapping entry > legacy subFlowProfileId > first sub-flow profile
      const parentProfs = useFlowStore.getState().currentFlow?.profiles ?? []
      const defaultSubProfileId = profiles[0]?.id ?? null
      const initialMapping: Record<string, string | null> = {}
      parentProfs.forEach((pp) => {
        if (pp.id in existingMapping) {
          initialMapping[pp.id] = existingMapping[pp.id]
        } else {
          initialMapping[pp.id] = legacySubProfileId ?? defaultSubProfileId
        }
      })
      setProfileMapping(initialMapping)
      setSubFlowLoading(false)
    })
  }, [selectedNodeId, selectedNode?.action.type, selectedNode?.action.subFlowId])

  if (!currentFlow) return null

  // Native picker — main copies each pick into fixtures/ and hands back the stored paths.
  const pickFiles = async () => {
    const picked = await window.electronAPI.pickFiles(true)
    if (picked.length) setValue(picked.join(', '))
  }

  const parentProfiles = currentFlow.profiles ?? []
  const isCallFlow = selectedNode?.action.type === 'callFlow'
  const showMappingSection = isCallFlow && parentProfiles.length > 0 && (subFlowLoading || subFlowProfiles.length > 0)

  return (
    <div
      style={{
        background: '#1e293b',
        borderTop: '1px solid #334155',
        padding: '12px 16px',
        flexShrink: 0,
        maxHeight: 420,
        overflowY: 'auto',
      }}
    >
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {selectedNode ? (
          <>
            {/* Description */}
            <Field label="描述">
              <Input
                block={false}
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                onKeyDown={fieldKeyDown}
                style={{ padding: '5px 8px', fontSize: 12, width: 200 }}
              />
            </Field>

            {/* Selector — hidden for callFlow, goto, press */}
            {selectedNode.action.type !== 'goto' &&
              selectedNode.action.type !== 'press' &&
              selectedNode.action.type !== 'callFlow' &&
              selectedNode.action.type !== 'code' && (
              <Field label="Selector">
                <Input
                  block={false}
                  value={selector}
                  onChange={(e) => setSelector(e.target.value)}
                  onKeyDown={fieldKeyDown}
                  style={{ padding: '5px 8px', fontSize: 12, width: 200 }}
                />
              </Field>
            )}

            {/* Locator Expr — hidden for goto and callFlow */}
            {selectedNode.action.type !== 'goto' &&
              selectedNode.action.type !== 'callFlow' &&
              selectedNode.action.locatorExpr !== undefined && (
              <Field label="Locator">
                <Input
                  block={false}
                  value={locatorExpr}
                  onChange={(e) => setLocatorExpr(e.target.value)}
                  onKeyDown={fieldKeyDown}
                  style={{ padding: '5px 8px', fontSize: 12, width: 260 }}
                />
                <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
                  可插入變數，如 <code style={{ color: '#7dd3fc' }}>{'{{randomText}}'}</code>
                </div>
              </Field>
            )}

            {/* Value */}
            {hasValueField(selectedNode.action.type) && (
              <Field label={
                selectedNode.action.type === 'assertText' ? '驗證文字' :
                selectedNode.action.type === 'assertValue' ? '驗證值' :
                selectedNode.action.type === 'upload' ? '檔案路徑' : '值'
              }>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Input
                    block={false}
                    type={secret ? 'password' : 'text'}
                    value={value}
                    onChange={(e) => { setValue(e.target.value); setValueDirty(true) }}
                    onKeyDown={fieldKeyDown}
                    placeholder={secret && !valueDirty ? '（已加密，輸入以覆寫）' : undefined}
                    style={{
                      padding: '5px 8px',
                      fontSize: 12,
                      width: 200,
                      ...(secret ? { borderColor: SECRET_BORDER } : {}),
                    }}
                  />
                  {isSecretable(selectedNode.action) && (
                    <Button
                      tone="ghost"
                      size="sm"
                      onClick={() => void toggleSecret()}
                      title={secret
                        ? '目前為私密資料（加密儲存）— 點擊取消'
                        : '設為私密資料：值會加密後才寫入檔案，描述中的明文也會一併遮蔽'}
                      style={{
                        whiteSpace: 'nowrap',
                        opacity: secret ? 1 : 0.45,
                        filter: secret ? undefined : 'grayscale(1)',
                      }}
                    >
                      🔐
                    </Button>
                  )}
                  {selectedNode.action.type === 'upload' && (
                    <Button
                      tone="ghost"
                      size="sm"
                      onClick={pickFiles}
                      title="選擇檔案（會複製到 fixtures/）"
                      style={{ whiteSpace: 'nowrap' }}
                    >
                      📂 選擇檔案…
                    </Button>
                  )}
                </div>
                <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
                  {secret
                    ? '🔐 加密儲存；匯出的腳本以 process.env 參照，不含明文。'
                    : selectedNode.action.type === 'upload'
                      ? '路徑相對於工作區（fixtures/…）；絕對路徑會在儲存時自動轉換，多檔用逗號分隔'
                      : <>可插入變數，如 <code style={{ color: '#7dd3fc' }}>{'{{randomText}}'}</code></>}
                </div>
              </Field>
            )}

            {/* Code node body */}
            {selectedNode.action.type === 'code' && (
              <div style={{ width: '100%' }}>
                <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase' }}>
                  程式碼
                </span>
                <textarea
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  spellCheck={false}
                  style={{
                    display: 'block',
                    width: '100%',
                    minHeight: 240,
                    resize: 'vertical',
                    marginTop: 4,
                    padding: '8px 10px',
                    background: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: 5,
                    color: '#e2e8f0',
                    fontSize: 12,
                    lineHeight: 1.5,
                    fontFamily: 'Consolas, "Courier New", monospace',
                    outline: 'none',
                    boxSizing: 'border-box',
                    tabSize: 2,
                  }}
                />
                <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
                  可用 <code style={{ color: '#7dd3fc' }}>page</code>、
                  <code style={{ color: '#7dd3fc' }}>expect</code>、
                  <code style={{ color: '#7dd3fc' }}>vars</code>（如 <code style={{ color: '#7dd3fc' }}>vars.account</code>）
                </div>
              </div>
            )}

            {/* callFlow: Profile Mapping */}
            {showMappingSection && (
              <div style={{ width: '100%', marginTop: 8 }}>
                <div style={{
                  fontSize: 11, color: '#64748b', fontWeight: 600,
                  textTransform: 'uppercase', marginBottom: 8, letterSpacing: '0.05em',
                }}>
                  配置對應
                </div>
                {subFlowLoading ? (
                  <div style={{ fontSize: 12, color: '#64748b' }}>載入中…</div>
                ) : (
                  <>
                    <div style={{
                      display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6,
                      marginBottom: 4,
                    }}>
                      <div style={{ fontSize: 10, color: '#475569', fontWeight: 600, textTransform: 'uppercase' }}>父流程配置</div>
                      <div style={{ fontSize: 10, color: '#475569', fontWeight: 600, textTransform: 'uppercase' }}>子流程套用配置</div>
                    </div>
                    {parentProfiles.map((pp) => (
                      <div
                        key={pp.id}
                        style={{
                          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6,
                          alignItems: 'center', marginBottom: 5,
                        }}
                      >
                        <div style={{
                          fontSize: 12, color: '#cbd5e1',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {pp.name}
                        </div>
                        <select
                          value={profileMapping[pp.id] ?? (subFlowProfiles[0]?.id ?? '')}
                          onChange={(e) => setProfileMapping((prev) => ({
                            ...prev,
                            [pp.id]: e.target.value || null,
                          }))}
                          style={{
                            background: '#0f172a', color: '#e2e8f0',
                            border: '1px solid #334155', borderRadius: 4,
                            padding: '3px 6px', fontSize: 12, cursor: 'pointer', width: '100%',
                          }}
                        >
                          {subFlowProfiles.map((sp) => (
                            <option key={sp.id} value={sp.id}>{sp.name}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Button tone="primary" size="sm" onClick={() => void saveNode()}>
                儲存
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 140 }}>
      <FieldLabel
        style={{ fontSize: 11, color: token.textMuted, fontWeight: 600, textTransform: 'uppercase', marginBottom: 0 }}
      >
        {label}
      </FieldLabel>
      {children}
    </div>
  )
}
