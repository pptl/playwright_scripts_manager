import type { Action, ActionType, Flow, FlowNode, ExportConfig, ReplayNodeCompletePayload, RecordingStartPayload, TestFinishedPayload } from '../../shared/types'

export interface ElectronAPI {
  launchBrowser: () => Promise<void>
  closeBrowser: () => Promise<void>
  startRecording: (payload: RecordingStartPayload) => Promise<void>
  stopRecording: () => Promise<void>
  replayToNode: (nodes: FlowNode[], targetNodeId: string, speed: number, baseURL?: string, profileVars?: Record<string, string>) => Promise<void>
  stopReplay: () => Promise<void>
  saveFlow: (flow: Flow) => Promise<void>
  loadFlow: (flowId: string) => Promise<Flow | null>
  listFlows: () => Promise<Pick<Flow, 'id' | 'name' | 'description' | 'updatedAt'>[]>
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
  getFlow: (flowId: string) => Promise<Flow | null>
  checkFlowCycle: (currentFlowId: string, candidateSubFlowId: string) => Promise<boolean>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
