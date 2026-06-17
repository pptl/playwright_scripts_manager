import React, { useState, useEffect } from 'react'
import { useFlowStore } from '../../stores/flowStore'
import { useFlowManager } from '../../hooks/useFlowStore'

export function PropertyPanel() {
  const { currentFlow, selectedNodeId, updateNode, renameCurrentFlow } = useFlowStore()
  const { deleteCurrentFlow, refreshFlowList } = useFlowManager()
  const selectedNode = currentFlow?.nodes.find((n) => n.id === selectedNodeId)

  const [flowName, setFlowName] = useState('')
  const [desc, setDesc] = useState('')
  const [selector, setSelector] = useState('')
  const [value, setValue] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    setFlowName(currentFlow?.name ?? '')
  }, [currentFlow?.id])

  useEffect(() => {
    if (selectedNode) {
      setDesc(selectedNode.action.description)
      setSelector(selectedNode.action.selector)
      setValue(selectedNode.action.value ?? '')
    }
  }, [selectedNodeId, selectedNode])

  if (!currentFlow) return null

  const saveFlowName = async () => {
    const trimmed = flowName.trim()
    if (!trimmed || trimmed === currentFlow.name) return
    await renameCurrentFlow(trimmed)
    await refreshFlowList()
  }

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setConfirmDelete(false)
    await deleteCurrentFlow()
  }

  const saveNode = () => {
    if (!selectedNode) return
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
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {selectedNode ? (
          <>
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
              <button onClick={saveNode} style={saveBtnStyle}>
                儲存
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Flow name */}
            <Field label="流程名稱">
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  value={flowName}
                  onChange={(e) => setFlowName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveFlowName()}
                  style={inputStyle}
                />
                <button onClick={saveFlowName} style={saveBtnStyle}>
                  儲存
                </button>
              </div>
            </Field>

            {/* Delete flow */}
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              {confirmDelete ? (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={handleDelete}
                    style={{ ...deleteBtnStyle, background: '#ef4444' }}
                  >
                    確認刪除
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    style={{ ...deleteBtnStyle, background: '#475569' }}
                  >
                    取消
                  </button>
                </div>
              ) : (
                <button onClick={handleDelete} style={deleteBtnStyle} title="刪除此流程">
                  刪除流程
                </button>
              )}
            </div>
          </>
        )}
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

const deleteBtnStyle: React.CSSProperties = {
  padding: '5px 16px',
  borderRadius: 5,
  border: 'none',
  background: '#7f1d1d',
  color: '#fca5a5',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
}
