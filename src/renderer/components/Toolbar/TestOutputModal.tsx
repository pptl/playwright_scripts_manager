import React, { useEffect, useRef } from 'react'
import type { TestFinishedPayload } from '@shared/types'

interface TestOutputModalProps {
  lines: string[]
  finished: TestFinishedPayload | null
  onClose: () => void
}

export function TestOutputModal({ lines, finished, onClose }: TestOutputModalProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines])

  const statusColor = finished == null ? '#93c5fd' : finished.passed ? '#86efac' : '#f87171'
  const statusText =
    finished == null
      ? '⟳ 測試執行中...'
      : finished.passed
        ? '✓ 所有測試通過'
        : `✗ 測試失敗 (exit ${finished.exitCode})`

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
      onClick={(e) => e.target === e.currentTarget && finished && onClose()}
    >
      <div
        style={{
          background: '#0f172a',
          border: '1px solid #334155',
          borderRadius: 12,
          width: 760,
          maxWidth: '90vw',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: '1px solid #1e293b',
            flexShrink: 0,
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 14, color: '#e2e8f0' }}>執行所有測試</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: statusColor }}>{statusText}</span>
            {finished && (
              <button
                onClick={onClose}
                style={{
                  padding: '4px 12px',
                  borderRadius: 6,
                  border: '1px solid #475569',
                  background: 'transparent',
                  color: '#94a3b8',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                關閉
              </button>
            )}
          </div>
        </div>

        {/* Output */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '12px 16px',
            fontFamily: 'monospace',
            fontSize: 12,
            lineHeight: 1.6,
            color: '#cbd5e1',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {lines.join('')}
          <div ref={bottomRef} />
        </div>

        {/* Footer note when finished */}
        {finished && (
          <div
            style={{
              padding: '8px 16px',
              borderTop: '1px solid #1e293b',
              fontSize: 11,
              color: '#475569',
              flexShrink: 0,
            }}
          >
            測試報告已在瀏覽器中開啟。點擊背景或按「關閉」以關閉此視窗。
          </div>
        )}
      </div>
    </div>
  )
}
