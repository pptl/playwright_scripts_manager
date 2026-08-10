import React from 'react'
import { token, radius } from '../../styles/tokens'

/**
 * Replaces three competing button "systems" that had drifted apart:
 * Toolbar's cancel/confirm pair, ExtractSubflowModal's, and ConfirmDialog's
 * `tone` union — same role, three sets of colours, paddings and borders.
 *
 * `tone` matches ConfirmDialog's vocabulary, which was already the most
 * considered of the three. `accent` vs `accentAlt` reflects the unresolved
 * blue/indigo split documented in tokens.css — pick the one the surrounding
 * screen already uses rather than "fixing" it here.
 */
export type ButtonTone = 'primary' | 'primaryAlt' | 'danger' | 'ghost' | 'subtle'
export type ButtonSize = 'sm' | 'md'

interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  tone?: ButtonTone
  size?: ButtonSize
  style?: React.CSSProperties
}

const SIZES: Record<ButtonSize, React.CSSProperties> = {
  sm: { padding: '6px 16px', fontSize: 12 },
  md: { padding: '7px 18px', fontSize: 13 },
}

function toneStyle(tone: ButtonTone, disabled: boolean): React.CSSProperties {
  if (disabled) {
    return { border: 'none', background: token.bgDisabled, color: token.textDisabled }
  }
  switch (tone) {
    case 'primary':
      return { border: 'none', background: token.accent, color: token.textOnAccent, fontWeight: 600 }
    case 'primaryAlt':
      return { border: 'none', background: token.accentAlt, color: token.textOnAccent, fontWeight: 600 }
    case 'danger':
      return { border: 'none', background: token.danger, color: token.textOnAccent, fontWeight: 600 }
    case 'subtle':
      return { border: `1px solid ${token.border}`, background: 'transparent', color: token.textSecondary }
    case 'ghost':
    default:
      return { border: `1px solid ${token.borderStrong}`, background: 'transparent', color: token.textSecondary }
  }
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { tone = 'ghost', size = 'sm', style, disabled, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled}
      className={['ft-btn', className].filter(Boolean).join(' ')}
      style={{
        borderRadius: radius.md,
        cursor: disabled ? 'not-allowed' : 'pointer',
        ...SIZES[size],
        ...toneStyle(tone, !!disabled),
        ...style,
      }}
      {...rest}
    />
  )
})
