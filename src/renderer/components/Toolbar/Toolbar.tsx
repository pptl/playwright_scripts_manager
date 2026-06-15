import React, { useState } from 'react'
import { useFlowStore } from '../../stores/flowStore'
import { usePlaywright } from '../../hooks/usePlaywright'
import { useFlowManager } from '../../hooks/useFlowStore'
import type { ExportConfig } from '../../../../shared/types'

const btn = (label: string, onClick: () => void, disabled = false, danger = false) => (
  <button
    onClick={onClick}
    disabled={disabled}
    style={{
      padding: '6px 14px',
      borderRadius: 6,
      border: 'none',
      cursor: disabled ? 'not-allowed' : 'pointer',
      background: danger ? '#dc2626' : disabled ? '#374151' : '#3b82f6',
      color: disabled ? '#6b7280' : '#fff',
      fontSize: 13,
      fontWeight: 500,
    }}
  >
    {label}
  </button>
)

export function Toolbar() {
  const { currentFlow, isRecording, isReplaying, selectedNodeId } = useFlowStore()
  const { startRecording, startBranchRecording, stopRecording, replayToNode } = usePlaywright()
  const { newFlow } = useFlowManager()
  const [showNewFlowDialog, setShowNewFlowDialog] = useState(false)
  const [newName, setNewName] = useState('')
  const [newURL, setNewURL] = useState('')
  const [replaySpeed, setReplaySpeed] = useState(500)
  const [replayError, setReplayError] = useState<string | null>(null)
  const [isBranchReplaying, setIsBranchReplaying] = useState(false)

  const hasNodes = (currentFlow?.nodes.length ?? 0) > 0

  // Get the selected node's description for display
  const selectedNode = currentFlow?.nodes.find((n) => n.id === selectedNodeId)
  const selectedLabel = selectedNode?.action.description ?? null

  const handleNewFlow = async () => {
    if (!newName || !newURL) return
    await newFlow(newName, newURL)
    setShowNewFlowDialog(false)
    setNewName('')
    setNewURL('')
  }

  const handleExport = async () => {
    if (!currentFlow) return
    const config: ExportConfig = {
      outputDir: '',
      helperFunctions: false,
      useTestStep: true,
    }
    try {
      const path = await window.electronAPI.exportScripts(currentFlow, config)
      alert(`腳本已匯出到:\n${path}`)
    } catch (err) {
      alert(`匯出失敗: ${String(err)}`)
    }
  }

  const handleReplay = async () => {
    if (!selectedNodeId) return
    setReplayError(null)
    try {
      await replayToNode(selectedNodeId, replaySpeed)
    } catch (err) {
      setReplayError(String(err))
    }
  }

  const handleBranchRecord = async () => {
    if (!selectedNodeId) return
    setReplayError(null)
    setIsBranchReplaying(true)
    try {
      await startBranchRecording(selectedNodeId)
    } catch (err) {
      setReplayError(String(err))
    } finally {
      setIsBranchReplaying(false)
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 16px',
        background: '#1e293b',
        borderBottom: '1px solid #334155',
        flexShrink: 0,
      }}
    >
      <span style={{ fontWeight: 700, fontSize: 16, color: '#60a5fa', marginRight: 8 }}>
        FlowTest
      </span>

      {btn('新增流程', () => setShowNewFlowDialog(true))}

      {!isRecording
        ? btn('▶ 開始錄製', () => startRecording(), !currentFlow)
        : btn('⏹ 停止錄製', () => stopRecording(), false, true)}

      {btn(
        isReplaying ? '重播中...' : '▶ 重播到選取節點',
        handleReplay,
        !selectedNodeId || isRecording || isReplaying,
      )}

      {btn(
        isBranchReplaying ? '⟳ 重播中...' : '⑂ 從此節點分支錄製',
        handleBranchRecord,
        !selectedNodeId || isRecording || isReplaying || isBranchReplaying,
      )}

      {btn('匯出腳本', handleExport, !hasNodes || isRecording)}

      {/* Status pill */}
      <div style={{ marginLeft: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        {isBranchReplaying && (
          <span style={pillStyle('#1e3a5f', '#93c5fd')}>⟳ 靜默重播中，請稍候...</span>
        )}
        {isReplaying && !isBranchReplaying && (
          <span style={pillStyle('#1d4ed8', '#93c5fd')}>⟳ 重播中</span>
        )}
        {isRecording && (
          <span style={pillStyle('#7f1d1d', '#fca5a5')}>● 錄製中</span>
        )}
        {selectedLabel && !isRecording && !isReplaying && !isBranchReplaying && (
          <span style={pillStyle('#14532d', '#86efac')} title={selectedLabel}>
            ✓ {selectedLabel.length > 24 ? selectedLabel.slice(0, 24) + '…' : selectedLabel}
          </span>
        )}
        {!selectedNodeId && !isRecording && !isReplaying && currentFlow && (
          <span style={{ fontSize: 11, color: '#475569' }}>點擊節點以選取</span>
        )}
        {replayError && (
          <span
            style={pillStyle('#7f1d1d', '#fca5a5')}
            title={replayError}
            onClick={() => setReplayError(null)}
          >
            ✕ 錯誤: {replayError.slice(0, 40)}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
        <span style={{ fontSize: 12, color: '#94a3b8' }}>速度:</span>
        {([['快', 100], ['正常', 500], ['慢', 1000]] as [string, number][]).map(([label, ms]) => (
          <button
            key={label}
            onClick={() => setReplaySpeed(ms)}
            style={{
              padding: '3px 10px',
              borderRadius: 4,
              border: 'none',
              cursor: 'pointer',
              background: replaySpeed === ms ? '#3b82f6' : '#374151',
              color: replaySpeed === ms ? '#fff' : '#94a3b8',
              fontSize: 12,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {currentFlow && (
        <span style={{ fontSize: 12, color: '#64748b', marginLeft: 12 }}>{currentFlow.name}</span>
      )}

      {/* New Flow Dialog */}
      {showNewFlowDialog && (
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
          onClick={(e) => e.target === e.currentTarget && setShowNewFlowDialog(false)}
        >
          <div
            style={{
              background: '#1e293b',
              border: '1px solid #334155',
              borderRadius: 12,
              padding: 24,
              minWidth: 360,
            }}
          >
            <h2 style={{ marginBottom: 16, fontSize: 18, color: '#e2e8f0' }}>新增流程</h2>
            <label style={{ display: 'block', marginBottom: 12, color: '#94a3b8', fontSize: 13 }}>
              流程名稱
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="例：簽核流程"
                style={inputStyle}
                autoFocus
              />
            </label>
            <label style={{ display: 'block', marginBottom: 20, color: '#94a3b8', fontSize: 13 }}>
              目標 URL
              <input
                value={newURL}
                onChange={(e) => setNewURL(e.target.value)}
                placeholder="https://example.com"
                style={inputStyle}
              />
            </label>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowNewFlowDialog(false)} style={cancelBtnStyle}>
                取消
              </button>
              <button
                onClick={handleNewFlow}
                disabled={!newName || !newURL}
                style={confirmBtnStyle(!newName || !newURL)}
              >
                建立
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 6,
  padding: '8px 10px',
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 6,
  color: '#e2e8f0',
  fontSize: 13,
  outline: 'none',
}

const cancelBtnStyle: React.CSSProperties = {
  padding: '7px 18px',
  borderRadius: 6,
  border: '1px solid #475569',
  background: 'transparent',
  color: '#94a3b8',
  cursor: 'pointer',
  fontSize: 13,
}

const confirmBtnStyle = (disabled: boolean): React.CSSProperties => ({
  padding: '7px 18px',
  borderRadius: 6,
  border: 'none',
  background: disabled ? '#374151' : '#3b82f6',
  color: disabled ? '#6b7280' : '#fff',
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontSize: 13,
  fontWeight: 600,
})

const pillStyle = (bg: string, color: string): React.CSSProperties => ({
  padding: '2px 10px',
  borderRadius: 12,
  background: bg,
  color,
  fontSize: 11,
  fontWeight: 600,
  whiteSpace: 'nowrap' as const,
  cursor: 'default',
})
