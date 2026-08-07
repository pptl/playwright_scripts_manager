import { useMemo, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useFlowStore } from '@renderer/stores/flowStore'
import { BUILT_IN_VARIABLES } from '@shared/variableResolver'
import type { Action } from '@shared/types'

interface AddNodeModalProps {
  onConfirm: (action: Action) => void
  onClose: () => void
}

type NodeKind = 'code'

const CODE_PLACEHOLDER = `// 以 page / expect / vars 撰寫道地的 Playwright 程式碼
// 例：讀取動態清單並逐項處理
const rows = await page.locator('table tbody tr').allTextContents();
for (const row of rows) {
  console.log(row);
}`

/** Dialog to add a standalone node to the canvas. Currently only "code" nodes.
 *  The created node is floating (no parent/child); the user wires it up manually. */
export function AddNodeModal({ onConfirm, onClose }: AddNodeModalProps) {
  const [kind, setKind] = useState<NodeKind>('code')
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState<string | null>(null)

  const currentFlow = useFlowStore((s) => s.currentFlow)
  const activeProfileId = useFlowStore((s) => s.activeProfileId)
  const currentProject = useFlowStore((s) => s.currentProject)

  // Collect the variable names available inside `vars`.
  const varRefs = useMemo(() => {
    // `secret` only marks the entry with a 🔐 — the list shows names, never values, and
    // at run time `vars.<key>` holds the decrypted value like any other.
    const refs: { label: string; snippet: string; group: string; secret?: boolean }[] = []

    // Built-ins are exposed as functions on vars (fresh value each call)
    for (const v of BUILT_IN_VARIABLES) {
      refs.push({ label: `vars.${v.name}()`, snippet: `vars.${v.name}()`, group: '內建' })
    }

    // Active profile variables
    const profile =
      currentFlow?.profiles?.find((p) => p.id === activeProfileId) ?? currentFlow?.profiles?.[0]
    for (const pv of profile?.vars ?? []) {
      if (pv.key) refs.push({ label: `vars.${pv.key}`, snippet: `vars.${pv.key}`, group: '環境配置', secret: pv.secret })
    }

    // Project environment variables
    for (const ev of currentProject?.envVars ?? []) {
      if (ev.key) refs.push({ label: `vars.${ev.key}`, snippet: `vars.${ev.key}`, group: '專案環境', secret: ev.secret })
    }

    // Session variables (captureAs across the current flow)
    const seen = new Set<string>()
    for (const n of currentFlow?.nodes ?? []) {
      const key = n.action.captureAs
      if (key && !seen.has(key)) {
        seen.add(key)
        refs.push({ label: `vars.${key}`, snippet: `vars.${key}`, group: '區域變數' })
      }
    }

    return refs
  }, [currentFlow, activeProfileId, currentProject])

  const copySnippet = (snippet: string) => {
    navigator.clipboard.writeText(snippet).then(() => {
      setCopied(snippet)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  const canConfirm = code.trim().length > 0

  const confirm = () => {
    if (!canConfirm) return
    const action: Action = {
      id: uuidv4(),
      type: 'code',
      selector: '',
      code,
      description: '程式碼',
      timestamp: Date.now(),
      url: '',
      isPageNavigation: false,
    }
    onConfirm(action)
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
        zIndex: 3000,
      }}
      onMouseDown={onClose}
    >
      <div
        style={{
          background: '#1e293b',
          border: '1px solid #334155',
          borderRadius: 12,
          padding: 24,
          width: 720,
          maxWidth: '92vw',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <h2 style={{ fontSize: 16, color: '#e2e8f0', margin: '0 0 16px' }}>加入節點</h2>

        {/* Node type */}
        <label style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6, display: 'block' }}>
          節點類型
        </label>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as NodeKind)}
          style={{
            display: 'block',
            width: '100%',
            padding: '8px 10px',
            background: '#0f172a',
            border: '1px solid #334155',
            borderRadius: 6,
            color: '#e2e8f0',
            fontSize: 13,
            outline: 'none',
            marginBottom: 16,
            boxSizing: 'border-box',
          }}
        >
          <option value="code">程式碼 Code</option>
        </select>

        {kind === 'code' && (
          <div style={{ display: 'flex', gap: 16, minHeight: 0, flex: 1 }}>
            {/* Code editor */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <label style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>
                程式碼（可用 <code style={{ color: '#7dd3fc' }}>page</code>、
                <code style={{ color: '#7dd3fc' }}>expect</code>、
                <code style={{ color: '#7dd3fc' }}>vars</code>）
              </label>
              <textarea
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={CODE_PLACEHOLDER}
                spellCheck={false}
                style={{
                  width: '100%',
                  minHeight: 320,
                  resize: 'vertical',
                  padding: '10px 12px',
                  background: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: 6,
                  color: '#e2e8f0',
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  fontFamily: 'Consolas, "Courier New", monospace',
                  outline: 'none',
                  boxSizing: 'border-box',
                  tabSize: 2,
                }}
              />
            </div>

            {/* Variable reference */}
            <div style={{ width: 200, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <label style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>可用變數</label>
              <div
                style={{
                  flex: 1,
                  overflowY: 'auto',
                  background: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: 6,
                  padding: 6,
                }}
              >
                {varRefs.length === 0 && (
                  <div style={{ fontSize: 11, color: '#475569', padding: 6 }}>（無可用變數）</div>
                )}
                {varRefs.map((r, i) => (
                  <div
                    key={`${r.snippet}-${i}`}
                    onClick={() => copySnippet(r.snippet)}
                    title={`點擊複製 ${r.snippet}`}
                    style={{
                      padding: '5px 7px',
                      cursor: 'pointer',
                      borderRadius: 4,
                      userSelect: 'none',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 6,
                    }}
                  >
                    <code style={{ fontSize: 11, color: '#7dd3fc' }}>
                      {r.label}
                      {r.secret ? <span title="私密資料（執行時解密）"> 🔐</span> : null}
                    </code>
                    {copied === r.snippet ? (
                      <span style={{ fontSize: 9, color: '#4ade80' }}>已複製</span>
                    ) : (
                      <span style={{ fontSize: 9, color: '#475569' }}>{r.group}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button
            onClick={onClose}
            style={{
              padding: '6px 16px',
              borderRadius: 6,
              border: '1px solid #475569',
              background: 'transparent',
              color: '#94a3b8',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            取消
          </button>
          <button
            onClick={confirm}
            disabled={!canConfirm}
            style={{
              padding: '6px 16px',
              borderRadius: 6,
              border: 'none',
              background: canConfirm ? '#3b82f6' : '#334155',
              color: canConfirm ? '#fff' : '#64748b',
              cursor: canConfirm ? 'pointer' : 'not-allowed',
              fontSize: 12,
            }}
          >
            確認
          </button>
        </div>
      </div>
    </div>
  )
}
