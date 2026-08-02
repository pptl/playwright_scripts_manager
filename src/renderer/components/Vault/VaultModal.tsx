import React, { useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspaceStore'

/**
 * The one dialog for every vault gesture: creating the vault, unlocking it, and
 * changing the passphrase. They share the same fields and the same failure modes,
 * so splitting them into three components would only duplicate the styling.
 */
export type VaultModalMode = 'setup' | 'unlock' | 'change'

interface VaultModalProps {
  mode: VaultModalMode
  /** Why the dialog opened, when an operation triggered it rather than the user. */
  reason?: string
  onClose: () => void
  onDone?: () => void
}

const TITLES: Record<VaultModalMode, string> = {
  setup: '🔐 建立私密資料保險庫',
  unlock: '🔐 解鎖私密資料',
  change: '🔐 變更通行碼',
}

const input: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '8px 10px',
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 6,
  color: '#e2e8f0',
  fontSize: 13,
  outline: 'none',
  marginBottom: 10,
  boxSizing: 'border-box',
}

const label: React.CSSProperties = { fontSize: 11, color: '#94a3b8', marginBottom: 4 }

export function VaultModal({ mode, reason, onClose, onDone }: VaultModalProps) {
  const setVault = useWorkspaceStore((s) => s.setVault)
  const canRemember = useWorkspaceStore((s) => s.vault?.canRemember ?? false)

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const needsCurrent = mode === 'unlock' || mode === 'change'
  const needsNew = mode === 'setup' || mode === 'change'

  const submit = async () => {
    setError('')
    if (needsCurrent && !current) return setError('請輸入通行碼')
    if (needsNew) {
      if (!next) return setError('請輸入新通行碼')
      if (next.length < 8) return setError('通行碼至少需要 8 個字元')
      if (next !== confirm) return setError('兩次輸入的通行碼不一致')
    }

    setBusy(true)
    try {
      if (mode === 'setup') {
        setVault(await window.electronAPI.setupVault(next))
      } else if (mode === 'unlock') {
        const { ok, status } = await window.electronAPI.unlockVault(current)
        setVault(status)
        if (!ok) return setError('通行碼錯誤')
      } else {
        // Re-encrypts every stored secret before committing, so a failure here leaves
        // the old passphrase still working.
        const { ok, status } = await window.electronAPI.changeVaultPassphrase(current, next)
        setVault(status)
        if (!ok) return setError('目前的通行碼錯誤')
      }
      onDone?.()
      onClose()
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !busy) submit()
    if (e.key === 'Escape') onClose()
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 3500,
      }}
    >
      <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 24, width: 400 }}>
        <h2 style={{ fontSize: 16, color: '#e2e8f0', margin: '0 0 6px' }}>{TITLES[mode]}</h2>

        {reason ? (
          <div style={{ fontSize: 12, color: '#fbbf24', marginBottom: 12 }}>{reason}</div>
        ) : null}

        {mode === 'setup' ? (
          <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.6, marginBottom: 14 }}>
            被標記為私密的變數會用這組通行碼加密後才寫入檔案，因此可以安全地進 git。
            同事 clone 之後輸入同一組通行碼就能使用。
            <div style={{ color: '#f87171', marginTop: 6 }}>
              ⚠ 通行碼遺失將無法復原任何私密資料，請自行妥善保管。
            </div>
          </div>
        ) : null}

        {mode === 'change' ? (
          <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.6, marginBottom: 14 }}>
            所有已儲存的私密資料都會用新通行碼重新加密。
          </div>
        ) : null}

        {needsCurrent ? (
          <>
            <div style={label}>{mode === 'change' ? '目前的通行碼' : '通行碼'}</div>
            <input
              autoFocus
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              onKeyDown={onKeyDown}
              style={input}
            />
          </>
        ) : null}

        {needsNew ? (
          <>
            <div style={label}>{mode === 'change' ? '新通行碼' : '通行碼'}（至少 8 字元）</div>
            <input
              autoFocus={mode === 'setup'}
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              onKeyDown={onKeyDown}
              style={input}
            />
            <div style={label}>再次輸入</div>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={onKeyDown}
              style={input}
            />
          </>
        ) : null}

        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 14 }}>
          {canRemember
            ? '✓ 通行碼會由作業系統金鑰圈記住，這台機器只需輸入一次。'
            : '⚠ 此系統無法使用金鑰圈，每次啟動都需要重新輸入。'}
        </div>

        {error ? (
          <div style={{ fontSize: 12, color: '#f87171', marginBottom: 12 }}>{error}</div>
        ) : null}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            disabled={busy}
            style={{
              padding: '6px 16px',
              borderRadius: 6,
              border: '1px solid #475569',
              background: 'transparent',
              color: '#94a3b8',
              cursor: busy ? 'default' : 'pointer',
              fontSize: 12,
            }}
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={busy}
            style={{
              padding: '6px 16px',
              borderRadius: 6,
              border: 'none',
              background: busy ? '#4c4f8a' : '#6366f1',
              color: '#fff',
              cursor: busy ? 'default' : 'pointer',
              fontSize: 12,
            }}
          >
            {busy ? '處理中…' : mode === 'setup' ? '建立' : mode === 'unlock' ? '解鎖' : '變更'}
          </button>
        </div>
      </div>
    </div>
  )
}
