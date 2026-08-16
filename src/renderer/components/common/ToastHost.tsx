import { useErrorStore, type ToastTone } from '../../stores/errorStore'
import { token, zIndex, radius } from '../../styles/tokens'

/**
 * Renders the toasts raised via `reportError()`.
 * Mounted exactly once per App.tsx branch, alongside <ConfirmHost />.
 *
 * Bottom-right and non-blocking, because these report failures that land while the
 * user is doing something else — dragging a node, watching a replay. `zIndex.toast`
 * is above `zIndex.confirm` so a background failure is still visible with a dialog
 * open; the corner never covers the centred card.
 *
 * Nothing here dismisses itself on a timer. See errorStore for why.
 */
export function ToastHost() {
  const toasts = useErrorStore((s) => s.toasts)
  const dismiss = useErrorStore((s) => s.dismiss)
  const clearAll = useErrorStore((s) => s.clearAll)

  if (!toasts.length) return null

  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: zIndex.toast,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 380,
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          style={{
            background: token.bgPanel,
            border: `1px solid ${TONE_BORDER[t.tone]}`,
            borderLeft: `4px solid ${TONE_BORDER[t.tone]}`,
            borderRadius: radius.md,
            padding: '10px 12px',
            boxShadow: '0 4px 16px rgba(0, 0, 0, 0.45)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <span style={{ fontSize: 13, flexShrink: 0 }}>{TONE_ICON[t.tone]}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: TONE_TEXT[t.tone] }}>
                {t.title}
                {t.count > 1 && (
                  <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 400, color: token.textMuted }}>
                    ×{t.count}
                  </span>
                )}
              </div>
              {t.detail && (
                <div
                  style={{
                    fontSize: 11,
                    color: token.textSecondary,
                    marginTop: 4,
                    lineHeight: 1.5,
                    // Long Playwright errors are multi-line and can be very long; keep the
                    // toast a fixed size and let the user scroll the one they care about.
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: 96,
                    overflowY: 'auto',
                  }}
                >
                  {t.detail}
                </div>
              )}
            </div>
            <button
              className="ft-icon-btn"
              onClick={() => dismiss(t.id)}
              title="關閉"
              style={{
                background: 'none',
                border: 'none',
                color: token.textMuted,
                cursor: 'pointer',
                fontSize: 13,
                lineHeight: 1,
                padding: 2,
                borderRadius: radius.sm,
                flexShrink: 0,
              }}
            >
              ✕
            </button>
          </div>
        </div>
      ))}

      {toasts.length > 1 && (
        <button
          className="ft-icon-btn"
          onClick={clearAll}
          style={{
            alignSelf: 'flex-end',
            background: 'none',
            border: 'none',
            color: token.textMuted,
            cursor: 'pointer',
            fontSize: 11,
            padding: '2px 6px',
            borderRadius: radius.sm,
          }}
        >
          全部清除
        </button>
      )}
    </div>
  )
}

const TONE_BORDER: Record<ToastTone, string> = {
  error: token.danger,
  warning: token.warning,
}

const TONE_TEXT: Record<ToastTone, string> = {
  error: token.dangerFg,
  warning: token.warningFg,
}

const TONE_ICON: Record<ToastTone, string> = {
  error: '⛔',
  warning: '⚠',
}
