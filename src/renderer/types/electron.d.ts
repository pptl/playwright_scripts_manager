import type { Action, ActionType, Flow, FlowNode, FlowListItem, ExportConfig, ReplayNodeCompletePayload, RecordingStartPayload, TestFinishedPayload, Project, LocatorPickPayload } from '../../shared/types'

export interface ElectronAPI {
  launchBrowser: () => Promise<void>
  closeBrowser: () => Promise<void>
  startRecording: (payload: RecordingStartPayload) => Promise<void>
  stopRecording: () => Promise<void>
  replayToNode: (nodes: FlowNode[], targetNodeId: string, speed: number, baseURL?: string, profileVars?: Record<string, string>, activeProfileId?: string, activeEnvironmentId?: string) => Promise<void>
  stopReplay: () => Promise<void>
  saveFlow: (flow: Flow) => Promise<void>
  loadFlow: (flowId: string) => Promise<Flow | null>
  listFlows: () => Promise<FlowListItem[]>
  deleteFlow: (flowId: string) => Promise<void>
  exportScripts: (flow: Flow, config: ExportConfig) => Promise<string>
  runTests: (flow: Flow, config: ExportConfig) => Promise<void>
  showReport: () => Promise<void>
  startAssertionPick: (assertionType: ActionType) => Promise<void>
  onActionCaptured: (cb: (action: Action) => void) => () => void
  onReplayNodeStart: (cb: (nodeId: string) => void) => () => void
  onReplayNodeComplete: (cb: (payload: ReplayNodeCompletePayload) => void) => () => void
  onReplayFinished: (cb: () => void) => () => void
  onReplayError: (cb: (error: string) => void) => () => void
  onTestOutput: (cb: (line: string) => void) => () => void
  onTestFinished: (cb: (payload: TestFinishedPayload) => void) => () => void
  onAssertionPickCancelled: (cb: () => void) => () => void
  resolveLocatorPick: () => Promise<void>
  onLocatorPickNeeded: (cb: (payload: LocatorPickPayload) => void) => () => void
  getFlow: (flowId: string) => Promise<Flow | null>
  checkFlowCycle: (currentFlowId: string, candidateSubFlowId: string) => Promise<boolean>
  saveProject: (project: Project) => Promise<void>
  loadProject: (projectId: string) => Promise<Project | null>
  listProjects: () => Promise<Pick<Project, 'id' | 'name' | 'updatedAt'>[]>
  deleteProject: (projectId: string) => Promise<void>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
