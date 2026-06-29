import React, { useEffect, useState, useRef } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useFlowStore } from '../../stores/flowStore'
import { useFlowManager } from '../../hooks/useFlowStore'
import { CallFlowModal } from '../CallFlowModal/CallFlowModal'
import type { Action } from '@shared/types'

export function FlowList() {
  const { flows, currentFlow, projects, addActionNode, updateNode, assignFlowToProject, createProject, deleteProject, renameCurrentFlow } = useFlowStore()
  const { refreshFlowList, refreshProjectList, openFlow, deleteCurrentFlow } = useFlowManager()

  const [contextMenu, setContextMenu] = useState<{ flowId: string; x: number; y: number } | null>(null)
  const [addSubFlowFlowId, setAddSubFlowFlowId] = useState<string | null>(null)
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [renameTarget, setRenameTarget] = useState<{ flowId: string; name: string } | null>(null)
  // Which groups' "子流程" subsections are expanded (key = projectId or '__unassigned__'); default collapsed
  const [expandedSubFlows, setExpandedSubFlows] = useState<Set<string>>(new Set())
  // Which project folders are collapsed (key = projectId or '__unassigned__'); default expanded (empty set)
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set())
  const contextMenuRef = useRef<HTMLDivElement>(null)

  const toggleSubFlows = (key: string) => {
    setExpandedSubFlows((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleProject = (key: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  useEffect(() => {
    refreshFlowList()
    refreshProjectList()
  }, [refreshFlowList, refreshProjectList])

  useEffect(() => {
    if (!contextMenu) return
    const handler = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [contextMenu])

  const handleAssign = async (flowId: string, projectId: string | null) => {
    await assignFlowToProject(flowId, projectId)
    await refreshFlowList()
    setContextMenu(null)
  }

  const handleDeleteProject = async (projectId: string, projectName: string) => {
    if (!window.confirm(`刪除專案「${projectName}」？\n此專案中的流程將移至「未分類」。`)) return
    await deleteProject(projectId)
    await refreshFlowList()
  }

  const handleCreateProject = async () => {
    const name = newProjectName.trim()
    if (!name) return
    await createProject(name)
    setNewProjectName('')
    setShowNewProjectDialog(false)
  }

  const handleRename = async () => {
    if (!renameTarget) return
    const newName = renameTarget.name.trim()
    if (!newName) return
    if (renameTarget.flowId === currentFlow?.id) {
      await renameCurrentFlow(newName)
    } else {
      const flow = await window.electronAPI.loadFlow(renameTarget.flowId)
      if (flow) {
        await window.electronAPI.saveFlow({ ...flow, name: newName, updatedAt: new Date().toISOString() })
      }
    }
    setRenameTarget(null)
    await refreshFlowList()
  }

  const handleDuplicateFlow = async (flowId: string) => {
    const flow = await window.electronAPI.loadFlow(flowId)
    if (!flow) return
    const now = new Date().toISOString()
    const copy = {
      ...flow,
      id: uuidv4(),
      name: `${flow.name}-副本`,
      createdAt: now,
      updatedAt: now,
    }
    await window.electronAPI.saveFlow(copy)
    await refreshFlowList()
    setContextMenu(null)
  }

  const handleDeleteFlow = async (flowId: string, flowName: string) => {
    if (!window.confirm(`刪除流程「${flowName}」？`)) return
    if (flowId === currentFlow?.id) {
      await deleteCurrentFlow()
    } else {
      await window.electronAPI.deleteFlow(flowId)
      await refreshFlowList()
    }
    setContextMenu(null)
  }

  // Group flows by projectId; treat flows whose project no longer exists as unassigned
  const knownProjectIds = new Set(projects.map((p) => p.id))
  const flowsByProject = new Map<string, typeof flows>()
  const unassignedFlows: typeof flows = []
  flows.forEach((flow) => {
    if (flow.projectId && knownProjectIds.has(flow.projectId)) {
      const arr = flowsByProject.get(flow.projectId) ?? []
      arr.push(flow)
      flowsByProject.set(flow.projectId, arr)
    } else {
      unassignedFlows.push(flow)
    }
  })

  const renderFlowItem = (flow: typeof flows[0], indent = 14) => {
    const isActive = currentFlow?.id === flow.id
    return (
      <div
        key={flow.id}
        onClick={() => openFlow(flow.id)}
        onContextMenu={(e) => {
          e.preventDefault()
          setContextMenu({ flowId: flow.id, x: e.clientX, y: e.clientY })
        }}
        style={{
          padding: '7px 14px 7px 0',
          paddingLeft: indent,
          cursor: 'pointer',
          background: isActive ? '#1e3a5f' : 'transparent',
          borderRight: isActive ? '3px solid #3b82f6' : '3px solid transparent',
        }}
        onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = '#243449' }}
        onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ flexShrink: 0, color: '#475569', fontSize: 11, lineHeight: 1 }}>📄</span>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div
            style={{
              fontSize: 13,
              color: isActive ? '#93c5fd' : '#cbd5e1',
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
              minWidth: 0,
            }}
          >
            {flow.name}
          </div>
          {flow.refCount > 0 && (
            <span
              title={`被 ${flow.refCount} 個流程引用`}
              style={{
                flexShrink: 0,
                fontSize: 9,
                color: '#a5b4fc',
                background: '#312e81',
                borderRadius: 4,
                padding: '1px 5px',
                fontWeight: 600,
              }}
            >
              ×{flow.refCount}
            </span>
          )}
        </div>
        <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
          {new Date(flow.updatedAt).toLocaleDateString('zh-TW', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </div>
          </div>
        </div>
      </div>
    )
  }

  // Render a group's flows: top-level test cases first, then a collapsible "子流程" subsection.
  // `indent` is the paddingLeft (px) for flow items at this level; the 子流程 folder nests one level deeper.
  const renderGroupBody = (groupKey: string, groupFlows: typeof flows, indent = 30) => {
    const testCases = groupFlows.filter((f) => f.refCount === 0)
    const subFlows = groupFlows
      .filter((f) => f.refCount > 0)
      .sort((a, b) => b.refCount - a.refCount)
    const expanded = expandedSubFlows.has(groupKey)
    return (
      <>
        {testCases.map((f) => renderFlowItem(f, indent))}
        {subFlows.length > 0 && (
          <>
            <div
              onClick={() => toggleSubFlows(groupKey)}
              style={{
                padding: '5px 14px 5px 0',
                paddingLeft: indent,
                fontSize: 11,
                color: '#818cf8',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                userSelect: 'none',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#243449' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
            >
              <span style={{ width: 10, flexShrink: 0, color: '#64748b' }}>{expanded ? '▾' : '▸'}</span>
              <span style={{ flexShrink: 0 }}>📁</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                子流程
              </span>
              <span style={{ color: '#475569', fontWeight: 500 }}>({subFlows.length})</span>
            </div>
            {expanded && subFlows.map((f) => renderFlowItem(f, indent + 16))}
          </>
        )}
      </>
    )
  }

  return (
    <div
      style={{
        width: 200,
        background: '#1e293b',
        borderRight: '1px solid #334155',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '12px 14px',
          borderBottom: '1px solid #334155',
          fontSize: 12,
          color: '#64748b',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        流程列表
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={() => setShowNewProjectDialog(true)}
            title="新增專案"
            style={{ background: 'transparent', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: 15 }}
          >
            ＋
          </button>
          <button
            onClick={() => { refreshFlowList(); refreshProjectList() }}
            title="重新整理"
            style={{ background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 14 }}
          >
            ↺
          </button>
        </div>
      </div>

      {/* Flow list grouped by project */}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {flows.length === 0 && (
          <div style={{ padding: '16px 14px', color: '#64748b', fontSize: 12 }}>尚無流程</div>
        )}

        {/* Projects */}
        {projects.map((proj) => {
          const projFlows = flowsByProject.get(proj.id) ?? []
          const collapsed = collapsedProjects.has(proj.id)
          return (
            <div key={proj.id}>
              <div
                onClick={() => toggleProject(proj.id)}
                style={{
                  padding: '6px 12px 6px 8px',
                  fontSize: 12,
                  color: '#cbd5e1',
                  fontWeight: 600,
                  cursor: 'pointer',
                  userSelect: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#243449' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
              >
                <span style={{ width: 10, flexShrink: 0, color: '#64748b' }}>{collapsed ? '▸' : '▾'}</span>
                <span style={{ flexShrink: 0 }}>📁</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {proj.name}
                </span>
                <span style={{ color: '#475569', fontSize: 11, fontWeight: 500 }}>({projFlows.length})</span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDeleteProject(proj.id, proj.name) }}
                  title="刪除專案"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#475569',
                    cursor: 'pointer',
                    fontSize: 12,
                    lineHeight: 1,
                    padding: '0 2px',
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#f87171' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#475569' }}
                >
                  ✕
                </button>
              </div>
              {!collapsed && (
                <div style={{ marginLeft: 13 }}>
                  {projFlows.length === 0 ? (
                    <div style={{ padding: '6px 14px 6px 18px', fontSize: 11, color: '#475569' }}>（空）</div>
                  ) : (
                    renderGroupBody(proj.id, projFlows, 18)
                  )}
                </div>
              )}
            </div>
          )
        })}

        {/* Unassigned flows */}
        {unassignedFlows.length > 0 && (
          (() => {
            // When there are no projects, show unassigned flows flat (no 未分類 folder).
            if (projects.length === 0) {
              return <div>{renderGroupBody('__unassigned__', unassignedFlows, 18)}</div>
            }
            const collapsed = collapsedProjects.has('__unassigned__')
            return (
              <div>
                <div
                  onClick={() => toggleProject('__unassigned__')}
                  style={{
                    padding: '6px 12px 6px 8px',
                    fontSize: 12,
                    color: '#94a3b8',
                    fontWeight: 600,
                    cursor: 'pointer',
                    userSelect: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#243449' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
                >
                  <span style={{ width: 10, flexShrink: 0, color: '#64748b' }}>{collapsed ? '▸' : '▾'}</span>
                  <span style={{ flexShrink: 0 }}>📁</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    未分類
                  </span>
                  <span style={{ color: '#475569', fontSize: 11, fontWeight: 500 }}>({unassignedFlows.length})</span>
                </div>
                {!collapsed && (
                  <div style={{ marginLeft: 13 }}>
                    {renderGroupBody('__unassigned__', unassignedFlows, 18)}
                  </div>
                )}
              </div>
            )
          })()
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            background: '#1e293b',
            border: '1px solid #334155',
            borderRadius: 8,
            zIndex: 9999,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            padding: '4px 0',
            minWidth: 160,
          }}
        >
          <div
            style={{
              padding: '4px 12px 6px',
              fontSize: 10,
              color: '#64748b',
              borderBottom: '1px solid #334155',
              marginBottom: 2,
            }}
          >
            移至專案
          </div>
          {projects.map((proj) => (
            <div
              key={proj.id}
              onClick={() => handleAssign(contextMenu.flowId, proj.id)}
              style={{
                padding: '7px 12px',
                cursor: 'pointer',
                color: '#cbd5e1',
                fontSize: 13,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#0f172a' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
            >
              📁 {proj.name}
            </div>
          ))}
          {projects.length > 0 && (
            <div
              onClick={() => handleAssign(contextMenu.flowId, null)}
              style={{
                padding: '7px 12px',
                cursor: 'pointer',
                color: '#94a3b8',
                fontSize: 12,
                borderTop: '1px solid #334155',
                marginTop: 2,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#0f172a' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
            >
              從專案中移除
            </div>
          )}
          <div style={{ borderTop: '1px solid #334155', margin: '4px 0' }} />
          {(() => {
            const disabled = !currentFlow || contextMenu.flowId === currentFlow.id
            return (
              <div
                onClick={() => {
                  if (disabled) { setContextMenu(null); return }
                  setAddSubFlowFlowId(contextMenu.flowId)
                  setContextMenu(null)
                }}
                style={{
                  padding: '7px 12px',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  color: disabled ? '#475569' : '#a5b4fc',
                  fontSize: 13,
                }}
                onMouseEnter={(e) => {
                  if (!disabled) (e.currentTarget as HTMLDivElement).style.background = '#0f172a'
                }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
              >
                ↳ 加入當前流程中
              </div>
            )
          })()}

          <div style={{ borderTop: '1px solid #334155', margin: '4px 0' }} />
          <div
            onClick={() => {
              const flow = flows.find((f) => f.id === contextMenu.flowId)
              setRenameTarget({ flowId: contextMenu.flowId, name: flow?.name ?? '' })
              setContextMenu(null)
            }}
            style={{ padding: '7px 12px', cursor: 'pointer', color: '#cbd5e1', fontSize: 13 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#0f172a' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
          >
            ✎ 重新命名
          </div>
          <div
            onClick={() => handleDuplicateFlow(contextMenu.flowId)}
            style={{ padding: '7px 12px', cursor: 'pointer', color: '#cbd5e1', fontSize: 13 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#0f172a' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
          >
            ⧉ 建立副本
          </div>
          <div
            onClick={() => {
              const flow = flows.find((f) => f.id === contextMenu.flowId)
              handleDeleteFlow(contextMenu.flowId, flow?.name ?? '')
            }}
            style={{ padding: '7px 12px', cursor: 'pointer', color: '#cbd5e1', fontSize: 13 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.color = '#f87171'; (e.currentTarget as HTMLDivElement).style.background = '#0f172a' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.color = '#cbd5e1'; (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
          >
            🗑 刪除流程
          </div>
        </div>
      )}

      {/* Add sub-flow modal */}
      {addSubFlowFlowId && currentFlow && (
        <CallFlowModal
          mode="appendAfter"
          preselectedFlowId={addSubFlowFlowId}
          onClose={() => setAddSubFlowFlowId(null)}
          onConfirm={async (callFlowAction: Action) => {
            const xMax = currentFlow.nodes.reduce((mx, n) => Math.max(mx, n.position.x), 0)
            const yMax = currentFlow.nodes.reduce((my, n) => Math.max(my, n.position.y), 0)
            addActionNode(callFlowAction, null)
            updateNode(callFlowAction.id, { position: { x: xMax + 300, y: yMax } })
            setAddSubFlowFlowId(null)
            const updated = useFlowStore.getState().currentFlow
            if (updated) await window.electronAPI.saveFlow(updated).catch(console.error)
          }}
        />
      )}

      {/* New project dialog */}
      {showNewProjectDialog && (
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
          onClick={(e) => { if (e.target === e.currentTarget) setShowNewProjectDialog(false) }}
        >
          <div
            style={{
              background: '#1e293b',
              border: '1px solid #334155',
              borderRadius: 12,
              padding: 24,
              minWidth: 300,
            }}
          >
            <h2 style={{ fontSize: 16, color: '#e2e8f0', marginBottom: 14, margin: '0 0 14px' }}>
              新增專案
            </h2>
            <input
              autoFocus
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateProject()
                if (e.key === 'Escape') setShowNewProjectDialog(false)
              }}
              placeholder="專案名稱"
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
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setShowNewProjectDialog(false); setNewProjectName('') }}
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
                onClick={handleCreateProject}
                disabled={!newProjectName.trim()}
                style={{
                  padding: '6px 16px',
                  borderRadius: 6,
                  border: 'none',
                  background: newProjectName.trim() ? '#3b82f6' : '#374151',
                  color: newProjectName.trim() ? '#fff' : '#6b7280',
                  cursor: newProjectName.trim() ? 'pointer' : 'not-allowed',
                  fontSize: 12,
                }}
              >
                建立
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename flow dialog */}
      {renameTarget && (
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
          onClick={(e) => { if (e.target === e.currentTarget) setRenameTarget(null) }}
        >
          <div
            style={{
              background: '#1e293b',
              border: '1px solid #334155',
              borderRadius: 12,
              padding: 24,
              minWidth: 300,
            }}
          >
            <h2 style={{ fontSize: 16, color: '#e2e8f0', marginBottom: 14, margin: '0 0 14px' }}>
              重新命名流程
            </h2>
            <input
              autoFocus
              value={renameTarget.name}
              onChange={(e) => setRenameTarget({ ...renameTarget, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRename()
                if (e.key === 'Escape') setRenameTarget(null)
              }}
              placeholder="流程名稱"
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
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setRenameTarget(null)}
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
                onClick={handleRename}
                disabled={!renameTarget.name.trim()}
                style={{
                  padding: '6px 16px',
                  borderRadius: 6,
                  border: 'none',
                  background: renameTarget.name.trim() ? '#3b82f6' : '#374151',
                  color: renameTarget.name.trim() ? '#fff' : '#6b7280',
                  cursor: renameTarget.name.trim() ? 'pointer' : 'not-allowed',
                  fontSize: 12,
                }}
              >
                儲存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
