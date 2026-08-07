import type { Action, ActionUpdatedPayload, Flow, FlowNode, FlowListItem, ExportConfig, ReplayNodeCompletePayload, RecordingStartPayload, TestFinishedPayload, Project, WorkspaceInfo, VaultStatus } from '../../shared/types'

export interface ElectronAPI {
  startRecording: (payload: RecordingStartPayload) => Promise<void>
  stopRecording: () => Promise<void>
  replayToNode: (nodes: FlowNode[], targetNodeId: string, speed: number, baseURL?: string, profileVars?: Record<string, string>, activeProfileId?: string, activeEnvironmentId?: string, envVars?: Record<string, string>, activeProjectId?: string) => Promise<void>
  /** `touch: false` writes without bumping updatedAt (drag repositioning). */
  saveFlow: (flow: Flow, touch?: boolean) => Promise<void>
  loadFlow: (flowId: string) => Promise<Flow | null>
  listFlows: () => Promise<FlowListItem[]>
  deleteFlow: (flowId: string) => Promise<void>
  exportScripts: (flow: Flow, config: ExportConfig) => Promise<string>
  runTests: (flow: Flow, config: ExportConfig) => Promise<void>
  showReport: () => Promise<void>
  onActionCaptured: (cb: (action: Action) => void) => () => void
  onActionUpdated: (cb: (payload: ActionUpdatedPayload) => void) => () => void
  onActionRemoved: (cb: (actionId: string) => void) => () => void
  onReplayNodeStart: (cb: (nodeId: string) => void) => () => void
  onReplayNodeComplete: (cb: (payload: ReplayNodeCompletePayload) => void) => () => void
  onReplayFinished: (cb: () => void) => () => void
  onReplayError: (cb: (error: string) => void) => () => void
  onTestOutput: (cb: (line: string) => void) => () => void
  onTestFinished: (cb: (payload: TestFinishedPayload) => void) => () => void
  /** Opens the native file picker; returns paths already copied into fixtures/. */
  pickFiles: (multiple?: boolean) => Promise<string[]>
  /** Rewrites absolute paths as workspace-relative (copying in from outside it). */
  normalizePaths: (paths: string[]) => Promise<string[]>
  getFlow: (flowId: string) => Promise<Flow | null>
  checkFlowCycle: (currentFlowId: string, candidateSubFlowId: string) => Promise<boolean>
  saveProject: (project: Project) => Promise<void>
  loadProject: (projectId: string) => Promise<Project | null>
  listProjects: () => Promise<Pick<Project, 'id' | 'name' | 'updatedAt'>[]>
  deleteProject: (projectId: string) => Promise<void>
  /** Current workspace + recent list + whether any Chromium is installed. */
  getWorkspace: () => Promise<WorkspaceInfo>
  /** Native folder picker; null when cancelled. Scaffolds and opens the pick. */
  pickWorkspace: () => Promise<WorkspaceInfo | null>
  setWorkspace: (dir: string) => Promise<WorkspaceInfo>
  forgetWorkspace: (dir: string) => Promise<WorkspaceInfo>
  revealWorkspace: () => Promise<void>
  installBrowser: () => Promise<boolean>
  onWorkspaceReload: (cb: () => void) => () => void
  /** Vault state of the open workspace; also triggers the auto-unlock attempt. */
  getVaultStatus: () => Promise<VaultStatus>
  /** Create the vault. Throws if one already exists. */
  setupVault: (passphrase: string) => Promise<VaultStatus>
  /** `ok: false` means a wrong passphrase, not an error. */
  unlockVault: (passphrase: string) => Promise<{ ok: boolean; status: VaultStatus }>
  lockVault: () => Promise<VaultStatus>
  /** Re-encrypts every stored secret under the new passphrase before committing it. */
  changeVaultPassphrase: (
    oldPassphrase: string,
    newPassphrase: string,
  ) => Promise<{ ok: boolean; status: VaultStatus }>
  /** Encrypt one value for storage. Requires an unlocked vault. */
  encryptSecret: (plain: string) => Promise<string>
  /** Decrypt one value for the 👁 reveal. Non-ciphertext passes through. */
  revealSecret: (envelope: string) => Promise<string>
  /** Write the gitignored .flowtest/secrets.env that external runs read. */
  writeSecretsFile: (
    flow: Flow,
    config: ExportConfig,
  ) => Promise<{ path: string; count: number }>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
