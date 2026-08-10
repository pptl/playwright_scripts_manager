import React, { useEffect, useRef, useState } from 'react'
import { DOMAIN_ENV_KEY, SECRET_MASK } from '@shared/types'
import type { ProjectEnvVar } from '@shared/types'
import { cellInputStyle } from '../common/varTable'
import { token, zIndex } from '../../styles/tokens'

/**
 * Browse the project's environment variables and drop a `{{key}}` reference into the
 * profile variable table — the trigger button plus the popover it opens.
 *
 * The caret machinery stays entirely in ProfileVarTable: this component only reports
 * which key was picked and renders the badge according to what `onPick` says happened
 * with it. That is the whole seam between the two.
 */
export function EnvVarPickerPopover({
  envVars,
  activeEnvironmentId,
  onPick,
  canInsert,
}: {
  envVars: ProjectEnvVar[]
  activeEnvironmentId: string | null
  /** Consume the pick; the return value drives the 已插入 / 已複製 badge. */
  onPick: (key: string) => 'insert' | 'copy'
  /** Whether a value input currently has a remembered caret. Deliberately a function:
   *  the answer lives in a ref that is read while rendering the hint line. */
  canInsert: () => boolean
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [search, setSearch] = useState('')
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [copiedMode, setCopiedMode] = useState<'insert' | 'copy'>('copy')

  const btnRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)

  const close = () => {
    setAnchor(null)
    setSearch('')
  }

  // Dismiss on outside click / Escape. The modal has no Escape handler of its own
  // (closeOnEscape={false}), so stopping propagation here keeps Escape scoped to the
  // popover rather than closing the whole editor.
  useEffect(() => {
    if (!anchor) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (popoverRef.current?.contains(target) || btnRef.current?.contains(target)) return
      close()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [anchor])

  // Clear the "已插入 / 已複製" badge, and clear the timer if this unmounts first.
  useEffect(() => {
    if (!copiedKey) return
    const t = setTimeout(() => setCopiedKey(null), 1500)
    return () => clearTimeout(t)
  }, [copiedKey])

  const valueFor = (ev: ProjectEnvVar) =>
    ev.secret ? SECRET_MASK : activeEnvironmentId ? (ev.values[activeEnvironmentId] ?? '') : ''

  const q = search.trim().toLowerCase()
  const visible = !q
    ? envVars
    : envVars.filter(
        (ev) =>
          ev.key.toLowerCase().includes(q) ||
          // Private values are excluded from the search corpus — matching on them would
          // turn the filter box into an oracle for the very value being hidden.
          (!ev.secret && (ev.values[activeEnvironmentId ?? ''] ?? '').toLowerCase().includes(q)),
      )

  const handleClick = (key: string) => {
    setCopiedMode(onPick(key))
    setCopiedKey(key)
  }

  if (envVars.length === 0) return null

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => (anchor ? close() : setAnchor(btnRef.current?.getBoundingClientRect() ?? null))}
        title={`瀏覽專案環境變數，點擊插入或複製 ${'{{key}}'}`}
        style={{ ...envRefBtnStyle, ...(anchor ? { borderColor: token.successFg } : {}) }}
      >
        🌐 專案環境變數 ({envVars.length}) {anchor ? '▴' : '▾'}
      </button>

      {/* `fixed` so the right column's overflow:hidden can't clip it */}
      {anchor && (
        <div
          ref={popoverRef}
          style={{
            position: 'fixed',
            top: anchor.bottom + 4,
            left: Math.max(8, anchor.right - 340),
            width: 340,
            zIndex: zIndex.popover,
            background: token.bgPanel,
            border: `1px solid ${token.border}`,
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <div style={{ padding: '8px 10px', borderBottom: `1px solid ${token.border}`, flexShrink: 0 }}>
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="🔍 搜尋變數…"
              style={cellInputStyle}
            />
            <div style={{ fontSize: 10, color: token.textMuted, marginTop: 5 }}>
              {canInsert()
                ? '點擊插入至編輯中的「值」欄位'
                : `點擊複製 ${'{{key}}'}（先點一個「值」欄位可直接插入）`}
            </div>
          </div>

          <div style={{ overflowY: 'auto', maxHeight: 240 }}>
            {visible.map((ev) => {
              const value = valueFor(ev)
              return (
                <div
                  key={ev.key}
                  onClick={() => handleClick(ev.key)}
                  title={`{{${ev.key}}}`}
                  style={{
                    padding: '6px 10px',
                    cursor: 'pointer',
                    borderBottom: `1px solid ${token.bgPage}`,
                    userSelect: 'none',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = ENV_ROW_HOVER_BG }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <code
                      style={{
                        fontSize: 11,
                        background: token.bgPage,
                        color: token.successFg,
                        padding: '1px 5px',
                        borderRadius: 3,
                        border: `1px solid ${token.successDark}`,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {`{{${ev.key}}}`}
                    </code>
                    {ev.key === DOMAIN_ENV_KEY && (
                      <span style={{ fontSize: 10 }} title="保留變數">🔒</span>
                    )}
                    {ev.secret && (
                      <span style={{ fontSize: 10 }} title="私密資料（加密儲存）">🔐</span>
                    )}
                    <div style={{ flex: 1 }} />
                    {copiedKey === ev.key && (
                      <span style={{ fontSize: 10, color: token.successFg, flexShrink: 0 }}>
                        {copiedMode === 'insert' ? '已插入' : '已複製'}
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      color: value ? ENV_VALUE_PREVIEW : token.borderStrong,
                      marginTop: 2,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {activeEnvironmentId ? (value || '(空)') : '—'}
                  </div>
                </div>
              )
            })}

            {visible.length === 0 && (
              <div style={{ padding: 12, fontSize: 11, color: token.textMuted }}>找不到符合的變數</div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

/* One-offs, deliberately not design tokens: they exist only because this popover is
 * green-themed, and are tuned against its own dark ground. */
const ENV_ROW_HOVER_BG = '#08140c'
const ENV_VALUE_PREVIEW = '#78716c'

const envRefBtnStyle: React.CSSProperties = {
  padding: '3px 10px',
  borderRadius: 4,
  border: `1px solid ${token.successDark}`,
  background: token.successBg,
  color: token.successFg,
  fontSize: 11,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
