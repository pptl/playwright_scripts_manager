import React from 'react'
import { token, radius } from '../../styles/tokens'

/**
 * The text field shape that was duplicated near-verbatim in at least six places
 * (Toolbar, FlowList, PropertyPanel, GroupNameModal, ExtractSubflowModal, AddNodeModal).
 *
 * The `.ft-input` class carries the focus ring — previously there was none,
 * because without a stylesheet there was no `:focus` to hang it on.
 */
interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'style'> {
  /** Renders a full-width block field with a bottom margin, as used inside dialogs. */
  block?: boolean
  style?: React.CSSProperties
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { block = true, style, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={['ft-input', className].filter(Boolean).join(' ')}
      style={{
        ...(block ? { display: 'block', width: '100%' } : {}),
        padding: '8px 10px',
        background: token.bgPage,
        border: `1px solid ${token.border}`,
        borderRadius: radius.md,
        color: token.text,
        fontSize: 13,
        outline: 'none',
        ...style,
      }}
      {...rest}
    />
  )
})

/** Small caption above a field. */
export function FieldLabel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <label style={{ display: 'block', fontSize: 12, color: token.textSecondary, marginBottom: 6, ...style }}>
      {children}
    </label>
  )
}
