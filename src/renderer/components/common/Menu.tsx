import React from 'react'
import { token, zIndex } from '../../styles/tokens'

/**
 * Floating menu surfaces. Three pairs of these existed, each written twice:
 *
 *  - Toolbar's environment and profile dropdowns (byte-identical style objects)
 *  - NodeContextMenu and FlowCanvas's pane menu (transparent full-screen catcher
 *    + absolutely-positioned card)
 *  - FlowList's flow and project context menus (ref + outside-click effect)
 *
 * The catcher approach won: it dismisses on any outside mousedown without a ref,
 * an effect, or a listener that has to be torn down.
 *
 * `MenuSurface` is just the card — for anchored dropdowns that position themselves
 * relative to a button. `Menu` adds the catcher and absolute positioning at a
 * point, for right-click menus.
 */

export const menuSurfaceStyle: React.CSSProperties = {
  background: token.bgPanel,
  border: `1px solid ${token.border}`,
  borderRadius: 8,
  padding: '4px 0',
  boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
}

export function MenuSurface({
  children,
  style,
}: {
  children: React.ReactNode
  style?: React.CSSProperties
}) {
  return <div style={{ ...menuSurfaceStyle, ...style }}>{children}</div>
}

export function Menu({
  x,
  y,
  onClose,
  minWidth = 180,
  children,
  z = zIndex.menu,
}: {
  x: number
  y: number
  onClose: () => void
  minWidth?: number
  children: React.ReactNode
  z?: number
}) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: z }} onMouseDown={onClose}>
      <MenuSurface style={{ position: 'absolute', left: x, top: y, minWidth }}>
        <div onMouseDown={(e) => e.stopPropagation()}>{children}</div>
      </MenuSurface>
    </div>
  )
}

interface MenuItemProps {
  icon?: string
  label: React.ReactNode
  onClick: () => void
  disabled?: boolean
  /** Renders in the danger colour — used for the delete entries. */
  danger?: boolean
  /** Renders in the indigo accent — used for entries that create a sub-flow reference. */
  accent?: boolean
  title?: string
}

export function MenuItem({ icon, label, onClick, disabled, danger, accent, title }: MenuItemProps) {
  const color = disabled
    ? token.textDisabled
    : danger
      ? token.dangerFg
      : accent
        ? token.accentAltSoft
        : token.textBody
  return (
    <div
      className={disabled ? undefined : 'ft-menu-item'}
      title={title}
      onClick={disabled ? undefined : onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 12px',
        fontSize: 13,
        cursor: disabled ? 'not-allowed' : 'pointer',
        color,
      }}
    >
      {icon && <span style={{ width: 14, textAlign: 'center', flexShrink: 0 }}>{icon}</span>}
      <span>{label}</span>
    </div>
  )
}

/** Small uppercase caption separating groups of items. */
export function MenuCaption({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: '4px 12px 6px',
        fontSize: 10,
        color: token.textMuted,
        borderBottom: `1px solid ${token.border}`,
        marginBottom: 2,
      }}
    >
      {children}
    </div>
  )
}

export function MenuDivider() {
  return <div style={{ height: 1, background: token.border, margin: '4px 0' }} />
}
