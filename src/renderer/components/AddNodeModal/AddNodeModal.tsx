import { useMemo, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useFlowStore } from '@renderer/stores/flowStore'
import { useProjectStore } from '@renderer/stores/projectStore'
import { BUILT_IN_VARIABLES } from '@shared/variableResolver'
import type { Action } from '@shared/types'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { FieldLabel } from '../common/Input'
import { token, radius } from '../../styles/tokens'

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
  const currentProject = useProjectStore((s) => s.currentProject)

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
    <Modal
      title="加入節點"
      width={720}
      maxWidth="92vw"
      onClose={onClose}
      bodyStyle={{ display: 'flex', flexDirection: 'column', maxHeight: '78vh' }}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button tone="primary" onClick={confirm} disabled={!canConfirm}>
            確認
          </Button>
        </>
      }
    >
      <FieldLabel>節點類型</FieldLabel>
      <select
        value={kind}
        onChange={(e) => setKind(e.target.value as NodeKind)}
        style={{
          display: 'block',
          width: '100%',
          padding: '8px 10px',
          background: token.bgPage,
          border: `1px solid ${token.border}`,
          borderRadius: radius.md,
          color: token.text,
          fontSize: 13,
          outline: 'none',
          marginBottom: 16,
        }}
      >
        <option value="code">程式碼 Code</option>
      </select>

      {kind === 'code' && (
        <div style={{ display: 'flex', gap: 16, minHeight: 0, flex: 1 }}>
          {/* Code editor */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <FieldLabel>
              程式碼（可用 <code style={{ color: CODE_REF_COLOR }}>page</code>、
              <code style={{ color: CODE_REF_COLOR }}>expect</code>、
              <code style={{ color: CODE_REF_COLOR }}>vars</code>）
            </FieldLabel>
            <textarea
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={CODE_PLACEHOLDER}
              spellCheck={false}
              className="ft-input"
              style={{
                width: '100%',
                minHeight: 320,
                resize: 'vertical',
                padding: '10px 12px',
                background: token.bgPage,
                border: `1px solid ${token.border}`,
                borderRadius: radius.md,
                color: token.text,
                fontSize: 12.5,
                lineHeight: 1.5,
                fontFamily: 'Consolas, "Courier New", monospace',
                outline: 'none',
                tabSize: 2,
              }}
            />
          </div>

          {/* Variable reference */}
          <div style={{ width: 200, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <FieldLabel>可用變數</FieldLabel>
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                background: token.bgPage,
                border: `1px solid ${token.border}`,
                borderRadius: radius.md,
                padding: 6,
              }}
            >
              {varRefs.length === 0 && (
                <div style={{ fontSize: 11, color: token.textMuted, padding: 6 }}>（無可用變數）</div>
              )}
              {varRefs.map((r, i) => (
                <div
                  key={`${r.snippet}-${i}`}
                  className="ft-menu-item"
                  onClick={() => copySnippet(r.snippet)}
                  title={`點擊複製 ${r.snippet}`}
                  style={{
                    padding: '5px 7px',
                    cursor: 'pointer',
                    borderRadius: radius.sm,
                    userSelect: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 6,
                  }}
                >
                  <code style={{ fontSize: 11, color: CODE_REF_COLOR }}>
                    {r.label}
                    {r.secret ? <span title="私密資料（執行時解密）"> 🔐</span> : null}
                  </code>
                  {copied === r.snippet ? (
                    <span style={{ fontSize: 9, color: token.successFg }}>已複製</span>
                  ) : (
                    <span style={{ fontSize: 9, color: token.textMuted }}>{r.group}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

/** Sky-blue used for identifiers in this dialog. Not a design token — it only appears here. */
const CODE_REF_COLOR = '#7dd3fc'
