import React, { useEffect, useState, useRef } from 'react'
import { useFlowStore } from '../../stores/flowStore'
import { useFlowManager } from '../../hooks/useFlowStore'

export function FlowList() {
  const { flows, currentFlow, projects, assignFlowToProject, createProject, deleteProject } = useFlowStore()
  const { refreshFlowList, refreshProjectList, openFlow } = useFlowManager()

  const [contextMenu, setContextMenu] = useState<{ flowId: string; x: number; y: number } | null>(null)
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const contextMenuRef = useRef<HTMLDivElement>(null)

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

  const renderFlowItem = (flow: typeof flows[0]) => {
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
          padding: '10px 14px',
          cursor: 'pointer',
          background: isActive ? '#1e3a5f' : 'transparent',
          borderBottom: '1px solid #0f172a',
          borderLeft: isActive ? '3px solid #3b82f6' : '3px solid transparent',
        }}
      >
        <div
          style={{
            fontSize: 13,
            color: isActive ? '#93c5fd' : '#cbd5e1',
            fontWeight: 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {flow.name}
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
          return (
            <div key={proj.id}>
              <div
                style={{
                  padding: '5px 14px',
                  fontSize: 10,
                  color: '#64748b',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  background: '#0f172a',
                  borderBottom: '1px solid #1e293b',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <span>📁 {proj.name}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ color: '#334155', fontSize: 10 }}>{projFlows.length}</span>
                  <button
                    onClick={() => handleDeleteProject(proj.id, proj.name)}
                    title="刪除專案"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: '#475569',
                      cursor: 'pointer',
                      fontSize: 12,
                      lineHeight: 1,
                      padding: '0 2px',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#f87171' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#475569' }}
                  >
                    ✕
                  </button>
                </div>
              </div>
              {projFlows.map(renderFlowItem)}
            </div>
          )
        })}

        {/* Unassigned flows */}
        {unassignedFlows.length > 0 && (
          <div>
            {projects.length > 0 && (
              <div
                style={{
                  padding: '5px 14px',
                  fontSize: 10,
                  color: '#475569',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  background: '#0f172a',
                  borderBottom: '1px solid #1e293b',
                }}
              >
                未分類
              </div>
            )}
            {unassignedFlows.map(renderFlowItem)}
          </div>
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
        </div>
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
    </div>
  )
}
