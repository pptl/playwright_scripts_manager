import React from 'react'
import { Toolbar } from './components/Toolbar/Toolbar'
import { FlowCanvas } from './components/Canvas/FlowCanvas'
import { FlowList } from './components/FlowList/FlowList'
import { VariableList } from './components/VariableList/VariableList'
import { PropertyPanel } from './components/PropertyPanel/PropertyPanel'
import { SessionVarList } from './components/SessionVarList/SessionVarList'
import { usePlaywrightEvents } from './hooks/usePlaywrightEvents'
import { useFlowStore } from './stores/flowStore'

export default function App() {
  // Register IPC event listeners exactly once here
  usePlaywrightEvents()

  const { selectedNodeId } = useFlowStore()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Toolbar />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div style={{ display: 'flex', flexDirection: 'column', width: 200, flexShrink: 0 }}>
          <FlowList />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <FlowCanvas />
          {selectedNodeId && <PropertyPanel />}
        </div>
        {selectedNodeId && (
          <div style={{ display: 'flex', flexDirection: 'column', width: 200, flexShrink: 0, borderLeft: '1px solid #334155', overflow: 'hidden' }}>
            <VariableList />
            <SessionVarList />
          </div>
        )}
      </div>
    </div>
  )
}
