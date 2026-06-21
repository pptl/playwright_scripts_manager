import React, { useState, useEffect } from 'react'
import type { FlowProfile } from '@shared/types'
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

  // callFlow-specific state
  const [subFlowProfiles, setSubFlowProfiles] = useState<FlowProfile[]>([])
  const [profileMapping, setProfileMapping] = useState<Record<string, string | null>>({})
  const [subFlowLoading, setSubFlowLoading] = useState(false)

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

  // When a callFlow node is selected, load sub-flow profiles and initialize mapping
  useEffect(() => {
    if (selectedNode?.action.type !== 'callFlow') {
      setSubFlowProfiles([])
      setProfileMapping({})
      return
    }
    const subFlowId = selectedNode.action.subFlowId
    if (!subFlowId) return
    setSubFlowLoading(true)
    window.electronAPI.getFlow(subFlowId).then((flow) => {
      setSubFlowProfiles(flow?.profiles ?? [])
      setProfileMapping(selectedNode.action.subFlowProfileMapping ?? {})
      setSubFlowLoading(false)
    })
  }, [selectedNodeId, selectedNode?.action.subFlowId])

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
    const isCallFlow = selectedNode.action.type === 'callFlow'
    updateNode(selectedNode.id, {
      action: {
        ...selectedNode.action,
        description: desc,
        selector,
        value: value || undefined,
        ...(isCallFlow ? { subFlowProfileMapping: profileMapping } : {}),
      },
    })
    window.electronAPI.saveFlow(useFlowStore.getState().currentFlow!).catch(console.error)
  }

  const parentProfiles = currentFlow.profiles ?? []
  const isCallFlow = selectedNode?.action.type === 'callFlow'
  const showMappingSection = isCallFlow && parentProfiles.length > 0 && (subFlowLoading || subFlowProfiles.length > 0)

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

            {/* Selector — hidden for callFlow, goto, press */}
            {selectedNode.action.type !== 'goto' &&
              selectedNode.action.type !== 'press' &&
              selectedNode.action.type !== 'callFlow' && (
              <Field label="Selector">
                <input
                  value={selector}
                  onChange={(e) => setSelector(e.target.value)}
                  style={inputStyle}
                />
              </Field>
            )}

            {/* Value */}
            {['fill', 'selectOption', 'goto', 'press', 'assertText', 'assertValue'].includes(selectedNode.action.type) && (
              <Field label={
                selectedNode.action.type === 'assertText' ? '驗證文字' :
                selectedNode.action.type === 'assertValue' ? '驗證值' : '值'
              }>
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

            {/* callFlow: Profile Mapping */}
            {showMappingSection && (
              <div style={{ width: '100%', marginTop: 8 }}>
                <div style={{
                  fontSize: 11, color: '#64748b', fontWeight: 600,
                  textTransform: 'uppercase', marginBottom: 8, letterSpacing: '0.05em',
                }}>
                  配置對應
                </div>
                {subFlowLoading ? (
                  <div style={{ fontSize: 12, color: '#64748b' }}>載入中…</div>
                ) : (
                  <>
                    <div style={{
                      display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6,
                      marginBottom: 4,
                    }}>
                      <div style={{ fontSize: 10, color: '#475569', fontWeight: 600, textTransform: 'uppercase' }}>父流程配置</div>
                      <div style={{ fontSize: 10, color: '#475569', fontWeight: 600, textTransform: 'uppercase' }}>子流程套用配置</div>
                    </div>
                    {parentProfiles.map((pp) => (
                      <div
                        key={pp.id}
                        style={{
                          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6,
                          alignItems: 'center', marginBottom: 5,
                        }}
                      >
                        <div style={{
                          fontSize: 12, color: '#cbd5e1',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {pp.name}
                        </div>
                        <select
                          value={profileMapping[pp.id] ?? (subFlowProfiles[0]?.id ?? '')}
                          onChange={(e) => setProfileMapping((prev) => ({
                            ...prev,
                            [pp.id]: e.target.value || null,
                          }))}
                          style={{
                            background: '#0f172a', color: '#e2e8f0',
                            border: '1px solid #334155', borderRadius: 4,
                            padding: '3px 6px', fontSize: 12, cursor: 'pointer', width: '100%',
                          }}
                        >
                          {subFlowProfiles.map((sp) => (
                            <option key={sp.id} value={sp.id}>{sp.name}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </>
                )}
              </div>
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
