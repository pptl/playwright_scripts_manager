import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/types'
import type {
  Action,
  Flow,
  FlowNode,
  ResolutionContext,
  ReplayNodeCompletePayload,
  RecordingStartPayload,
  TestFinishedPayload,
  Project,
  ActionUpdatedPayload,
} from '../shared/types'
import type { ElectronAPI } from '../shared/electronAPI'

/**
 * One Main → Renderer subscription wrapper: registers the listener and returns its unsubscribe.
 * Every `onX` below is this shape and nothing else — only the channel and payload type differ.
 */
function subscribe<T>(channel: string) {
  return (cb: (payload: T) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: T): void => cb(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

// The API exposed to the renderer as window.electronAPI. `satisfies` pins it to the shared
// declaration, so a signature can no longer drift out of sync with the renderer's view of it.
const api = {
  // Recording
  startRecording: (payload: RecordingStartPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.RECORDING_START, payload),
  stopRecording: () => ipcRenderer.invoke(IPC_CHANNELS.RECORDING_STOP),

  // Replay
  replayToNode: (nodes: FlowNode[], targetNodeId: string, speed: number, baseURL?: string, ctx?: ResolutionContext) =>
    ipcRenderer.invoke(IPC_CHANNELS.REPLAY_TO_NODE, { nodes, targetNodeId, speed, baseURL, ctx }),
  cancelReplay: () => ipcRenderer.invoke(IPC_CHANNELS.REPLAY_CANCEL),

  // Storage
  saveFlow: (flow: Flow, touch?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.FLOW_SAVE, { flow, touch }),
  loadFlow: (flowId: string) => ipcRenderer.invoke(IPC_CHANNELS.FLOW_LOAD, { flowId }),
  listFlows: () => ipcRenderer.invoke(IPC_CHANNELS.FLOW_LIST),
  deleteFlow: (flowId: string) => ipcRenderer.invoke(IPC_CHANNELS.FLOW_DELETE, flowId),

  // Export
  exportScripts: (flow: Flow, ctx: ResolutionContext) =>
    ipcRenderer.invoke(IPC_CHANNELS.EXPORT_SCRIPTS, { flow, ctx }),

  // Run tests
  runTests: (flow: Flow, ctx: ResolutionContext) =>
    ipcRenderer.invoke(IPC_CHANNELS.RUN_TESTS, { flow, ctx }),
  cancelTests: () => ipcRenderer.invoke(IPC_CHANNELS.TEST_CANCEL),
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
  writeSecretsFile: (flow: Flow, ctx: ResolutionContext) =>
    ipcRenderer.invoke(IPC_CHANNELS.SECRETS_FILE_WRITE, { flow, ctx }),

  // Projects
  saveProject: (project: Project) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SAVE, { project }),
  loadProject: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LOAD, { projectId }),
  listProjects: () => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LIST),
  deleteProject: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_DELETE, projectId),

  // Event listeners (Main → Renderer)
  onActionCaptured: subscribe<Action>(IPC_CHANNELS.ACTION_CAPTURED),
  onActionUpdated: subscribe<ActionUpdatedPayload>(IPC_CHANNELS.ACTION_UPDATED),
  onActionRemoved: subscribe<string>(IPC_CHANNELS.ACTION_REMOVED),
  onReplayNodeStart: subscribe<string>(IPC_CHANNELS.REPLAY_NODE_START),
  onReplayNodeComplete: subscribe<ReplayNodeCompletePayload>(IPC_CHANNELS.REPLAY_NODE_COMPLETE),
  onReplayFinished: subscribe<void>(IPC_CHANNELS.REPLAY_FINISHED),
  onReplayError: subscribe<string>(IPC_CHANNELS.REPLAY_ERROR),
  onReplayCancelled: subscribe<void>(IPC_CHANNELS.REPLAY_CANCELLED),
  onTestOutput: subscribe<string>(IPC_CHANNELS.TEST_OUTPUT),
  onTestFinished: subscribe<TestFinishedPayload>(IPC_CHANNELS.TEST_FINISHED),
  onWorkspaceReload: subscribe<void>(IPC_CHANNELS.WORKSPACE_RELOAD),
} satisfies ElectronAPI

contextBridge.exposeInMainWorld('electronAPI', api)
