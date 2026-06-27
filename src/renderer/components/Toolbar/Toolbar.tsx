import React, { useState, useEffect, useRef } from 'react'
import { useFlowStore } from '../../stores/flowStore'
import { usePlaywright } from '../../hooks/usePlaywright'
import { useFlowManager } from '../../hooks/useFlowStore'
import { TestOutputModal } from './TestOutputModal'
import { ProfileEditorModal } from '../ProfileEditor/ProfileEditorModal'
import type { ExportConfig, TestFinishedPayload } from '../../../shared/types'

const btn = (label: string, onClick: () => void, disabled = false, danger = false) => (
  <button
    onClick={onClick}
    disabled={disabled}
    style={{
      padding: '6px 14px',
      borderRadius: 6,
      border: 'none',
      cursor: disabled ? 'not-allowed' : 'pointer',
      background: danger ? '#dc2626' : disabled ? '#374151' : '#3b82f6',
      color: disabled ? '#6b7280' : '#fff',
      fontSize: 13,
      fontWeight: 500,
    }}
  >
    {label}
  </button>
)

export function Toolbar() {
  const {
    currentFlow,
    isRecording,
    isReplaying,
    selectedNodeId,
    replaySpeed,
    setReplaySpeed,
    activeProfileId,
    setActiveProfile,
    currentProject,
    projects,
    activeEnvironmentId,
    setActiveEnvironment,
    addEnvironmentToProject,
    relayoutAll,
  } = useFlowStore()
  const { startRecording, stopRecording } = usePlaywright()
  const { newFlow } = useFlowManager()
  const [showNewFlowDialog, setShowNewFlowDialog] = useState(false)
  const [newName, setNewName] = useState('')
  const [newURL, setNewURL] = useState('')
  const [newProjectId, setNewProjectId] = useState('')
  const [isRunningTests, setIsRunningTests] = useState(false)
  const [showTestModal, setShowTestModal] = useState(false)
  const [testLines, setTestLines] = useState<string[]>([])
  const [testFinished, setTestFinished] = useState<TestFinishedPayload | null>(null)
  const testLinesRef = useRef<string[]>([])
  const hasNodes = (currentFlow?.nodes.length ?? 0) > 0

  // Profile selector state
  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const [showProfileEditor, setShowProfileEditor] = useState(false)
  const profileMenuRef = useRef<HTMLDivElement>(null)

  // Env selector state
  const [showEnvMenu, setShowEnvMenu] = useState(false)
  const [addingEnv, setAddingEnv] = useState(false)
  const [newEnvName, setNewEnvName] = useState('')
  const envMenuRef = useRef<HTMLDivElement>(null)

  // Close profile menu on outside click
  useEffect(() => {
    if (!showProfileMenu) return
    const handler = (e: MouseEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setShowProfileMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showProfileMenu])

  // Close env menu on outside click
  useEffect(() => {
    if (!showEnvMenu) return
    const handler = (e: MouseEvent) => {
      if (envMenuRef.current && !envMenuRef.current.contains(e.target as Node)) {
        setShowEnvMenu(false)
        setAddingEnv(false)
        setNewEnvName('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showEnvMenu])

  // Derive current profile info
  const profiles = currentFlow?.profiles ?? []
  const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? profiles[0] ?? null
  const activeProfileName = activeProfile?.name ?? '— 無配置 —'
  const isOverriding = activeProfile !== null && activeProfile !== profiles[0]

  /** Build profileVars with env-aware resolution: envValues[activeEnvId] ?? value */
  function getProfileVars(): Record<string, string> | undefined {
    if (!activeProfile) return undefined
    return Object.fromEntries(
      activeProfile.vars.map((v) => [
        v.key,
        (activeEnvironmentId && v.envValues?.[activeEnvironmentId]) ?? v.value,
      ]),
    )
  }

  useEffect(() => {
    const offOutput = window.electronAPI.onTestOutput((line) => {
      testLinesRef.current = [...testLinesRef.current, line]
      setTestLines([...testLinesRef.current])
    })
    const offFinished = window.electronAPI.onTestFinished((payload) => {
      setTestFinished(payload)
      setIsRunningTests(false)
    })
    return () => {
      offOutput()
      offFinished()
    }
  }, [])

  // Get the selected node's description for display
  const selectedNode = currentFlow?.nodes.find((n) => n.id === selectedNodeId)
  const selectedLabel = selectedNode?.action.description ?? null

  const handleNewFlow = async () => {
    if (!newName || !newURL) return
    await newFlow(newName, newURL, undefined, newProjectId || undefined)
    setShowNewFlowDialog(false)
    setNewName('')
    setNewURL('')
    setNewProjectId('')
  }

  const handleRelayout = () => {
    relayoutAll()
    const updated = useFlowStore.getState().currentFlow
    if (updated) window.electronAPI.saveFlow(updated).catch(console.error)
  }

  const handleExport = async () => {
    if (!currentFlow) return
    const config: ExportConfig = {
      outputDir: '',
      helperFunctions: false,
      useTestStep: true,
      profileVars: getProfileVars(),
      activeProfileId: activeProfileId ?? undefined,
      activeEnvironmentId: activeEnvironmentId ?? undefined,
    }
    try {
      const path = await window.electronAPI.exportScripts(currentFlow, config)
      alert(`腳本已匯出到:\n${path}`)
    } catch (err) {
      alert(`匯出失敗: ${String(err)}`)
    }
  }

  const handleRunTests = async () => {
    if (!currentFlow || isRunningTests) return
    const config: ExportConfig = {
      outputDir: '',
      helperFunctions: false,
      useTestStep: true,
      profileVars: getProfileVars(),
      activeProfileId: activeProfileId ?? undefined,
      activeEnvironmentId: activeEnvironmentId ?? undefined,
    }
    testLinesRef.current = []
    setTestLines([])
    setTestFinished(null)
    setIsRunningTests(true)
    setShowTestModal(true)
    await window.electronAPI.runTests(currentFlow, config)
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 16px',
        background: '#1e293b',
        borderBottom: '1px solid #334155',
        flexShrink: 0,
      }}
    >
      <span style={{ fontWeight: 700, fontSize: 16, color: '#60a5fa', marginRight: 8 }}>
        FlowTest
      </span>

      {btn('新增流程', () => setShowNewFlowDialog(true))}

      {!isRecording
        ? btn('▶ 開始錄製', () => startRecording(), !currentFlow)
        : btn('⏹ 停止錄製', () => stopRecording(), false, true)}

      {btn('🧹 整理節點', handleRelayout, !hasNodes || isRecording || isReplaying)}

      {btn('匯出腳本', handleExport, !hasNodes || isRecording)}

      {btn(
        isRunningTests ? '⟳ 測試執行中...' : '▶ 執行所有測試',
        handleRunTests,
        !hasNodes || isRecording || isReplaying || isRunningTests,
      )}

      {/* Status pill */}
      <div style={{ marginLeft: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        {isReplaying && (
          <span style={pillStyle('#1d4ed8', '#93c5fd')}>⟳ 重播中</span>
        )}
        {isRecording && (
          <span style={pillStyle('#7f1d1d', '#fca5a5')}>● 錄製中</span>
        )}
        {selectedLabel && !isRecording && !isReplaying && (
          <span style={pillStyle('#14532d', '#86efac')} title={selectedLabel}>
            ✓ {selectedLabel.length > 24 ? selectedLabel.slice(0, 24) + '…' : selectedLabel}
          </span>
        )}
        {!selectedNodeId && !isRecording && !isReplaying && currentFlow && (
          <span style={{ fontSize: 11, color: '#64748b' }}>右鍵點擊節點以操作</span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
        <span style={{ fontSize: 12, color: '#94a3b8' }}>重播速度:</span>
        {([['快', 100], ['正常', 500], ['慢', 1000]] as [string, number][]).map(([label, ms]) => (
          <button
            key={label}
            onClick={() => setReplaySpeed(ms)}
            style={{
              padding: '3px 10px',
              borderRadius: 4,
              border: 'none',
              cursor: 'pointer',
              background: replaySpeed === ms ? '#3b82f6' : '#374151',
              color: replaySpeed === ms ? '#fff' : '#94a3b8',
              fontSize: 12,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Env selector — visible whenever flow belongs to a project (even with 0 envs, so user can add the first one) */}
      {currentFlow?.projectId && (() => {
        const environments = currentProject?.environments ?? []
        const activeEnvName = environments.find((e) => e.id === activeEnvironmentId)?.name
        return (
          <div ref={envMenuRef} style={{ position: 'relative', marginLeft: 8 }}>
            <button
              onClick={() => setShowEnvMenu((v) => !v)}
              title="切換環境"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 10px',
                borderRadius: 4,
                border: `1px solid ${activeEnvironmentId ? '#22c55e' : '#475569'}`,
                cursor: 'pointer',
                background: activeEnvironmentId ? '#14532d' : '#1e293b',
                color: activeEnvironmentId ? '#4ade80' : '#94a3b8',
                fontSize: 12,
                fontWeight: activeEnvironmentId ? 600 : 400,
                whiteSpace: 'nowrap',
                maxWidth: 160,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              🌐 {activeEnvName ?? '— 選擇環境 —'} ▾
            </button>

            {showEnvMenu && (
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  right: 0,
                  background: '#1e293b',
                  border: '1px solid #334155',
                  borderRadius: 8,
                  minWidth: 220,
                  zIndex: 2000,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                  padding: '6px 0',
                }}
              >
                <div style={{ padding: '4px 12px 8px', fontSize: 11, color: '#64748b', borderBottom: '1px solid #334155' }}>
                  環境選擇
                </div>

                <div
                  onClick={() => { setActiveEnvironment(null); setShowEnvMenu(false) }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 12px', cursor: 'pointer',
                    background: !activeEnvironmentId ? '#1e3a5f' : 'transparent',
                    color: !activeEnvironmentId ? '#93c5fd' : '#cbd5e1',
                    fontSize: 13,
                  }}
                  onMouseEnter={(e) => { if (activeEnvironmentId) (e.currentTarget as HTMLDivElement).style.background = '#0f172a' }}
                  onMouseLeave={(e) => { if (activeEnvironmentId) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
                >
                  <span style={{ fontSize: 10, width: 10, flexShrink: 0 }}>{!activeEnvironmentId ? '●' : '○'}</span>
                  — 預設值 —
                </div>

                {environments.map((env) => {
                  const isSelected = env.id === activeEnvironmentId
                  return (
                    <div
                      key={env.id}
                      onClick={() => { setActiveEnvironment(env.id); setShowEnvMenu(false) }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '7px 12px', cursor: 'pointer',
                        background: isSelected ? '#1e3a5f' : 'transparent',
                        color: isSelected ? '#93c5fd' : '#cbd5e1',
                        fontSize: 13,
                      }}
                      onMouseEnter={(e) => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = '#0f172a' }}
                      onMouseLeave={(e) => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
                    >
                      <span style={{ fontSize: 10, width: 10, flexShrink: 0 }}>{isSelected ? '●' : '○'}</span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {env.name}
                      </span>
                    </div>
                  )
                })}

                {/* Add new environment */}
                <div style={{ borderTop: '1px solid #334155', padding: '6px 10px', marginTop: 4 }}>
                  {addingEnv ? (
                    <div style={{ display: 'flex', gap: 4 }}>
                      <input
                        autoFocus
                        value={newEnvName}
                        onChange={(e) => setNewEnvName(e.target.value)}
                        onKeyDown={async (e) => {
                          if (e.key === 'Enter' && newEnvName.trim()) {
                            await addEnvironmentToProject(newEnvName.trim())
                            setNewEnvName('')
                            setAddingEnv(false)
                          }
                          if (e.key === 'Escape') { setAddingEnv(false); setNewEnvName('') }
                        }}
                        placeholder="環境名稱"
                        style={{
                          flex: 1, padding: '3px 6px',
                          background: '#0f172a', border: '1px solid #3b82f6', borderRadius: 3,
                          color: '#e2e8f0', fontSize: 12, outline: 'none',
                        }}
                      />
                      <button
                        onClick={async () => {
                          if (newEnvName.trim()) {
                            await addEnvironmentToProject(newEnvName.trim())
                            setNewEnvName('')
                            setAddingEnv(false)
                          }
                        }}
                        style={{
                          padding: '3px 7px', borderRadius: 3, border: 'none',
                          background: '#3b82f6', color: '#fff', fontSize: 11, cursor: 'pointer',
                        }}
                      >
                        ✓
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setAddingEnv(true)}
                      style={{
                        width: '100%', padding: '4px 0', borderRadius: 3,
                        border: '1px dashed #334155', background: 'transparent',
                        color: '#3b82f6', fontSize: 12, cursor: 'pointer',
                      }}
                    >
                      ＋ 新增環境
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {/* Profile selector — only visible when a flow is loaded */}
      {currentFlow && (
        <div ref={profileMenuRef} style={{ position: 'relative', marginLeft: 8 }}>
          <button
            onClick={() => setShowProfileMenu((v) => !v)}
            title="切換環境配置"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '3px 10px',
              borderRadius: 4,
              border: `1px solid ${isOverriding ? '#f59e0b' : '#475569'}`,
              cursor: 'pointer',
              background: isOverriding ? '#78350f' : '#1e293b',
              color: isOverriding ? '#fcd34d' : '#94a3b8',
              fontSize: 12,
              fontWeight: isOverriding ? 600 : 400,
              whiteSpace: 'nowrap',
              maxWidth: 160,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            ⚙ {activeProfileName} ▾
          </button>

          {showProfileMenu && (
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 6px)',
                right: 0,
                background: '#1e293b',
                border: '1px solid #334155',
                borderRadius: 8,
                minWidth: 220,
                zIndex: 2000,
                boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                padding: '6px 0',
              }}
            >
              <div style={{ padding: '4px 12px 8px', fontSize: 11, color: '#64748b', borderBottom: '1px solid #334155' }}>
                環境配置
              </div>

              {profiles.map((p) => {
                const isSelected = p.id === (activeProfile?.id ?? profiles[0]?.id)
                return (
                  <div
                    key={p.id}
                    onClick={() => {
                      setActiveProfile(p.id)
                      setShowProfileMenu(false)
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '7px 12px',
                      cursor: 'pointer',
                      background: isSelected ? '#1e3a5f' : 'transparent',
                      color: isSelected ? '#93c5fd' : '#cbd5e1',
                      fontSize: 13,
                    }}
                    onMouseEnter={(e) => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = '#0f172a' }}
                    onMouseLeave={(e) => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
                  >
                    <span style={{ fontSize: 10, width: 10, flexShrink: 0 }}>{isSelected ? '●' : '○'}</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.name}
                    </span>
                    <span style={{ fontSize: 10, color: '#475569', flexShrink: 0 }}>
                      {p.vars.length} 個變數
                    </span>
                  </div>
                )
              })}

              <div
                onClick={() => { setShowProfileMenu(false); setShowProfileEditor(true) }}
                style={{
                  padding: '7px 12px',
                  color: '#3b82f6',
                  fontSize: 13,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  borderTop: '1px solid #334155',
                  marginTop: 4,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#0f172a' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
              >
                ✎ 管理配置...
              </div>
            </div>
          )}
        </div>
      )}

      {currentFlow && (
        <span style={{ fontSize: 12, color: '#64748b', marginLeft: 12 }}>{currentFlow.name}</span>
      )}

      {/* New Flow Dialog */}
      {showNewFlowDialog && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) { setShowNewFlowDialog(false); setNewProjectId('') } }}
        >
          <div
            style={{
              background: '#1e293b',
              border: '1px solid #334155',
              borderRadius: 12,
              padding: 24,
              minWidth: 360,
            }}
          >
            <h2 style={{ marginBottom: 16, fontSize: 18, color: '#e2e8f0' }}>新增流程</h2>
            <label style={{ display: 'block', marginBottom: 12, color: '#94a3b8', fontSize: 13 }}>
              流程名稱
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="例：簽核流程"
                style={inputStyle}
                autoFocus
              />
            </label>
            <label style={{ display: 'block', marginBottom: 12, color: '#94a3b8', fontSize: 13 }}>
              目標 URL
              <input
                value={newURL}
                onChange={(e) => setNewURL(e.target.value)}
                placeholder="https://example.com"
                style={inputStyle}
              />
            </label>
            {projects.length > 0 && (
              <label style={{ display: 'block', marginBottom: 20, color: '#94a3b8', fontSize: 13 }}>
                歸類至專案
                <select
                  value={newProjectId}
                  onChange={(e) => setNewProjectId(e.target.value)}
                  style={{ ...inputStyle, marginTop: 6 }}
                >
                  <option value="">— 不歸類 —</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
            )}
            {projects.length === 0 && <div style={{ marginBottom: 20 }} />}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowNewFlowDialog(false); setNewProjectId('') }} style={cancelBtnStyle}>
                取消
              </button>
              <button
                onClick={handleNewFlow}
                disabled={!newName || !newURL}
                style={confirmBtnStyle(!newName || !newURL)}
              >
                建立
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Test Output Modal */}
      {showTestModal && (
        <TestOutputModal
          lines={testLines}
          finished={testFinished}
          onClose={() => setShowTestModal(false)}
        />
      )}

      {/* Profile Editor Modal */}
      {showProfileEditor && (
        <ProfileEditorModal onClose={() => setShowProfileEditor(false)} />
      )}

    </div>
  )
}

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 6,
  padding: '8px 10px',
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 6,
  color: '#e2e8f0',
  fontSize: 13,
  outline: 'none',
}

const cancelBtnStyle: React.CSSProperties = {
  padding: '7px 18px',
  borderRadius: 6,
  border: '1px solid #475569',
  background: 'transparent',
  color: '#94a3b8',
  cursor: 'pointer',
  fontSize: 13,
}

const confirmBtnStyle = (disabled: boolean): React.CSSProperties => ({
  padding: '7px 18px',
  borderRadius: 6,
  border: 'none',
  background: disabled ? '#374151' : '#3b82f6',
  color: disabled ? '#6b7280' : '#fff',
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontSize: 13,
  fontWeight: 600,
})

const pillStyle = (bg: string, color: string): React.CSSProperties => ({
  padding: '2px 10px',
  borderRadius: 12,
  background: bg,
  color,
  fontSize: 11,
  fontWeight: 600,
  whiteSpace: 'nowrap' as const,
  cursor: 'default',
})
