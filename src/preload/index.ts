import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/types'
import type {
  Action,
  ActionType,
  Flow,
  FlowNode,
  ExportConfig,
  ReplayNodeCompletePayload,
  RecordingStartPayload,
  TestFinishedPayload,
} from '../shared/types'

// Expose a type-safe API to the renderer via window.electronAPI
contextBridge.exposeInMainWorld('electronAPI', {
  // Browser
  launchBrowser: () => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_LAUNCH),
  closeBrowser: () => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CLOSE),

  // Recording
  startRecording: (payload: RecordingStartPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.RECORDING_START, payload),
  stopRecording: () => ipcRenderer.invoke(IPC_CHANNELS.RECORDING_STOP),

  // Replay
  replayToNode: (nodes: FlowNode[], targetNodeId: string, speed: number, baseURL?: string, profileVars?: Record<string, string>, activeProfileId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.REPLAY_TO_NODE, { nodes, targetNodeId, speed, baseURL, profileVars, activeProfileId }),
  stopReplay: () => ipcRenderer.invoke(IPC_CHANNELS.REPLAY_STOP),

  // Storage
  saveFlow: (flow: Flow) => ipcRenderer.invoke(IPC_CHANNELS.FLOW_SAVE, { flow }),
  loadFlow: (flowId: string) => ipcRenderer.invoke(IPC_CHANNELS.FLOW_LOAD, { flowId }),
  listFlows: () => ipcRenderer.invoke(IPC_CHANNELS.FLOW_LIST),
  deleteFlow: (flowId: string) => ipcRenderer.invoke(IPC_CHANNELS.FLOW_DELETE, flowId),

  // Export
  exportScripts: (flow: Flow, config: ExportConfig) =>
    ipcRenderer.invoke(IPC_CHANNELS.EXPORT_SCRIPTS, { flow, config }),

  // Run tests
  runTests: (flow: Flow, config: ExportConfig) =>
    ipcRenderer.invoke(IPC_CHANNELS.RUN_TESTS, { flow, config }),
  showReport: () => ipcRenderer.invoke(IPC_CHANNELS.SHOW_REPORT),

  // Assertion pick
  startAssertionPick: (assertionType: ActionType) =>
    ipcRenderer.invoke(IPC_CHANNELS.START_ASSERTION_PICK, assertionType),

  // Sub-flow support
  getFlow: (flowId: string) => ipcRenderer.invoke(IPC_CHANNELS.FLOW_GET, { flowId }),
  checkFlowCycle: (currentFlowId: string, candidateSubFlowId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FLOW_CHECK_CYCLE, { currentFlowId, candidateSubFlowId }),

  // Event listeners (Main → Renderer)
  onActionCaptured: (cb: (action: Action) => void) => {
    const handler = (_: Electron.IpcRendererEvent, action: Action) => cb(action)
    ipcRenderer.on(IPC_CHANNELS.ACTION_CAPTURED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ACTION_CAPTURED, handler)
  },
  onReplayNodeStart: (cb: (nodeId: string) => void) => {
    const handler = (_: Electron.IpcRendererEvent, nodeId: string) => cb(nodeId)
    ipcRenderer.on(IPC_CHANNELS.REPLAY_NODE_START, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.REPLAY_NODE_START, handler)
  },
  onReplayNodeComplete: (cb: (payload: ReplayNodeCompletePayload) => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: ReplayNodeCompletePayload) =>
      cb(payload)
    ipcRenderer.on(IPC_CHANNELS.REPLAY_NODE_COMPLETE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.REPLAY_NODE_COMPLETE, handler)
  },
  onReplayFinished: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on(IPC_CHANNELS.REPLAY_FINISHED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.REPLAY_FINISHED, handler)
  },
  onReplayError: (cb: (error: string) => void) => {
    const handler = (_: Electron.IpcRendererEvent, error: string) => cb(error)
    ipcRenderer.on(IPC_CHANNELS.REPLAY_ERROR, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.REPLAY_ERROR, handler)
  },
  onTestOutput: (cb: (line: string) => void) => {
    const handler = (_: Electron.IpcRendererEvent, line: string) => cb(line)
    ipcRenderer.on(IPC_CHANNELS.TEST_OUTPUT, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TEST_OUTPUT, handler)
  },
  onTestFinished: (cb: (payload: TestFinishedPayload) => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: TestFinishedPayload) => cb(payload)
    ipcRenderer.on(IPC_CHANNELS.TEST_FINISHED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TEST_FINISHED, handler)
  },
  onAssertionPickCancelled: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on(IPC_CHANNELS.ASSERTION_PICK_CANCELLED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ASSERTION_PICK_CANCELLED, handler)
  },
})
