import React from 'react'

interface SelectionToolbarProps {
  selectedCount: number
  onExtract: () => void
  onClear: () => void
}

export function SelectionToolbar({ selectedCount, onExtract, onClear }: SelectionToolbarProps) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 10,
        background: '#1e293b',
        border: '1px solid #334155',
        borderRadius: 20,
        padding: '4px 6px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 13,
        color: '#94a3b8',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ paddingLeft: 8 }}>已選取 {selectedCount} 個節點</span>
      <button
        onClick={onExtract}
        style={{
          background: '#6366f1',
          color: '#fff',
          border: 'none',
          borderRadius: 14,
          padding: '3px 12px',
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        另存為子流程
      </button>
      <button
        onClick={onClear}
        style={{
          background: 'transparent',
          color: '#64748b',
          border: 'none',
          borderRadius: 14,
          padding: '3px 8px',
          cursor: 'pointer',
          fontSize: 12,
        }}
      >
        取消
      </button>
    </div>
  )
}
