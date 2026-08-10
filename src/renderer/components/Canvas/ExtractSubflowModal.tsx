import React, { useState } from 'react'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { Input, FieldLabel } from '../common/Input'
import { token } from '../../styles/tokens'

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
  }

  return (
    <Modal
      title="另存為子流程"
      width={400}
      onClose={onClose}
      footer={
        <>
          <Button tone="subtle" size="md" onClick={onClose}>
            取消
          </Button>
          <Button tone="primaryAlt" size="md" onClick={handleConfirm} disabled={!name.trim()}>
            確認另存
          </Button>
        </>
      }
    >
      <div style={{ fontSize: 13, color: token.textSecondary, lineHeight: 1.6, marginBottom: 16 }}>
        <div>
          將選取的 <span style={{ color: token.textHeading, fontWeight: 600 }}>{selectedCount}</span> 個節點萃取為子流程
        </div>
        <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: '60px 1fr', gap: '2px 8px' }}>
          <span style={{ color: token.textMuted }}>入口：</span>
          <span style={{ color: token.text }}>{entryNodeDescription || '—'}</span>
          <span style={{ color: token.textMuted }}>出口：</span>
          <span style={{ color: token.text }}>{exitNodeDescription || '—'}</span>
        </div>
      </div>

      <FieldLabel>子流程名稱</FieldLabel>
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="輸入名稱..."
        style={{ fontSize: 14, color: token.textHeading }}
      />
    </Modal>
  )
}
