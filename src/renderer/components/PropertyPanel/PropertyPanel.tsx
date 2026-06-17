import React, { useState, useEffect } from 'react'
import { useFlowStore } from '../../stores/flowStore'

export function PropertyPanel() {
  const { currentFlow, selectedNodeId, updateNode, saveCurrentFlow } = useFlowStore()
  const selectedNode = currentFlow?.nodes.find((n) => n.id === selectedNodeId)

  const [desc, setDesc] = useState('')
  const [selector, setSelector] = useState('')
  const [value, setValue] = useState('')

  useEffect(() => {
    if (selectedNode) {
      setDesc(selectedNode.action.description)
      setSelector(selectedNode.action.selector)
      setValue(selectedNode.action.value ?? '')
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
            <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
              可插入變數，如 <code style={{ color: '#7dd3fc' }}>{'{{randomText}}'}</code>
            </div>
          </Field>
        )}

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

