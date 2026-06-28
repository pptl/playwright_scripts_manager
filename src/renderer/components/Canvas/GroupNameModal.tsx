import React, { useState } from 'react'

interface GroupNameModalProps {
  selectedCount: number
  onConfirm: (name: string) => void
  onClose: () => void
}

/** Small dialog to name a new in-place group (Electron disables window.prompt). */
export function GroupNameModal({ selectedCount, onConfirm, onClose }: GroupNameModalProps) {
  const [name, setName] = useState('群組')

  const confirm = () => {
    onConfirm(name.trim() || '群組')
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 3000,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 24, minWidth: 320 }}>
        <h2 style={{ fontSize: 16, color: '#e2e8f0', margin: '0 0 6px' }}>組成群組</h2>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 14 }}>
          將選取的 {selectedCount} 個節點折疊為一個群組
        </div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') confirm()
            if (e.key === 'Escape') onClose()
          }}
          placeholder="群組名稱"
          style={{
            display: 'block',
            width: '100%',
            padding: '8px 10px',
            background: '#0f172a',
            border: '1px solid #334155',
            borderRadius: 6,
            color: '#e2e8f0',
            fontSize: 13,
            outline: 'none',
            marginBottom: 16,
            boxSizing: 'border-box',
          }}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{
              padding: '6px 16px',
              borderRadius: 6,
              border: '1px solid #475569',
              background: 'transparent',
              color: '#94a3b8',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            取消
          </button>
          <button
            onClick={confirm}
            style={{
              padding: '6px 16px',
              borderRadius: 6,
              border: 'none',
              background: '#6366f1',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            建立
          </button>
        </div>
      </div>
    </div>
  )
}
