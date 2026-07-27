import React from 'react'

interface DirtyBadgeProps {
  isDirty: boolean
  /** The underlying store value changed while the draft was dirty (recorder, replay, another surface). */
  isStale?: boolean
}

/** Amber "unsaved" pill shown next to a draft form's 儲存 button. */
export function DirtyBadge({ isDirty, isStale }: DirtyBadgeProps) {
  if (!isDirty) return null
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          fontSize: 11,
          color: '#fbbf24',
          background: 'rgba(251,191,36,0.12)',
          border: '1px solid rgba(251,191,36,0.35)',
          borderRadius: 10,
          padding: '2px 8px',
          whiteSpace: 'nowrap',
        }}
      >
        ● 未儲存
      </span>
      {isStale && (
        <span
          style={{ fontSize: 11, color: '#f87171', whiteSpace: 'nowrap' }}
          title="此資料已在別處被更新，儲存將以你的編輯為準"
        >
          ⚠ 外部已更新
        </span>
      )}
    </span>
  )
}
