import { useState, useRef, useEffect } from 'react'
import { Menu, MenuDivider } from '../common/Menu'
import { token, radius } from '../../styles/tokens'

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
  onInsertCallFlowBefore: () => void
  onAppendCallFlowAfter: () => void
  showExtract: boolean
  selectedCount: number
  onExtract: () => void
  onGroup: () => void
  onDisconnect: () => void
  disconnectLabel: string
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
  onInsertCallFlowBefore,
  onAppendCallFlowAfter,
  showExtract,
  selectedCount,
  onExtract,
  onGroup,
  onDisconnect,
  disconnectLabel,
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
    <Menu x={x} y={y} minWidth={220} onClose={onClose}>
        <ActionMenuItem
          icon="▶"
          label="重播到此節點"
          disabled={disabled}
          onClick={() => {
            onClose()
            onReplay()
          }}
        />
        <ActionMenuItem
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
            <MenuDivider />
            <ActionMenuItem
              icon="⊞"
              label={`將選取的 ${selectedCount} 個節點組成群組`}
              disabled={disabled}
              onClick={() => {
                onClose()
                onGroup()
              }}
            />
            <ActionMenuItem
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

        <MenuDivider />
        <ActionMenuItem
          icon="⛓"
          label="在此節點前插入子流程"
          disabled={disabled}
          onClick={() => {
            onClose()
            onInsertCallFlowBefore()
          }}
        />
        <ActionMenuItem
          icon="⛓"
          label="在此節點後加入子流程"
          disabled={disabled}
          onClick={() => {
            onClose()
            onAppendCallFlowAfter()
          }}
        />

        {hasValue && (
          <>
            <MenuDivider />
            {captureInput === null ? (
              <ActionMenuItem
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
                <span style={{ fontSize: 12, color: token.textSecondary, flexShrink: 0 }}>{'{{  }}'}</span>
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
                    background: token.bgPage,
                    border: `1px solid ${token.accent}`,
                    borderRadius: radius.sm,
                    color: token.text,
                    fontSize: 12,
                    outline: 'none',
                  }}
                />
                <button
                  onClick={commitCapture}
                  style={{
                    padding: '3px 8px',
                    borderRadius: radius.sm,
                    border: 'none',
                    background: token.accent,
                    color: token.textOnAccent,
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

        <MenuDivider />
        <ActionMenuItem
          icon="⊘"
          label={disconnectLabel}
          disabled={disabled}
          onClick={() => {
            onClose()
            onDisconnect()
          }}
        />

        <MenuDivider />
        <ActionMenuItem
          icon="✂"
          label={deleteOnlyLabel}
          disabled={disabled}
          danger
          onClick={() => {
            onClose()
            onDeleteNodeOnly()
          }}
        />
        <ActionMenuItem
          icon="🗑"
          label="刪除此節點及其子節點"
          disabled={disabled}
          danger
          onClick={() => {
            onClose()
            onDelete()
          }}
        />
    </Menu>
  )
}

/**
 * Not the shared `MenuItem`. The canvas menu's entries are <button>s (so they take
 * keyboard focus), sit on a roomier 8×14 rhythm, and tint their hover red when the
 * action is destructive. Folding it into the shared component would change how both
 * this menu and FlowList's look; that is a design decision, not a cleanup.
 */
function ActionMenuItem({
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
  const color = disabled ? DISABLED_ITEM : danger ? token.dangerFg : token.text
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
          (e.currentTarget as HTMLButtonElement).style.background = danger ? DANGER_HOVER_BG : token.border
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

/** One-offs: a cooler grey than --ft-text-disabled, and the near-black red hover fill. */
const DISABLED_ITEM = '#4b5563'
const DANGER_HOVER_BG = '#450a0a'
