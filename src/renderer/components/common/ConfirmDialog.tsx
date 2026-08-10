import { useEffect, useRef } from 'react'
import { useConfirmStore, type ConfirmAction } from '../../stores/confirmStore'
import { token, zIndex, radius } from '../../styles/tokens'
import { Button, type ButtonTone } from './Button'

/**
 * Renders confirm requests raised via `confirm()`.
 * Mounted exactly once, at the end of App.tsx.
 *
 * `zIndex.confirm` is the top of the scale — above the panel modals
 * (ProfileEditorModal, ProjectEnvVarModal) and the compact dialogs
 * (FlowList, GroupNameModal), so it can be raised from inside any of them.
 *
 * This deliberately does NOT use the shared <Modal>: Enter has to resolve to the
 * request's own `defaultActionId` (which is 取消 on danger dialogs), and the
 * focus handling is queue-aware. <Modal> was modelled on this component, not the
 * other way round.
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
        background: token.backdrop,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: zIndex.confirm,
      }}
      onMouseDown={() => answer(null)}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: token.bgPanel,
          border: `1px solid ${token.border}`,
          borderRadius: radius.lg,
          padding: 24,
          minWidth: 340,
          maxWidth: 460,
        }}
      >
        <h2 style={{ fontSize: 16, color: token.text, margin: '0 0 6px' }}>{front.title}</h2>
        {front.message && (
          <div style={{ fontSize: 13, color: token.textBody, marginBottom: front.detail ? 6 : 16, lineHeight: 1.6 }}>
            {front.message}
          </div>
        )}
        {front.detail && (
          <div style={{ fontSize: 12, color: token.textMuted, marginBottom: 16, lineHeight: 1.6 }}>{front.detail}</div>
        )}
        {!front.message && !front.detail && <div style={{ marginBottom: 16 }} />}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {actions.map((a) => (
            <Button
              key={a.id}
              ref={a.id === front.defaultActionId ? defaultBtnRef : undefined}
              onClick={() => answer(a.id)}
              tone={CONFIRM_TONE[a.tone ?? 'ghost']}
            >
              {a.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** confirmStore's tone vocabulary predates Button's; `primary` here has always been indigo. */
const CONFIRM_TONE: Record<NonNullable<ConfirmAction['tone']>, ButtonTone> = {
  primary: 'primaryAlt',
  danger: 'danger',
  ghost: 'ghost',
}
