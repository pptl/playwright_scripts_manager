import React, { useEffect, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useFlowStore } from '../../stores/flowStore'
import { useProjectStore } from '../../stores/projectStore'
import { useFlowManager } from '../../hooks/useFlowManager'
import { CallFlowModal } from '../CallFlowModal/CallFlowModal'
import type { Action } from '@shared/types'
import { DEFAULT_PROJECT_ID, DEFAULT_ENV_NAME, DEFAULT_DOMAIN } from '@shared/types'
import { resolveProjectId } from '@shared/projectResolution'
import { confirm } from '../../stores/confirmStore'
import { persistFlow } from '../../stores/persistence'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { Input } from '../common/Input'
import { Menu, MenuItem, MenuCaption, MenuDivider } from '../common/Menu'
import { token, radius } from '../../styles/tokens'

export function FlowList() {
  const { flows, currentFlow, addActionNode, updateNode, runAsOneHistoryStep, assignFlowToProject, renameCurrentFlow } = useFlowStore()
  const { projects, refreshProjects, createProject, renameProject } = useProjectStore()
  // The two cascade actions come from the coordinator, not the store: deleting or
  // duplicating a project also deletes or copies its flows.
  const { refreshFlowList, openFlow, deleteCurrentFlow, deleteProjectWithFlows, duplicateProjectWithFlows } = useFlowManager()

  const [contextMenu, setContextMenu] = useState<{ flowId: string; x: number; y: number } | null>(null)
  const [projectMenu, setProjectMenu] = useState<{ projectId: string; name: string; x: number; y: number } | null>(null)
  const [addSubFlowFlowId, setAddSubFlowFlowId] = useState<string | null>(null)
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectEnvName, setNewProjectEnvName] = useState(DEFAULT_ENV_NAME)
  const [newProjectDomain, setNewProjectDomain] = useState(DEFAULT_DOMAIN)
  const [renameTarget, setRenameTarget] = useState<{ flowId: string; name: string } | null>(null)
  const [renameProjectTarget, setRenameProjectTarget] = useState<{ projectId: string; name: string } | null>(null)
  // Which groups' "子流程" subsections are expanded (key = projectId); default collapsed
  const [expandedSubFlows, setExpandedSubFlows] = useState<Set<string>>(new Set())
  // Which project folders are collapsed (key = projectId); default expanded (empty set)
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set())

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
    refreshProjects()
  }, [refreshFlowList, refreshProjects])

  // Both context menus dismiss via <Menu>'s own transparent catcher — no refs,
  // no document listeners, no teardown.

  const handleRenameProject = async () => {
    if (!renameProjectTarget) return
    const newName = renameProjectTarget.name.trim()
    if (!newName) return
    await renameProject(renameProjectTarget.projectId, newName)
    setRenameProjectTarget(null)
  }

  const handleAssign = async (flowId: string, projectId: string | null) => {
    await assignFlowToProject(flowId, projectId)
    await refreshFlowList()
    setContextMenu(null)
  }

  const handleDeleteProject = async (projectId: string, projectName: string) => {
    const ok = await confirm({
      title: `刪除專案「${projectName}」？`,
      detail: '此專案中的所有流程也將一併刪除，且無法復原。',
      confirmLabel: '刪除',
      danger: true,
    })
    if (!ok) return
    await deleteProjectWithFlows(projectId)
  }

  const handleDuplicateProject = async (projectId: string, projectName: string) => {
    const ok = await confirm({
      title: `建立專案「${projectName}」的副本？`,
      detail: '將一併複製此專案中的所有流程。',
      confirmLabel: '建立副本',
    })
    if (!ok) return
    await duplicateProjectWithFlows(projectId)
    setProjectMenu(null)
  }

  /** Also the Escape / backdrop path, so a dismissed dialog never keeps a stale draft. */
  const closeNewProjectDialog = () => {
    setShowNewProjectDialog(false)
    setNewProjectName('')
    setNewProjectEnvName(DEFAULT_ENV_NAME)
    setNewProjectDomain(DEFAULT_DOMAIN)
  }

  const handleCreateProject = async () => {
    const name = newProjectName.trim()
    if (!name) return
    const envName = newProjectEnvName.trim() || DEFAULT_ENV_NAME
    const domain = newProjectDomain.trim() || DEFAULT_DOMAIN
    await createProject(name, envName, domain)
    closeNewProjectDialog()
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
        await persistFlow(
          { ...flow, name: newName, updatedAt: new Date().toISOString() },
          { label: '流程改名後存檔失敗' },
        )
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
    await persistFlow(copy, { label: '複製流程存檔失敗' })
    await refreshFlowList()
    setContextMenu(null)
  }

  const handleDeleteFlow = async (flowId: string, flowName: string) => {
    const ok = await confirm({
      title: `刪除流程「${flowName}」？`,
      detail: '此操作無法復原。',
      confirmLabel: '刪除',
      danger: true,
    })
    if (!ok) return
    if (flowId === currentFlow?.id) {
      await deleteCurrentFlow()
    } else {
      await window.electronAPI.deleteFlow(flowId)
      await refreshFlowList()
    }
    setContextMenu(null)
  }

  // Group flows by projectId; flows with no projectId — or one pointing to a project that
  // no longer exists — fall back to the reserved default project ("未分類").
  const knownProjectIds = new Set(projects.map((p) => p.id))
  const flowsByProject = new Map<string, typeof flows>()
  flows.forEach((flow) => {
    const pid = resolveProjectId(flow, knownProjectIds)
    const arr = flowsByProject.get(pid) ?? []
    arr.push(flow)
    flowsByProject.set(pid, arr)
  })

  // Render order: regular projects (as listed), with 未分類 pinned to the bottom.
  const orderedProjects = [
    ...projects.filter((p) => p.id !== DEFAULT_PROJECT_ID),
    ...projects.filter((p) => p.id === DEFAULT_PROJECT_ID),
  ]

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
          background: isActive ? token.bgSelected : 'transparent',
          borderRight: isActive ? `3px solid ${token.accent}` : '3px solid transparent',
        }}
        onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = token.bgHover }}
        onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ flexShrink: 0, color: token.borderStrong, fontSize: 11, lineHeight: 1 }}>📄</span>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div
            style={{
              fontSize: 13,
              color: isActive ? token.accentFg : token.textBody,
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
                color: token.accentAltSoft,
                background: SUBFLOW_BADGE_BG,
                borderRadius: radius.sm,
                padding: '1px 5px',
                fontWeight: 600,
              }}
            >
              ×{flow.refCount}
            </span>
          )}
        </div>
        <div style={{ fontSize: 10, color: token.textMuted, marginTop: 2 }}>
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
                color: token.accentAltFg,
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                userSelect: 'none',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = token.bgHover }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
            >
              <span style={{ width: 10, flexShrink: 0, color: token.textMuted }}>{expanded ? '▾' : '▸'}</span>
              <span style={{ flexShrink: 0 }}>📁</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                子流程
              </span>
              <span style={{ color: token.borderStrong, fontWeight: 500 }}>({subFlows.length})</span>
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
        background: token.bgPanel,
        borderRight: `1px solid ${token.border}`,
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '12px 14px',
          borderBottom: `1px solid ${token.border}`,
          fontSize: 12,
          color: token.textMuted,
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
            style={{ background: 'transparent', border: 'none', color: token.accent, cursor: 'pointer', fontSize: 15 }}
          >
            ＋
          </button>
          <button
            onClick={() => { refreshFlowList(); refreshProjects() }}
            title="重新整理"
            style={{ background: 'transparent', border: 'none', color: token.textMuted, cursor: 'pointer', fontSize: 14 }}
          >
            ↺
          </button>
        </div>
      </div>

      {/* Flow list grouped by project */}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {flows.length === 0 && (
          <div style={{ padding: '16px 14px', color: token.textMuted, fontSize: 12 }}>尚無流程</div>
        )}

        {/* Projects (未分類 pinned to the bottom) */}
        {orderedProjects.map((proj) => {
          const projFlows = flowsByProject.get(proj.id) ?? []
          const collapsed = collapsedProjects.has(proj.id)
          const isDefault = proj.id === DEFAULT_PROJECT_ID
          return (
            <div key={proj.id}>
              <div
                onClick={() => toggleProject(proj.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  // 未分類 cannot be renamed or deleted — no context menu.
                  if (isDefault) return
                  setProjectMenu({ projectId: proj.id, name: proj.name, x: e.clientX, y: e.clientY })
                }}
                style={{
                  padding: '6px 12px 6px 8px',
                  fontSize: 12,
                  color: token.textBody,
                  fontWeight: 600,
                  cursor: 'pointer',
                  userSelect: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = token.bgHover }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
              >
                <span style={{ width: 10, flexShrink: 0, color: token.textMuted }}>{collapsed ? '▸' : '▾'}</span>
                <span style={{ flexShrink: 0 }}>📁</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {proj.name}
                </span>
                <span style={{ color: token.borderStrong, fontSize: 11, fontWeight: 500 }}>({projFlows.length})</span>
              </div>
              {!collapsed && (
                <div style={{ marginLeft: 13 }}>
                  {projFlows.length === 0 ? (
                    <div style={{ padding: '6px 14px 6px 18px', fontSize: 11, color: token.borderStrong }}>（空）</div>
                  ) : (
                    renderGroupBody(proj.id, projFlows, 18)
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Project context menu */}
      {projectMenu && (
        <Menu x={projectMenu.x} y={projectMenu.y} minWidth={150} onClose={() => setProjectMenu(null)}>
          <MenuItem
            icon="✎"
            label="重新命名"
            onClick={() => {
              setRenameProjectTarget({ projectId: projectMenu.projectId, name: projectMenu.name })
              setProjectMenu(null)
            }}
          />
          <MenuItem
            icon="⧉"
            label="建立副本"
            onClick={() => handleDuplicateProject(projectMenu.projectId, projectMenu.name)}
          />
          <MenuItem
            icon="🗑"
            label="刪除專案"
            danger
            onClick={() => {
              handleDeleteProject(projectMenu.projectId, projectMenu.name)
              setProjectMenu(null)
            }}
          />
        </Menu>
      )}

      {/* Context menu */}
      {contextMenu && (
        <Menu x={contextMenu.x} y={contextMenu.y} minWidth={160} onClose={() => setContextMenu(null)}>
          <MenuCaption>移至專案</MenuCaption>
          {orderedProjects.map((proj) => (
            <MenuItem
              key={proj.id}
              icon="📁"
              label={proj.name}
              onClick={() => handleAssign(contextMenu.flowId, proj.id)}
            />
          ))}
          <MenuDivider />
          <MenuItem
            icon="↳"
            label="加入當前流程中"
            accent
            disabled={!currentFlow || contextMenu.flowId === currentFlow.id}
            onClick={() => {
              setAddSubFlowFlowId(contextMenu.flowId)
              setContextMenu(null)
            }}
          />
          <MenuDivider />
          <MenuItem
            icon="✎"
            label="重新命名"
            onClick={() => {
              const flow = flows.find((f) => f.id === contextMenu.flowId)
              setRenameTarget({ flowId: contextMenu.flowId, name: flow?.name ?? '' })
              setContextMenu(null)
            }}
          />
          <MenuItem icon="⧉" label="建立副本" onClick={() => handleDuplicateFlow(contextMenu.flowId)} />
          <MenuItem
            icon="🗑"
            label="刪除流程"
            danger
            onClick={() => {
              const flow = flows.find((f) => f.id === contextMenu.flowId)
              handleDeleteFlow(contextMenu.flowId, flow?.name ?? '')
            }}
          />
        </Menu>
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
            // Add + position is one gesture — batch so a single Ctrl+Z reverses both.
            // A trailing manual save is still required here: the position-only updateNode
            // call intentionally skips auto-save (it assumes a drag debounce owns it, which
            // is not the case for this one-time placement), so nothing else persists it.
            runAsOneHistoryStep(() => {
              addActionNode(callFlowAction, null)
              updateNode(callFlowAction.id, { position: { x: xMax + 300, y: yMax } })
            })
            setAddSubFlowFlowId(null)
            const updated = useFlowStore.getState().currentFlow
            if (updated) {
              await persistFlow(updated, { label: '加入子流程後存檔失敗' })
            }
          }}
        />
      )}

      {/* New project dialog */}
      {showNewProjectDialog && (
        <Modal
          title="新增專案"
          minWidth={300}
          onClose={closeNewProjectDialog}
          footer={
            <>
              <Button onClick={closeNewProjectDialog}>取消</Button>
              <Button tone="primary" onClick={handleCreateProject} disabled={!newProjectName.trim()}>
                建立
              </Button>
            </>
          }
        >
          <label style={newProjectLabelStyle}>
            專案名稱
            <Input
              autoFocus
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={submitOnEnter(handleCreateProject)}
              placeholder="例：簽核系統"
              style={newProjectInputStyle}
            />
          </label>
          <label style={newProjectLabelStyle}>
            環境名稱
            <Input
              value={newProjectEnvName}
              onChange={(e) => setNewProjectEnvName(e.target.value)}
              onKeyDown={submitOnEnter(handleCreateProject)}
              placeholder="例：DEV / UAT / PRD"
              style={newProjectInputStyle}
            />
          </label>
          <label style={newProjectLabelStyle}>
            domain
            <Input
              value={newProjectDomain}
              onChange={(e) => setNewProjectDomain(e.target.value)}
              onKeyDown={submitOnEnter(handleCreateProject)}
              placeholder="http://localhost:3000/"
              style={newProjectInputStyle}
            />
          </label>
        </Modal>
      )}

      {/* Rename flow dialog */}
      {renameTarget && (
        <Modal
          title="重新命名流程"
          minWidth={300}
          onClose={() => setRenameTarget(null)}
          footer={
            <>
              <Button onClick={() => setRenameTarget(null)}>取消</Button>
              <Button tone="primary" onClick={handleRename} disabled={!renameTarget.name.trim()}>
                儲存
              </Button>
            </>
          }
        >
          <Input
            autoFocus
            value={renameTarget.name}
            onChange={(e) => setRenameTarget({ ...renameTarget, name: e.target.value })}
            onKeyDown={submitOnEnter(handleRename)}
            placeholder="流程名稱"
          />
        </Modal>
      )}

      {/* Rename project dialog */}
      {renameProjectTarget && (
        <Modal
          title="重新命名專案"
          minWidth={300}
          onClose={() => setRenameProjectTarget(null)}
          footer={
            <>
              <Button onClick={() => setRenameProjectTarget(null)}>取消</Button>
              <Button
                tone="primary"
                onClick={handleRenameProject}
                disabled={!renameProjectTarget.name.trim()}
              >
                儲存
              </Button>
            </>
          }
        >
          <Input
            autoFocus
            value={renameProjectTarget.name}
            onChange={(e) => setRenameProjectTarget({ ...renameProjectTarget, name: e.target.value })}
            onKeyDown={submitOnEnter(handleRenameProject)}
            placeholder="專案名稱"
          />
        </Modal>
      )}
    </div>
  )
}

/** Deep indigo fill behind the ×N sub-flow reference count. Appears only here. */
const SUBFLOW_BADGE_BG = '#312e81'

/** Escape is handled by <Modal>; the inputs only need to submit. */
const submitOnEnter = (submit: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === 'Enter') submit()
}

const newProjectLabelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: 12,
  color: token.textSecondary,
  fontSize: 13,
}

const newProjectInputStyle: React.CSSProperties = { marginTop: 6 }
