import React from 'react'
import { token } from '../../styles/tokens'

interface SidebarSectionProps {
  title: React.ReactNode
  /** false for the first section in the sidebar stack (no separator above it). */
  bordered?: boolean
  children: React.ReactNode
}

/** The container + header shape all 4 right-sidebar lists (VariableList, ProfileVarList,
 *  ProjectEnvVarList, SessionVarList) duplicated independently. */
export function SidebarSection({ title, bordered = true, children }: SidebarSectionProps) {
  return (
    <div
      style={{
        background: token.bgPanel,
        ...(bordered ? { borderTop: `1px solid ${token.border}` } : {}),
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        maxHeight: 220,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '12px 14px',
          borderBottom: `1px solid ${token.border}`,
          fontSize: 12,
          color: token.textMuted,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
        }}
      >
        {title}
      </div>
      <div style={{ overflowY: 'auto', flex: 1 }}>{children}</div>
    </div>
  )
}
