import { useEffect, useRef } from 'react'
import type { TestFinishedPayload } from '@shared/types'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { token, radius } from '../../styles/tokens'

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

  const statusColor = finished == null ? token.accentFg : finished.passed ? SUCCESS_TEXT : token.dangerFg
  const statusText =
    finished == null
      ? '⟳ 測試執行中...'
      : finished.passed
        ? '✓ 所有測試通過'
        : `✗ 測試失敗 (exit ${finished.exitCode})`

  // Dismissable only once the run is over — there is no way to cancel a run in
  // flight (A2 in the cleanup backlog), so closing early would just orphan it.
  const dismissable = finished !== null

  return (
    <Modal
      variant="panel"
      title="執行所有測試"
      width={760}
      onClose={onClose}
      closeOnBackdrop={dismissable}
      closeOnEscape={dismissable}
      cardStyle={{ background: token.bgPage, maxWidth: '90vw' }}
      headerExtra={
        <>
          <span style={{ fontSize: 12, fontWeight: 600, color: statusColor }}>{statusText}</span>
          {finished && (
            <button
              onClick={() => window.electronAPI.showReport()}
              className="ft-btn"
              style={{
                padding: '4px 12px',
                borderRadius: radius.md,
                border: `1px solid ${token.accentDark}`,
                background: REPORT_BTN_BG,
                color: REPORT_BTN_FG,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              顯示詳細報告
            </button>
          )}
          {finished && <Button onClick={onClose}>關閉</Button>}
        </>
      }
      bodyStyle={{
        padding: '12px 16px',
        fontFamily: 'monospace',
        fontSize: 12,
        lineHeight: 1.6,
        color: token.textBody,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      }}
      footer={
        finished ? (
          <div style={{ fontSize: 11, color: token.textMuted, marginRight: 'auto' }}>
            點擊「顯示詳細報告」可開啟 Playwright HTML 報告。點擊背景、按 Esc 或「關閉」以關閉此視窗。
          </div>
        ) : undefined
      }
    >
      {lines.join('')}
      <div ref={bottomRef} />
    </Modal>
  )
}

// Local one-offs, not part of the token palette: the pale pass-green reads better
// than --ft-success-fg against the dark console ground, and the report button is
// the only place this blue pairing appears.
const SUCCESS_TEXT = '#86efac'
const REPORT_BTN_BG = '#1e40af'
const REPORT_BTN_FG = '#bfdbfe'
