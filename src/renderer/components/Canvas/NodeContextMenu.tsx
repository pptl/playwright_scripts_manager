import React, { useState, useRef, useEffect } from 'react'

interface NodeContextMenuProps {
  nodeId: string
  x: number
  y: number
  onClose: () => void
  onReplay: () => void
  onBranchRecord: () => void
  onDelete: () => void
  onDeleteNodeOnly: () => void
  deleteOnlyLabel: string
  isRecording: boolean
  isReplaying: boolean
  hasValue: boolean
  currentCaptureAs?: string
  onCaptureAsVar: (varName: string | undefined) => void
  isRoot: boolean
  isLeaf: boolean
  onInsertCallFlowBefore: () => void
  onAppendCallFlowAfter: () => void
  showExtract: boolean
  selectedCount: number
  onExtract: () => void
}

export function NodeContextMenu({
  x,
  y,
  onClose,
  onReplay,
  onBranchRecord,
  onDelete,
  onDeleteNodeOnly,
  deleteOnlyLabel,
  isRecording,
  isReplaying,
  hasValue,
  currentCaptureAs,
  onCaptureAsVar,
  isRoot,
  isLeaf,
  onInsertCallFlowBefore,
  onAppendCallFlowAfter,
  showExtract,
  selectedCount,
  onExtract,
}: NodeContextMenuProps) {
  const disabled = isRecording || isReplaying
  const [captureInput, setCaptureInput] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const inputOpen = captureInput !== null

  useEffect(() => {
    if (inputOpen) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [inputOpen])

  const commitCapture = () => {
    const trimmed = captureInput?.trim()
    onCaptureAsVar(trimmed || undefined)
    onClose()
  }

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
          minWidth: 220,
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

        {showExtract && (
          <>
            <div style={{ borderTop: '1px solid #334155', margin: '4px 0' }} />
            <MenuItem
              icon="⧉"
              label={`將選取的 ${selectedCount} 個節點另存為子流程`}
              disabled={disabled}
              onClick={() => {
                onClose()
                onExtract()
              }}
            />
          </>
        )}

        <div style={{ borderTop: '1px solid #334155', margin: '4px 0' }} />
        {!isRoot && (
          <MenuItem
            icon="⛓"
            label="在此節點前插入子流程"
            disabled={disabled}
            onClick={() => {
              onClose()
              onInsertCallFlowBefore()
            }}
          />
        )}
        {isLeaf && (
          <MenuItem
            icon="⛓"
            label="在此節點後加入子流程"
            disabled={disabled}
            onClick={() => {
              onClose()
              onAppendCallFlowAfter()
            }}
          />
        )}

        {hasValue && (
          <>
            <div style={{ borderTop: '1px solid #334155', margin: '4px 0' }} />
            {captureInput === null ? (
              <MenuItem
                icon="$"
                label={
                  currentCaptureAs
                    ? `已儲存為 {{${currentCaptureAs}}}（點擊修改）`
                    : '將值儲存為區域變數'
                }
                disabled={disabled}
                onClick={() => setCaptureInput(currentCaptureAs ?? '')}
              />
            ) : (
              <div style={{ padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 12, color: '#94a3b8', flexShrink: 0 }}>{'{{  }}'}</span>
                <input
                  ref={inputRef}
                  value={captureInput}
                  onChange={(e) => setCaptureInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitCapture()
                    if (e.key === 'Escape') onClose()
                  }}
                  placeholder="變數名稱，如 sign_title"
                  style={{
                    flex: 1,
                    padding: '4px 6px',
                    background: '#0f172a',
                    border: '1px solid #3b82f6',
                    borderRadius: 4,
                    color: '#e2e8f0',
                    fontSize: 12,
                    outline: 'none',
                  }}
                />
                <button
                  onClick={commitCapture}
                  style={{
                    padding: '3px 8px',
                    borderRadius: 4,
                    border: 'none',
                    background: '#3b82f6',
                    color: '#fff',
                    fontSize: 12,
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  確認
                </button>
              </div>
            )}
          </>
        )}

        <div style={{ borderTop: '1px solid #334155', margin: '4px 0' }} />
        <MenuItem
          icon="✂"
          label={deleteOnlyLabel}
          disabled={disabled}
          danger
          onClick={() => {
            onClose()
            onDeleteNodeOnly()
          }}
        />
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
