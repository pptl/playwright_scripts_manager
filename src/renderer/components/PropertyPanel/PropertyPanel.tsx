import React, { useState, useEffect } from 'react'
import { useFlowStore } from '../../stores/flowStore'
import type { Assertion, ActionType } from '../../../../shared/types'

const ASSERTION_TYPES = ['text', 'visible', 'url', 'count'] as const
const ACTION_TYPES: ActionType[] = [
  'goto', 'click', 'fill', 'selectOption', 'check', 'uncheck', 'press', 'wait', 'upload',
]

export function PropertyPanel() {
  const { currentFlow, selectedNodeId, updateNode, saveCurrentFlow } = useFlowStore()
  const selectedNode = currentFlow?.nodes.find((n) => n.id === selectedNodeId)

  const [desc, setDesc] = useState('')
  const [selector, setSelector] = useState('')
  const [value, setValue] = useState('')
  const [assertion, setAssertion] = useState<Assertion | undefined>(undefined)

  useEffect(() => {
    if (selectedNode) {
      setDesc(selectedNode.action.description)
      setSelector(selectedNode.action.selector)
      setValue(selectedNode.action.value ?? '')
      setAssertion(selectedNode.action.assertion)
    }
  }, [selectedNodeId, selectedNode])

  if (!selectedNode) return null

  const save = () => {
    updateNode(selectedNode.id, {
      action: {
        ...selectedNode.action,
        description: desc,
        selector,
        value: value || undefined,
        assertion,
      },
    })
    window.electronAPI.saveFlow(useFlowStore.getState().currentFlow!).catch(console.error)
  }

  return (
    <div
      style={{
        background: '#1e293b',
        borderTop: '1px solid #334155',
        padding: '12px 16px',
        flexShrink: 0,
        maxHeight: 260,
        overflowY: 'auto',
      }}
    >
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        {/* Description */}
        <Field label="描述">
          <input
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            style={inputStyle}
          />
        </Field>

        {/* Selector */}
        {selectedNode.action.type !== 'goto' && selectedNode.action.type !== 'press' && (
          <Field label="Selector">
            <input
              value={selector}
              onChange={(e) => setSelector(e.target.value)}
              style={inputStyle}
            />
          </Field>
        )}

        {/* Value */}
        {['fill', 'selectOption', 'goto', 'press'].includes(selectedNode.action.type) && (
          <Field label="值">
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              style={inputStyle}
            />
          </Field>
        )}

        {/* Assertion */}
        <Field label="驗證">
          {assertion ? (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select
                value={assertion.type}
                onChange={(e) =>
                  setAssertion({ ...assertion, type: e.target.value as Assertion['type'] })
                }
                style={selectStyle}
              >
                {ASSERTION_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              {assertion.type !== 'url' && (
                <input
                  placeholder="selector"
                  value={assertion.target ?? ''}
                  onChange={(e) => setAssertion({ ...assertion, target: e.target.value })}
                  style={{ ...inputStyle, width: 120 }}
                />
              )}
              <input
                placeholder="預期值"
                value={assertion.expected}
                onChange={(e) => setAssertion({ ...assertion, expected: e.target.value })}
                style={{ ...inputStyle, width: 120 }}
              />
              <button
                onClick={() => setAssertion(undefined)}
                style={dangerBtnStyle}
              >
                移除
              </button>
            </div>
          ) : (
            <button
              onClick={() =>
                setAssertion({ type: 'text', target: '', expected: '' })
              }
              style={addBtnStyle}
            >
              + 新增驗證
            </button>
          )}
        </Field>

        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <button onClick={save} style={saveBtnStyle}>
            儲存
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 140 }}>
      <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase' }}>
        {label}
      </span>
      {children}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  padding: '5px 8px',
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 5,
  color: '#e2e8f0',
  fontSize: 12,
  outline: 'none',
  width: 200,
}

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  width: 'auto',
}

const saveBtnStyle: React.CSSProperties = {
  padding: '5px 16px',
  borderRadius: 5,
  border: 'none',
  background: '#3b82f6',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
}

const addBtnStyle: React.CSSProperties = {
  padding: '5px 10px',
  borderRadius: 5,
  border: '1px dashed #475569',
  background: 'transparent',
  color: '#94a3b8',
  cursor: 'pointer',
  fontSize: 12,
}

const dangerBtnStyle: React.CSSProperties = {
  padding: '4px 8px',
  borderRadius: 5,
  border: 'none',
  background: '#7f1d1d',
  color: '#fca5a5',
  cursor: 'pointer',
  fontSize: 11,
}
