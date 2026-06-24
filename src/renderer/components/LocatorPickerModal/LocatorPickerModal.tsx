import React, { useState } from 'react'
import { useFlowStore } from '../../stores/flowStore'

export function LocatorPickerModal() {
  const { pendingLocatorPick, setPendingLocatorPick, addActionNode, recordingHeadId } = useFlowStore()
  const [selectedIndex, setSelectedIndex] = useState(0)

  if (!pendingLocatorPick) return null

  const { action, alternatives } = pendingLocatorPick

  const handleConfirm = () => {
    const chosen = alternatives[selectedIndex]
    const updatedAction = {
      ...action,
      locatorExpr: chosen.expr,
      description: selectedIndex === 0 ? action.description : deriveDescription(chosen.expr),
    }
    addActionNode(updatedAction, recordingHeadId)
    const updated = useFlowStore.getState().currentFlow
    if (updated) window.electronAPI.saveFlow(updated).catch(console.error)
    setPendingLocatorPick(null)
    setSelectedIndex(0)
    window.electronAPI.resolveLocatorPick()
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
      }}
    >
      <div
        style={{
          background: '#0f172a',
          border: '1px solid #334155',
          borderRadius: 12,
          width: 520,
          maxWidth: '90vw',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid #1e293b',
            fontSize: 14,
            fontWeight: 600,
            color: '#e2e8f0',
          }}
        >
          選擇 Locator 方式
        </div>

        {/* Options */}
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>
            點擊的元素位於 Table 中，請選擇要記錄的定位方式：
          </div>
          {alternatives.map((alt, i) => (
            <label
              key={i}
              onClick={() => setSelectedIndex(i)}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 8,
                border: `1px solid ${selectedIndex === i ? '#3b82f6' : '#334155'}`,
                background: selectedIndex === i ? '#1e3a5f' : '#1e293b',
                cursor: 'pointer',
                transition: 'border-color 0.15s, background 0.15s',
              }}
            >
              <input
                type="radio"
                checked={selectedIndex === i}
                onChange={() => setSelectedIndex(i)}
                style={{ marginTop: 2, accentColor: '#3b82f6', flexShrink: 0 }}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: '#e2e8f0', fontWeight: 500, marginBottom: 3 }}>
                  {i === 0 ? 'Cell（依內容）' : `Row（依位置，第 ${extractRowNum(alt.expr)} 列）`}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: '#94a3b8',
                    fontFamily: 'monospace',
                    wordBreak: 'break-all',
                  }}
                >
                  {alt.expr}
                </div>
              </div>
            </label>
          ))}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '10px 16px',
            borderTop: '1px solid #1e293b',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <button
            onClick={handleConfirm}
            style={{
              padding: '6px 20px',
              borderRadius: 6,
              border: '1px solid #1d4ed8',
              background: '#1e40af',
              color: '#bfdbfe',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            確認
          </button>
        </div>
      </div>
    </div>
  )
}

function extractRowNum(expr: string): number {
  const m = expr.match(/\.nth\((\d+)\)/)
  return m ? parseInt(m[1]) + 1 : 1
}

function deriveDescription(expr: string): string {
  const rowNum = extractRowNum(expr)
  return `點擊第 ${rowNum} 列 (row)`
}
