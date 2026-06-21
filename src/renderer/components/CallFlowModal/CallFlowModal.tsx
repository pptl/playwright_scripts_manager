import React, { useState, useEffect } from 'react'
import { v4 as uuidv4 } from 'uuid'
import type { Action, Flow, FlowNode } from '@shared/types'
import { useFlowStore } from '../../stores/flowStore'

interface CallFlowModalProps {
  mode: 'insertBefore' | 'appendAfter' | 'asRoot'
  targetNodeId?: string
  onClose: () => void
  onConfirm: (callFlowAction: Action) => void
}

type Step = 1 | 2 | 3

function getBreadcrumb(node: FlowNode, nodeMap: Map<string, FlowNode>): string {
  const parts: string[] = []
  let cur: FlowNode | undefined = node
  while (cur) {
    parts.unshift(cur.action.description || cur.action.type)
    cur = cur.parentId ? nodeMap.get(cur.parentId) : undefined
  }
  return parts.join(' → ')
}

export function CallFlowModal({ mode, onClose, onConfirm }: CallFlowModalProps) {
  const { currentFlow } = useFlowStore()

  const [step, setStep] = useState<Step>(1)
  const [allFlows, setAllFlows] = useState<Pick<Flow, 'id' | 'name' | 'description' | 'updatedAt'>[]>([])
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null)
  const [subFlow, setSubFlow] = useState<Flow | null>(null)
  const [selectedExitNodeId, setSelectedExitNodeId] = useState<string | null>(null)
  const [actionDescription, setActionDescription] = useState('')
  // profileMapping: parentProfileId → subFlowProfileId (null means "use first profile")
  const [profileMapping, setProfileMapping] = useState<Record<string, string | null>>({})
  const [cycleError, setCycleError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    window.electronAPI.listFlows().then((flows) => {
      setAllFlows(flows.filter((f) => f.id !== currentFlow?.id))
    })
  }, [currentFlow?.id])

  const handleSelectFlow = async (flowId: string) => {
    setCycleError(null)
    setSelectedFlowId(flowId)
    setSubFlow(null)
    setSelectedExitNodeId(null)
    setProfileMapping({})

    if (currentFlow?.id) {
      const hasCycle = await window.electronAPI.checkFlowCycle(currentFlow.id, flowId)
      if (hasCycle) {
        setCycleError('此流程會造成循環依賴，無法選取')
        return
      }
    }

    setLoading(true)
    const flow = await window.electronAPI.getFlow(flowId)
    setLoading(false)
    if (!flow) return
    setSubFlow(flow)

    setActionDescription(`呼叫子流程: ${flow.name}`)

    // Initialize mapping: each parent profile defaults to the first sub-flow profile
    const parentProfiles = currentFlow?.profiles ?? []
    const subProfiles = flow.profiles ?? []
    const defaultSubProfileId = subProfiles.length > 0 ? subProfiles[0].id : null
    const initMapping: Record<string, string | null> = {}
    parentProfiles.forEach((p) => { initMapping[p.id] = defaultSubProfileId })
    setProfileMapping(initMapping)
  }

  const handleNext = () => {
    if (step === 1 && selectedFlowId && !cycleError) setStep(2)
    else if (step === 2 && selectedExitNodeId) {
      const subProfiles = subFlow?.profiles ?? []
      if (subProfiles.length > 1) setStep(3)
      else handleConfirm()
    }
    else if (step === 3) handleConfirm()
  }

  const handleConfirm = () => {
    if (!subFlow || !selectedExitNodeId) return
    const parentProfiles = currentFlow?.profiles ?? []
    const subProfiles = subFlow.profiles ?? []

    // Single-parent-profile case: keep legacy subFlowProfileId + subFlowProfileName for badge display
    const isSingleParentProfile = parentProfiles.length <= 1
    const singleMappedId = isSingleParentProfile && parentProfiles.length === 1
      ? (profileMapping[parentProfiles[0].id] ?? null)
      : null

    const callFlowAction: Action = {
      id: uuidv4(),
      type: 'callFlow',
      selector: '',
      description: actionDescription.trim() || `呼叫子流程: ${subFlow.name}`,
      timestamp: Date.now(),
      url: '',
      isPageNavigation: false,
      subFlowId: subFlow.id,
      subFlowExitNodeId: selectedExitNodeId,
      subFlowProfileMapping: profileMapping,
      // Legacy fields — only set for single-parent-profile case so the badge shows the name
      subFlowProfileId: singleMappedId ?? undefined,
      subFlowProfileName: singleMappedId
        ? subProfiles.find((p) => p.id === singleMappedId)?.name
        : undefined,
    }
    onConfirm(callFlowAction)
  }

  const leafNodes = subFlow
    ? subFlow.nodes.filter((n) => n.childIds.length === 0)
    : []
  const subFlowNodeMap = subFlow
    ? new Map(subFlow.nodes.map((n) => [n.id, n]))
    : new Map<string, FlowNode>()
  const subProfiles = subFlow?.profiles ?? []
  const parentProfiles = currentFlow?.profiles ?? []
  const isMultiParentProfile = parentProfiles.length > 1

  const canProceed =
    (step === 1 && !!selectedFlowId && !cycleError) ||
    (step === 2 && !!selectedExitNodeId) ||
    step === 3

  const modeLabel =
    mode === 'insertBefore' ? '在此節點前插入子流程' :
    mode === 'appendAfter' ? '在此節點後加入子流程' :
    '加入Flow作為起始節點'

  const totalSteps = subProfiles.length > 1 ? 3 : 2

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 2000,
    }}>
      <div style={{
        background: '#1e293b', borderRadius: 12, width: 560,
        maxHeight: '80vh', display: 'flex', flexDirection: 'column',
        border: '1px solid #334155', boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid #334155',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>{modeLabel}</div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
              步驟 {step} / {totalSteps}
            </div>
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 18,
          }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
          {step === 1 && (
            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 10 }}>選擇要呼叫的子流程</div>
              {allFlows.length === 0 && (
                <div style={{ color: '#64748b', fontSize: 13 }}>尚無其他流程可選</div>
              )}
              {allFlows.map((f) => (
                <div
                  key={f.id}
                  onClick={() => handleSelectFlow(f.id)}
                  style={{
                    padding: '10px 12px', borderRadius: 6, marginBottom: 6, cursor: 'pointer',
                    background: selectedFlowId === f.id ? '#1e3a5f' : '#0f172a',
                    border: `1px solid ${selectedFlowId === f.id ? '#3b82f6' : '#334155'}`,
                    color: selectedFlowId === f.id ? '#93c5fd' : '#cbd5e1',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{f.name}</div>
                  {f.description && (
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{f.description}</div>
                  )}
                </div>
              ))}
              {cycleError && (
                <div style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>⚠ {cycleError}</div>
              )}
              {loading && (
                <div style={{ color: '#64748b', fontSize: 12, marginTop: 8 }}>載入中…</div>
              )}
              {selectedFlowId && !cycleError && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', marginBottom: 6, letterSpacing: '0.05em' }}>
                    描述
                  </div>
                  <input
                    value={actionDescription}
                    onChange={(e) => setActionDescription(e.target.value)}
                    placeholder="輸入此節點的描述"
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      padding: '7px 10px', background: '#0f172a',
                      border: '1px solid #334155', borderRadius: 6,
                      color: '#e2e8f0', fontSize: 13, outline: 'none',
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 10 }}>
                選擇子流程的出口節點（走到這個節點時視為子流程執行完畢）
              </div>
              {leafNodes.length === 0 && (
                <div style={{ color: '#64748b', fontSize: 13 }}>此流程沒有葉子節點</div>
              )}
              {leafNodes.map((n) => (
                <div
                  key={n.id}
                  onClick={() => setSelectedExitNodeId(n.id)}
                  style={{
                    padding: '10px 12px', borderRadius: 6, marginBottom: 6, cursor: 'pointer',
                    background: selectedExitNodeId === n.id ? '#1e3a5f' : '#0f172a',
                    border: `1px solid ${selectedExitNodeId === n.id ? '#3b82f6' : '#334155'}`,
                    color: selectedExitNodeId === n.id ? '#93c5fd' : '#cbd5e1',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 500 }}>
                    {n.action.description || n.action.type}
                  </div>
                  <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
                    {getBreadcrumb(n, subFlowNodeMap)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {step === 3 && (
            <div>
              {isMultiParentProfile ? (
                // Multi-parent-profile: show mapping table
                <>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 12 }}>
                    為每個父流程環境配置，指定子流程 <strong style={{ color: '#e2e8f0' }}>{subFlow?.name}</strong> 要套用的配置
                  </div>
                  <div style={{
                    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
                    marginBottom: 8, padding: '4px 0',
                  }}>
                    <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>父流程配置</div>
                    <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>子流程套用配置</div>
                  </div>
                  {parentProfiles.map((pp) => (
                    <div
                      key={pp.id}
                      style={{
                        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
                        alignItems: 'center', marginBottom: 8,
                        background: '#0f172a', borderRadius: 6,
                        padding: '8px 12px', border: '1px solid #334155',
                      }}
                    >
                      <div style={{ fontSize: 13, color: '#cbd5e1', fontWeight: 500 }}>{pp.name}</div>
                      <select
                        value={profileMapping[pp.id] ?? ''}
                        onChange={(e) => setProfileMapping((prev) => ({
                          ...prev,
                          [pp.id]: e.target.value || null,
                        }))}
                        style={{
                          background: '#1e293b', color: '#e2e8f0', border: '1px solid #475569',
                          borderRadius: 4, padding: '4px 8px', fontSize: 12, cursor: 'pointer',
                          width: '100%',
                        }}
                      >
                        {subProfiles.map((sp) => (
                          <option key={sp.id} value={sp.id}>{sp.name}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </>
              ) : (
                // Single-parent-profile: show original single-selection list
                <>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 10 }}>
                    選擇子流程套用的配置（Profile）
                  </div>
                  {subProfiles.map((sp) => {
                    const mappedId = parentProfiles.length > 0 ? profileMapping[parentProfiles[0].id] : null
                    return (
                      <div
                        key={sp.id}
                        onClick={() => {
                          if (parentProfiles.length > 0) {
                            setProfileMapping({ [parentProfiles[0].id]: sp.id })
                          }
                        }}
                        style={{
                          padding: '10px 12px', borderRadius: 6, marginBottom: 6, cursor: 'pointer',
                          background: mappedId === sp.id ? '#1e3a5f' : '#0f172a',
                          border: `1px solid ${mappedId === sp.id ? '#3b82f6' : '#334155'}`,
                          color: mappedId === sp.id ? '#93c5fd' : '#cbd5e1',
                        }}
                      >
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{sp.name}</div>
                        {sp.vars.length > 0 && (
                          <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
                            {sp.vars.slice(0, 3).map((v) => `${v.key}=${v.value}`).join(', ')}
                            {sp.vars.length > 3 ? ' …' : ''}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 20px', borderTop: '1px solid #334155',
          display: 'flex', justifyContent: 'flex-end', gap: 8,
        }}>
          {step > 1 && (
            <button
              onClick={() => setStep((s) => (s - 1) as Step)}
              style={{
                padding: '6px 16px', borderRadius: 6, border: '1px solid #334155',
                background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 13,
              }}
            >上一步</button>
          )}
          <button onClick={onClose} style={{
            padding: '6px 16px', borderRadius: 6, border: '1px solid #334155',
            background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 13,
          }}>取消</button>
          <button
            onClick={handleNext}
            disabled={!canProceed}
            style={{
              padding: '6px 16px', borderRadius: 6, border: 'none',
              background: canProceed ? '#3b82f6' : '#1e3a5f',
              color: canProceed ? '#fff' : '#475569', cursor: canProceed ? 'pointer' : 'not-allowed',
              fontSize: 13,
            }}
          >
            {step === 2 && subProfiles.length <= 1 ? '確認' : step === 3 ? '確認' : '下一步'}
          </button>
        </div>
      </div>
    </div>
  )
}
