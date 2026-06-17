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
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null)
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
    setSelectedProfileId(null)

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

    const profiles = flow.profiles ?? []
    setSelectedProfileId(profiles.length > 0 ? profiles[0].id : null)
  }

  const handleNext = () => {
    if (step === 1 && selectedFlowId && !cycleError) setStep(2)
    else if (step === 2 && selectedExitNodeId) {
      const profiles = subFlow?.profiles ?? []
      if (profiles.length > 1) setStep(3)
      else handleConfirm()
    }
    else if (step === 3) handleConfirm()
  }

  const handleConfirm = () => {
    if (!subFlow || !selectedExitNodeId) return
    const callFlowAction: Action = {
      id: uuidv4(),
      type: 'callFlow',
      selector: '',
      description: `呼叫子流程: ${subFlow.name}`,
      timestamp: Date.now(),
      url: '',
      isPageNavigation: false,
      subFlowId: subFlow.id,
      subFlowExitNodeId: selectedExitNodeId,
      subFlowProfileId: selectedProfileId ?? undefined,
    }
    onConfirm(callFlowAction)
  }

  const leafNodes = subFlow
    ? subFlow.nodes.filter((n) => n.childIds.length === 0)
    : []
  const subFlowNodeMap = subFlow
    ? new Map(subFlow.nodes.map((n) => [n.id, n]))
    : new Map<string, FlowNode>()
  const profiles = subFlow?.profiles ?? []
  const canProceed =
    (step === 1 && !!selectedFlowId && !cycleError) ||
    (step === 2 && !!selectedExitNodeId) ||
    step === 3

  const modeLabel =
    mode === 'insertBefore' ? '在此節點前插入子流程' :
    mode === 'appendAfter' ? '在此節點後加入子流程' :
    '加入Flow作為起始節點'

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
              步驟 {step} / {profiles.length > 1 ? 3 : 2}
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
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 10 }}>
                選擇子流程套用的配置（Profile）
              </div>
              {profiles.map((p) => (
                <div
                  key={p.id}
                  onClick={() => setSelectedProfileId(p.id)}
                  style={{
                    padding: '10px 12px', borderRadius: 6, marginBottom: 6, cursor: 'pointer',
                    background: selectedProfileId === p.id ? '#1e3a5f' : '#0f172a',
                    border: `1px solid ${selectedProfileId === p.id ? '#3b82f6' : '#334155'}`,
                    color: selectedProfileId === p.id ? '#93c5fd' : '#cbd5e1',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</div>
                  {p.vars.length > 0 && (
                    <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
                      {p.vars.slice(0, 3).map((v) => `${v.key}=${v.value}`).join(', ')}
                      {p.vars.length > 3 ? ' …' : ''}
                    </div>
                  )}
                </div>
              ))}
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
            {step === 2 && profiles.length <= 1 ? '確認' : step === 3 ? '確認' : '下一步'}
          </button>
        </div>
      </div>
    </div>
  )
}
