import React from 'react'

interface NodeContextMenuProps {
  nodeId: string
  x: number
  y: number
  onClose: () => void
  onReplay: () => void
  onBranchRecord: () => void
  onDelete: () => void
  isRecording: boolean
  isReplaying: boolean
}

export function NodeContextMenu({
  x,
  y,
  onClose,
  onReplay,
  onBranchRecord,
  onDelete,
  isRecording,
  isReplaying,
}: NodeContextMenuProps) {
  const disabled = isRecording || isReplaying

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
      }}
      onMouseDown={onClose}
    >
      <div
        style={{
          position: 'absolute',
          left: x,
          top: y,
          background: '#1e293b',
          border: '1px solid #334155',
          borderRadius: 8,
          padding: '4px 0',
          minWidth: 200,
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <MenuItem
          icon="▶"
          label="重播到此節點"
          disabled={disabled}
          onClick={() => {
            onClose()
            onReplay()
          }}
        />
        <MenuItem
          icon="⑂"
          label="從此節點分支錄製"
          disabled={disabled}
          onClick={() => {
            onClose()
            onBranchRecord()
          }}
        />
        <div style={{ borderTop: '1px solid #334155', margin: '4px 0' }} />
        <MenuItem
          icon="🗑"
          label="刪除此節點及其子節點"
          disabled={disabled}
          danger
          onClick={() => {
            onClose()
            onDelete()
          }}
        />
      </div>
    </div>
  )
}

function MenuItem({
  icon,
  label,
  disabled,
  danger = false,
  onClick,
}: {
  icon: string
  label: string
  disabled: boolean
  danger?: boolean
  onClick: () => void
}) {
  const color = disabled ? '#4b5563' : danger ? '#f87171' : '#e2e8f0'
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: '8px 14px',
        background: 'transparent',
        border: 'none',
        color,
        fontSize: 13,
        cursor: disabled ? 'not-allowed' : 'pointer',
        textAlign: 'left',
      }}
      onMouseEnter={(e) => {
        if (!disabled)
          (e.currentTarget as HTMLButtonElement).style.background = danger ? '#450a0a' : '#334155'
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
      }}
    >
      <span style={{ fontSize: 12, width: 16, textAlign: 'center' }}>{icon}</span>
      {label}
    </button>
  )
}
