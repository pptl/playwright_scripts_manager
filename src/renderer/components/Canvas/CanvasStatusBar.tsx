import React from 'react'

interface CanvasStatusBarProps {
  selectedCount: number
}

export function CanvasStatusBar({ selectedCount }: CanvasStatusBarProps) {
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
        padding: '4px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 13,
        color: '#94a3b8',
        whiteSpace: 'nowrap',
      }}
    >
      <span>已選取 {selectedCount} 個節點</span>
    </div>
  )
}
