import React, { useEffect } from 'react'
import { Toolbar } from './components/Toolbar/Toolbar'
import { FlowCanvas } from './components/Canvas/FlowCanvas'
import { FlowList } from './components/FlowList/FlowList'
import { VariableList } from './components/VariableList/VariableList'
import { PropertyPanel } from './components/PropertyPanel/PropertyPanel'
import { SessionVarList } from './components/SessionVarList/SessionVarList'
import { ProfileVarList } from './components/ProfileVarList/ProfileVarList'
import { ProjectEnvVarList } from './components/ProjectEnvVar/ProjectEnvVarList'
import { ConfirmHost } from './components/common/ConfirmDialog'
import { VaultHost } from './components/Vault/VaultHost'
import { WelcomeScreen } from './components/Welcome/WelcomeScreen'
import { usePlaywrightEvents } from './hooks/usePlaywrightEvents'
import { useUndoRedo } from './hooks/useUndoRedo'
import { useFlowStore } from './stores/flowStore'
import { useWorkspaceStore } from './stores/workspaceStore'

export default function App() {
  // Register IPC event listeners exactly once here
  usePlaywrightEvents()
  // Register Ctrl+Z / Ctrl+Shift+Z undo/redo shortcuts
  useUndoRedo()

  const { selectedNodeId, currentFlow } = useFlowStore()
  const { info, loading, load } = useWorkspaceStore()

  useEffect(() => {
    void load()
  }, [load])

  // Nothing below may mount without a workspace: FlowList fetches the flow list
  // on mount, and every storage call throws until a root is set.
  if (loading) return <div style={splashStyle} />
  if (!info?.root) {
    return (
      <>
        <WelcomeScreen />
        <ConfirmHost />
      </>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Toolbar />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div style={{ display: 'flex', flexDirection: 'column', width: 200, flexShrink: 0 }}>
          <FlowList />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <FlowCanvas />
          {currentFlow && <PropertyPanel />}
        </div>
        {selectedNodeId && (
          <div style={{ display: 'flex', flexDirection: 'column', width: 200, flexShrink: 0, borderLeft: '1px solid #334155', overflowY: 'auto', overflowX: 'hidden' }}>
            <VariableList />
            <ProfileVarList />
            <ProjectEnvVarList />
            <SessionVarList />
          </div>
        )}
      </div>
      <ConfirmHost />
      <VaultHost />
    </div>
  )
}

const splashStyle: React.CSSProperties = { height: '100vh', background: '#0f172a' }
