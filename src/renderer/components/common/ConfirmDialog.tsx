import React, { useEffect, useRef } from 'react'
import { useConfirmStore, type ConfirmAction } from '../../stores/confirmStore'

/**
 * Renders confirm requests raised via `confirm()` / `confirmDiscard()`.
 * Mounted exactly once, at the end of App.tsx.
 *
 * zIndex 4000 sits above the 2000-level modals (ProfileEditorModal, ProjectEnvVarModal)
 * and the 3000-level dialogs (FlowList, GroupNameModal) so it can be raised from inside them.
 */
export function ConfirmHost() {
  const queue = useConfirmStore((s) => s.queue)
  const answer = useConfirmStore((s) => s.answer)
  const front = queue[0]
  const defaultBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!front) return
    defaultBtnRef.current?.focus()
  }, [front?.id])

  useEffect(() => {
    if (!front) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        answer(null)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        answer(front.defaultActionId ?? null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [front?.id, front?.defaultActionId, answer])

  if (!front) return null

  const actions: ConfirmAction[] = front.actions ?? [
    { id: 'cancel', label: '取消', tone: 'ghost' },
    { id: 'ok', label: '確認', tone: 'primary' },
  ]

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 4000,
      }}
      onMouseDown={() => answer(null)}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: '#1e293b',
          border: '1px solid #334155',
          borderRadius: 12,
          padding: 24,
          minWidth: 340,
          maxWidth: 460,
        }}
      >
        <h2 style={{ fontSize: 16, color: '#e2e8f0', margin: '0 0 6px' }}>{front.title}</h2>
        {front.message && (
          <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: front.detail ? 6 : 16, lineHeight: 1.6 }}>
            {front.message}
          </div>
        )}
        {front.detail && (
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 16, lineHeight: 1.6 }}>{front.detail}</div>
        )}
        {!front.message && !front.detail && <div style={{ marginBottom: 16 }} />}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {actions.map((a) => (
            <button
              key={a.id}
              ref={a.id === front.defaultActionId ? defaultBtnRef : undefined}
              onClick={() => answer(a.id)}
              style={{
                padding: '6px 16px',
                borderRadius: 6,
                fontSize: 12,
                cursor: 'pointer',
                ...(a.tone === 'danger'
                  ? { border: 'none', background: '#dc2626', color: '#fff' }
                  : a.tone === 'primary'
                    ? { border: 'none', background: '#6366f1', color: '#fff' }
                    : { border: '1px solid #475569', background: 'transparent', color: '#94a3b8' }),
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
