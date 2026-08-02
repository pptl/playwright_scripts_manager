import type { Action, ActionType, ActionUpdatedPayload, Flow, FlowNode, FlowListItem, ExportConfig, ReplayNodeCompletePayload, RecordingStartPayload, TestFinishedPayload, Project, LocatorPickPayload, WorkspaceInfo } from '../../shared/types'

export interface ElectronAPI {
  launchBrowser: () => Promise<void>
  closeBrowser: () => Promise<void>
  startRecording: (payload: RecordingStartPayload) => Promise<void>
  stopRecording: () => Promise<void>
  replayToNode: (nodes: FlowNode[], targetNodeId: string, speed: number, baseURL?: string, profileVars?: Record<string, string>, activeProfileId?: string, activeEnvironmentId?: string, envVars?: Record<string, string>, activeProjectId?: string) => Promise<void>
  stopReplay: () => Promise<void>
  /** `touch: false` writes without bumping updatedAt (drag repositioning). */
  saveFlow: (flow: Flow, touch?: boolean) => Promise<void>
  loadFlow: (flowId: string) => Promise<Flow | null>
  listFlows: () => Promise<FlowListItem[]>
  deleteFlow: (flowId: string) => Promise<void>
  exportScripts: (flow: Flow, config: ExportConfig) => Promise<string>
  runTests: (flow: Flow, config: ExportConfig) => Promise<void>
  showReport: () => Promise<void>
  startAssertionPick: (assertionType: ActionType) => Promise<void>
  onActionCaptured: (cb: (action: Action) => void) => () => void
  onActionUpdated: (cb: (payload: ActionUpdatedPayload) => void) => () => void
  onActionRemoved: (cb: (actionId: string) => void) => () => void
  onReplayNodeStart: (cb: (nodeId: string) => void) => () => void
  onReplayNodeComplete: (cb: (payload: ReplayNodeCompletePayload) => void) => () => void
  onReplayFinished: (cb: () => void) => () => void
  onReplayError: (cb: (error: string) => void) => () => void
  onTestOutput: (cb: (line: string) => void) => () => void
  onTestFinished: (cb: (payload: TestFinishedPayload) => void) => () => void
  onAssertionPickCancelled: (cb: () => void) => () => void
  resolveLocatorPick: () => Promise<void>
  /** Opens the native file picker; returns paths already copied into fixtures/. */
  pickFiles: (multiple?: boolean) => Promise<string[]>
  /** Rewrites absolute paths as workspace-relative (copying in from outside it). */
  normalizePaths: (paths: string[]) => Promise<string[]>
  onLocatorPickNeeded: (cb: (payload: LocatorPickPayload) => void) => () => void
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
  checkBrowser: () => Promise<boolean>
  installBrowser: () => Promise<boolean>
  onWorkspaceReload: (cb: () => void) => () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
