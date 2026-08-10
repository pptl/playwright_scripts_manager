import React from 'react'
import { token, radius } from '../../styles/tokens'

/**
 * The pieces the two variable tables (ProfileEditorModal / ProjectEnvVarModal) had
 * byte-identical copies of. Nothing here knows what a row means — the tables keep
 * their own JSX because their columns genuinely differ (5 with 敘述 vs 4 with the
 * reserved `domain` row), and folding those differences into a props-driven table
 * would hide two real special cases behind one abstraction.
 */

export const cellInputStyle: React.CSSProperties = {
  padding: '4px 8px',
  background: token.bgPage,
  border: `1px solid ${token.borderSubtle}`,
  borderRadius: radius.sm,
  color: token.text,
  fontSize: 12,
  outline: 'none',
  width: '100%',
  transition: 'border-color 0.15s',
}

/** Amber border marking a private field. One-off rather than a design token: it exists
 *  only to mark the 🔐 affordance in these two tables. */
export const SECRET_FIELD_BORDER = '#a16207'

/** The grid that both a header row and a data row are laid out on. */
export const varHeaderStyle = (gridCols: string): React.CSSProperties => ({
  display: 'grid',
  gridTemplateColumns: gridCols,
  gap: 8,
  padding: '4px 16px 8px',
  borderBottom: `1px solid ${token.bgPage}`,
})

export const varRowStyle = (gridCols: string): React.CSSProperties => ({
  display: 'grid',
  gridTemplateColumns: gridCols,
  gap: 8,
  padding: '5px 16px',
  alignItems: 'center',
})

/** 🔐 — marks a row's value as private (encrypted at rest). */
export function SecretToggleButton({
  secret,
  title,
  onClick,
}: {
  secret: boolean
  title: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        fontSize: 13,
        padding: 2,
        opacity: secret ? 1 : 0.3,
        filter: secret ? undefined : 'grayscale(1)',
      }}
    >
      🔐
    </button>
  )
}

/** 🗑 — removes the row from the draft (the store only hears about it on 儲存). */
export function DeleteRowButton({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        color: token.dangerFg,
        fontSize: 16,
        padding: '2px',
        borderRadius: 3,
        lineHeight: 1,
        opacity: 0.7,
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '1' }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.7' }}
    >
      🗑
    </button>
  )
}

export function TableEmptyState({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '16px', color: token.textMuted, fontSize: 12 }}>{children}</div>
}
