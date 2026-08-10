import React, { useEffect } from 'react'
import { token, zIndex, radius } from '../../styles/tokens'

/**
 * The one modal shell. Modelled on ConfirmDialog, which was the only one of the
 * thirteen hand-rolled modals that got the behaviour right.
 *
 * Two variants, matching the two shapes that were actually in use:
 *
 *  - `compact` — padding 24, text title, no bordered header. The small "type a
 *    name and confirm" dialogs.
 *  - `panel`   — fixed `width`, bordered header with a ✕, maxHeight 80vh with a
 *    scrolling body, bordered footer. The big editors.
 *
 * Both get Escape-to-close and backdrop-click-to-close. Previously only two of
 * thirteen closed on a backdrop click and only ConfirmDialog had a real
 * window-level Escape listener — the rest hung `onKeyDown` on a single <input>,
 * which silently stopped working the moment focus moved anywhere else.
 *
 * Note there is deliberately NO unsaved-changes guard here. Per CLAUDE.md the
 * draft-guard layer was removed on purpose: closing a modal drops whatever was
 * typed but not saved. Do not reintroduce it.
 */

interface BaseProps {
  onClose: () => void
  children: React.ReactNode
  /** Footer content, rendered right-aligned. Usually <Button>s. */
  footer?: React.ReactNode
  /** Stacking level. Defaults per variant; override only to sit above another modal. */
  z?: number
  /** Set false for modals that must not vanish on a stray backdrop click. */
  closeOnBackdrop?: boolean
  /** Set false where Escape already means something else inside the modal. */
  closeOnEscape?: boolean
  /** Applied to the element wrapping `children`. For panel this is the scroll area. */
  bodyStyle?: React.CSSProperties
  /** Applied to the card itself — e.g. to sit the card on the page ground instead of the panel one. */
  cardStyle?: React.CSSProperties
}

interface CompactProps extends BaseProps {
  variant?: 'compact'
  title: string
  /** Sub-title line under the title. */
  subtitle?: React.ReactNode
  minWidth?: number
  maxWidth?: number | string
  width?: number
}

interface PanelProps extends BaseProps {
  variant: 'panel'
  title: React.ReactNode
  width: number
  /** Extra content in the header, left of the ✕ (e.g. a status pill). */
  headerExtra?: React.ReactNode
}

export type ModalProps = CompactProps | PanelProps

export function Modal(props: ModalProps) {
  const { onClose, children, footer, closeOnBackdrop = true, closeOnEscape = true, bodyStyle, cardStyle } = props
  const isPanel = props.variant === 'panel'
  const z = props.z ?? (isPanel ? zIndex.modal : zIndex.dialog)

  // Capturing listener so it fires before anything inside the modal swallows the key.
  useEffect(() => {
    if (!closeOnEscape) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [closeOnEscape, onClose])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: token.backdrop,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: z,
      }}
      onMouseDown={closeOnBackdrop ? onClose : undefined}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: token.bgPanel,
          border: `1px solid ${token.border}`,
          borderRadius: radius.lg,
          ...(isPanel
            ? {
                width: props.width,
                maxHeight: '80vh',
                display: 'flex',
                flexDirection: 'column' as const,
                overflow: 'hidden',
              }
            : {
                padding: 24,
                width: (props as CompactProps).width,
                minWidth: (props as CompactProps).minWidth ?? 320,
                maxWidth: (props as CompactProps).maxWidth,
              }),
          // Merged last so a caller can override the surface colour or sizing.
          ...cardStyle,
        }}
      >
        {isPanel ? (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '14px 20px',
                borderBottom: `1px solid ${token.border}`,
                flexShrink: 0,
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 600, color: token.text }}>{props.title}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {props.headerExtra}
                <button onClick={onClose} className="ft-icon-btn" style={closeGlyphStyle} title="關閉">
                  ✕
                </button>
              </div>
            </div>
            <div style={{ flex: 1, overflow: 'auto', minHeight: 0, ...bodyStyle }}>{children}</div>
            {footer && (
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  justifyContent: 'flex-end',
                  alignItems: 'center',
                  padding: '12px 20px',
                  borderTop: `1px solid ${token.border}`,
                  flexShrink: 0,
                }}
              >
                {footer}
              </div>
            )}
          </>
        ) : (
          <>
            <h2 style={{ fontSize: 16, color: token.text, margin: '0 0 6px' }}>{props.title}</h2>
            {(props as CompactProps).subtitle && (
              <div style={{ fontSize: 12, color: token.textMuted, marginBottom: 14, lineHeight: 1.6 }}>
                {(props as CompactProps).subtitle}
              </div>
            )}
            {bodyStyle ? <div style={bodyStyle}>{children}</div> : children}
            {footer && (
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>{footer}</div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

const closeGlyphStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: token.textMuted,
  fontSize: 18,
  lineHeight: 1,
  cursor: 'pointer',
  padding: '2px 6px',
  borderRadius: radius.sm,
}
