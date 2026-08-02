import React, { useEffect, useState } from 'react'
import { SECRET_MASK } from '@shared/types'

interface SecretValueProps {
  /** The stored value — ciphertext for private entries, plaintext otherwise. */
  value: string
  secret?: boolean
  /** Shown when a non-private value is empty. */
  emptyText?: string
  style?: React.CSSProperties
}

/**
 * Read-only display of a value that may be private: masked by default, with a 👁 that
 * fetches the single plaintext over IPC. The renderer never holds the vault key, so a
 * reveal is always an explicit round trip rather than a local decrypt.
 */
export function SecretValue({ value, secret, emptyText = '(空)', style }: SecretValueProps) {
  const [revealed, setRevealed] = useState<string | null>(null)
  const [error, setError] = useState(false)

  // Re-mask whenever the underlying value changes — switching rows must never carry a
  // previously revealed plaintext across.
  useEffect(() => {
    setRevealed(null)
    setError(false)
  }, [value])

  if (!secret) {
    return <span style={style}>{value || emptyText}</span>
  }

  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (revealed !== null) return setRevealed(null)
    try {
      setRevealed(await window.electronAPI.revealSecret(value))
      setError(false)
    } catch {
      // Locked vault — nothing to show, so say so rather than failing silently.
      setError(true)
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, ...style }}>
      <span
        style={{
          fontFamily: revealed !== null ? undefined : 'monospace',
          color: error ? '#f87171' : undefined,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {error ? '🔒 已鎖定' : revealed !== null ? revealed || emptyText : SECRET_MASK}
      </span>
      <button
        onClick={toggle}
        title={revealed !== null ? '隱藏' : '顯示'}
        style={{
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          padding: 0,
          fontSize: 11,
          lineHeight: 1,
          opacity: 0.7,
          flexShrink: 0,
        }}
      >
        {revealed !== null ? '🙈' : '👁'}
      </button>
    </span>
  )
}
