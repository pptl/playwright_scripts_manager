import React, { useState } from 'react'

interface ExtractSubflowModalProps {
  selectedCount: number
  entryNodeDescription: string
  exitNodeDescription: string
  onConfirm: (name: string) => void
  onClose: () => void
}

export function ExtractSubflowModal({
  selectedCount,
  entryNodeDescription,
  exitNodeDescription,
  onConfirm,
  onClose,
}: ExtractSubflowModalProps) {
  const [name, setName] = useState('')

  const handleConfirm = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    onConfirm(trimmed)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleConfirm()
    if (e.key === 'Escape') onClose()
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
        zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        style={{
          background: '#1e293b',
          border: '1px solid #334155',
          borderRadius: 12,
          padding: 24,
          width: 400,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <h3 style={{ margin: 0, color: '#f1f5f9', fontSize: 16 }}>另存為子流程</h3>

        <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.6 }}>
          <div>將選取的 <span style={{ color: '#f1f5f9', fontWeight: 600 }}>{selectedCount}</span> 個節點萃取為子流程</div>
          <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: '60px 1fr', gap: '2px 8px' }}>
            <span style={{ color: '#64748b' }}>入口：</span>
            <span style={{ color: '#e2e8f0' }}>{entryNodeDescription || '—'}</span>
            <span style={{ color: '#64748b' }}>出口：</span>
            <span style={{ color: '#e2e8f0' }}>{exitNodeDescription || '—'}</span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: 12, color: '#94a3b8' }}>子流程名稱</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="輸入名稱..."
            style={{
              background: '#0f172a',
              border: '1px solid #334155',
              borderRadius: 6,
              color: '#f1f5f9',
              padding: '8px 10px',
              fontSize: 14,
              outline: 'none',
            }}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: '1px solid #334155',
              borderRadius: 6,
              color: '#94a3b8',
              padding: '6px 16px',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            disabled={!name.trim()}
            style={{
              background: name.trim() ? '#6366f1' : '#334155',
              border: 'none',
              borderRadius: 6,
              color: name.trim() ? '#fff' : '#64748b',
              padding: '6px 16px',
              cursor: name.trim() ? 'pointer' : 'default',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            確認另存
          </button>
        </div>
      </div>
    </div>
  )
}
