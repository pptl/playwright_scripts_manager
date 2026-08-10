/**
 * Typed mirror of the custom properties defined in tokens.css.
 *
 * Every value is a `var(--ft-…)` reference, not a hex literal — so inline style
 * objects stay type-safe while the actual colour lives in one place. Adding a
 * token means adding it to BOTH files; there is no generation step, and this
 * pairing is the only thing that keeps them honest.
 */
export const token = {
  // surfaces
  bgPage: 'var(--ft-bg-page)',
  bgPanel: 'var(--ft-bg-panel)',
  bgHover: 'var(--ft-bg-hover)',
  bgSelected: 'var(--ft-bg-selected)',
  bgDisabled: 'var(--ft-bg-disabled)',

  // borders
  borderSubtle: 'var(--ft-border-subtle)',
  border: 'var(--ft-border)',
  borderStrong: 'var(--ft-border-strong)',

  // text
  text: 'var(--ft-text)',
  textHeading: 'var(--ft-text-heading)',
  textBody: 'var(--ft-text-body)',
  textSecondary: 'var(--ft-text-secondary)',
  textMuted: 'var(--ft-text-muted)',
  textDisabled: 'var(--ft-text-disabled)',
  textOnAccent: 'var(--ft-text-on-accent)',

  // accents
  accent: 'var(--ft-accent)',
  accentFg: 'var(--ft-accent-fg)',
  accentDark: 'var(--ft-accent-dark)',
  accentAlt: 'var(--ft-accent-alt)',
  accentAltFg: 'var(--ft-accent-alt-fg)',
  accentAltSoft: 'var(--ft-accent-alt-soft)',

  danger: 'var(--ft-danger)',
  dangerFg: 'var(--ft-danger-fg)',
  dangerDark: 'var(--ft-danger-dark)',

  success: 'var(--ft-success)',
  successFg: 'var(--ft-success-fg)',
  successDark: 'var(--ft-success-dark)',
  successBg: 'var(--ft-success-bg)',

  warning: 'var(--ft-warning)',
  warningFg: 'var(--ft-warning-fg)',
  warningDark: 'var(--ft-warning-dark)',

  /** Environment-profile amber. Lighter than warningFg and a different meaning. */
  profileFg: 'var(--ft-profile-fg)',

  // overlay
  backdrop: 'var(--ft-backdrop)',
} as const

/**
 * Layering scale. Numeric rather than `var()` because React's `zIndex` is compared
 * and arithmetic'd in a few places, and a string would silently break that.
 * Keep in sync with the --ft-z-* properties in tokens.css.
 */
export const zIndex = {
  menu: 1000,
  modal: 2000,
  popover: 2100,
  dialog: 3000,
  vault: 3500,
  confirm: 4000,
} as const

/** Corner radii used across the app. */
export const radius = {
  sm: 4,
  md: 6,
  lg: 12,
} as const
