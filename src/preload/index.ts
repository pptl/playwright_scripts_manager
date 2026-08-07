import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/types'
import type {
  Action,
  Flow,
  FlowNode,
  ExportConfig,
  ReplayNodeCompletePayload,
  RecordingStartPayload,
  TestFinishedPayload,
  Project,
  ActionUpdatedPayload,
} from '../shared/types'

// Expose a type-safe API to the renderer via window.electronAPI
contextBridge.exposeInMainWorld('electronAPI', {
  // Recording
  startRecording: (payload: RecordingStartPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.RECORDING_START, payload),
  stopRecording: () => ipcRenderer.invoke(IPC_CHANNELS.RECORDING_STOP),

  // Replay
  replayToNode: (nodes: FlowNode[], targetNodeId: string, speed: number, baseURL?: string, profileVars?: Record<string, string>, activeProfileId?: string, activeEnvironmentId?: string, envVars?: Record<string, string>, activeProjectId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.REPLAY_TO_NODE, { nodes, targetNodeId, speed, baseURL, profileVars, activeProfileId, activeEnvironmentId, envVars, activeProjectId }),

  // Storage
  saveFlow: (flow: Flow, touch?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.FLOW_SAVE, { flow, touch }),
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

  // Native file picker — copies the picks into fixtures/ and returns their stored paths
  pickFiles: (multiple?: boolean) => ipcRenderer.invoke(IPC_CHANNELS.PICK_FILES, { multiple }),
  normalizePaths: (paths: string[]) => ipcRenderer.invoke(IPC_CHANNELS.NORMALIZE_PATHS, paths),

  // Sub-flow support
  getFlow: (flowId: string) => ipcRenderer.invoke(IPC_CHANNELS.FLOW_GET, { flowId }),
  checkFlowCycle: (currentFlowId: string, candidateSubFlowId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FLOW_CHECK_CYCLE, { currentFlowId, candidateSubFlowId }),

  // Workspace — the user-chosen folder everything is read from / written to
  getWorkspace: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GET),
  pickWorkspace: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_PICK),
  setWorkspace: (dir: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SET, dir),
  forgetWorkspace: (dir: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_FORGET, dir),
  revealWorkspace: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REVEAL),

  // Browsers — "is Chromium installed?" comes back on WorkspaceInfo, not its own channel.
  installBrowser: () => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_INSTALL),

  // Private data — the vault key stays in the main process; the renderer holds only
  // ciphertext, plus whatever single value it explicitly asks to reveal.
  getVaultStatus: () => ipcRenderer.invoke(IPC_CHANNELS.VAULT_STATUS),
  setupVault: (passphrase: string) => ipcRenderer.invoke(IPC_CHANNELS.VAULT_SETUP, passphrase),
  unlockVault: (passphrase: string) => ipcRenderer.invoke(IPC_CHANNELS.VAULT_UNLOCK, passphrase),
  lockVault: () => ipcRenderer.invoke(IPC_CHANNELS.VAULT_LOCK),
  changeVaultPassphrase: (oldPassphrase: string, newPassphrase: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.VAULT_CHANGE_PASSPHRASE, { oldPassphrase, newPassphrase }),
  encryptSecret: (plain: string) => ipcRenderer.invoke(IPC_CHANNELS.SECRET_ENCRYPT, plain),
  revealSecret: (envelope: string) => ipcRenderer.invoke(IPC_CHANNELS.SECRET_REVEAL, envelope),
  writeSecretsFile: (flow: Flow, config: ExportConfig) =>
    ipcRenderer.invoke(IPC_CHANNELS.SECRETS_FILE_WRITE, { flow, config }),

  // Projects
  saveProject: (project: Project) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SAVE, { project }),
  loadProject: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LOAD, { projectId }),
  listProjects: () => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LIST),
  deleteProject: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_DELETE, projectId),

  // Event listeners (Main → Renderer)
  onActionCaptured: (cb: (action: Action) => void) => {
    const handler = (_: Electron.IpcRendererEvent, action: Action) => cb(action)
    ipcRenderer.on(IPC_CHANNELS.ACTION_CAPTURED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ACTION_CAPTURED, handler)
  },
  onActionUpdated: (cb: (payload: ActionUpdatedPayload) => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: ActionUpdatedPayload) => cb(payload)
    ipcRenderer.on(IPC_CHANNELS.ACTION_UPDATED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ACTION_UPDATED, handler)
  },
  onActionRemoved: (cb: (actionId: string) => void) => {
    const handler = (_: Electron.IpcRendererEvent, actionId: string) => cb(actionId)
    ipcRenderer.on(IPC_CHANNELS.ACTION_REMOVED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ACTION_REMOVED, handler)
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
  onWorkspaceReload: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on(IPC_CHANNELS.WORKSPACE_RELOAD, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WORKSPACE_RELOAD, handler)
  },
})
