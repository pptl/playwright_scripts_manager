// src/shared/types.ts — Shared types between Main and Renderer

export type ActionType =
  | 'goto'
  | 'click'
  | 'fill'
  | 'selectOption'
  | 'check'
  | 'uncheck'
  | 'press'
  | 'upload'
  | 'wait'
  | 'assertVisible'
  | 'assertText'
  | 'assertValue'
  | 'callFlow'

export interface Assertion {
  type: 'text' | 'visible' | 'url' | 'count'
  target?: string
  expected: string
}

export interface Action {
  id: string
  type: ActionType
  selector: string
  /** Full Playwright locator expression from Codegen, e.g. getByRole('button', { name: 'Login' }) */
  locatorExpr?: string
  value?: string
  captureAs?: string
  description: string
  timestamp: number
  screenshot?: string
  assertion?: Assertion
  url: string
  isPageNavigation: boolean
  /** callFlow only: ID of the flow to call */
  subFlowId?: string
  /** callFlow only: which leaf node in the sub-flow is the exit point */
  subFlowExitNodeId?: string
  /** callFlow only: which profile from the sub-flow to use */
  subFlowProfileId?: string
  /** callFlow only: display name of the selected profile (stored at creation time) */
  subFlowProfileName?: string
}

export function isCallFlowAction(action: Action): action is Action & {
  subFlowId: string
  subFlowExitNodeId: string
} {
  return (
    action.type === 'callFlow' &&
    typeof action.subFlowId === 'string' &&
    typeof action.subFlowExitNodeId === 'string'
  )
}

export interface NodePosition {
  x: number
  y: number
}

export interface FlowNode {
  id: string
  action: Action
  position: NodePosition
  parentId: string | null
  childIds: string[]
  branchLabel?: string
}

export interface ProfileVariable {
  key: string
  value: string
  description?: string
}

export interface FlowProfile {
  id: string
  name: string
  vars: ProfileVariable[]
}

export interface Flow {
  id: string
  name: string
  description?: string
  createdAt: string
  updatedAt: string
  baseURL: string
  /** Environment profiles — each holds a named set of key-value variables (e.g. domain, admin_name) */
  profiles?: FlowProfile[]
  /** @deprecated migrated to profiles */
  domains?: string[]
  nodes: FlowNode[]
  rootNodeId: string
}

export interface ExportConfig {
  outputDir: string
  helperFunctions: boolean
  useTestStep: boolean
  /** Active profile's variables as a flat map — used for replay substitution and code generation */
  profileVars?: Record<string, string>
}

export interface TestPath {
  id: string
  name: string
  nodeIds: string[]
}

export type ReplaySpeed = 'fast' | 'normal' | 'slow'

export const REPLAY_SPEED_MS: Record<ReplaySpeed, number> = {
  fast: 100,
  normal: 500,
  slow: 1000,
}

// IPC Channel definitions
export const IPC_CHANNELS = {
  // Renderer → Main
  BROWSER_LAUNCH: 'browser:launch',
  BROWSER_CLOSE: 'browser:close',
  RECORDING_START: 'recording:start',
  RECORDING_STOP: 'recording:stop',
  REPLAY_TO_NODE: 'replay:toNode',
  REPLAY_STOP: 'replay:stop',
  FLOW_SAVE: 'flow:save',
  FLOW_LOAD: 'flow:load',
  FLOW_LIST: 'flow:list',
  FLOW_DELETE: 'flow:delete',
  EXPORT_SCRIPTS: 'export:scripts',
  RUN_TESTS: 'test:run',
  SHOW_REPORT: 'test:showReport',
  FLOW_GET: 'flow:get',
  FLOW_CHECK_CYCLE: 'flow:checkCycle',

  // Renderer → Main (assertion pick)
  START_ASSERTION_PICK: 'assertion:pickStart',

  // Main → Renderer
  ASSERTION_PICK_CANCELLED: 'assertion:pickCancelled',
  ACTION_CAPTURED: 'action:captured',
  TEST_OUTPUT: 'test:output',
  TEST_FINISHED: 'test:finished',
  REPLAY_NODE_START: 'replay:nodeStart',
  REPLAY_NODE_COMPLETE: 'replay:nodeComplete',
  REPLAY_FINISHED: 'replay:finished',
  REPLAY_ERROR: 'replay:error',
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

// IPC payload types
export interface ReplayToNodePayload {
  nodes: FlowNode[]
  targetNodeId: string
  speed: number
  /** Flow's baseURL — used to derive base origin for goto URL substitution */
  baseURL?: string
  /** Active profile's variables — used for variable resolution and goto origin substitution */
  profileVars?: Record<string, string>
}

export interface ReplayNodeCompletePayload {
  nodeId: string
  success: boolean
  error?: string
}

export interface ExportScriptsPayload {
  flow: Flow
  config: ExportConfig
}

export interface FlowSavePayload {
  flow: Flow
}

export interface FlowLoadPayload {
  flowId: string
}

export interface TestFinishedPayload {
  exitCode: number
  passed: boolean
}

export interface RecordingStartPayload {
  baseURL: string
  /** If set, silently replay to this node before starting Codegen */
  branchFromNodeId?: string
  /** Nodes needed for silent replay */
  branchNodes?: FlowNode[]
  /** Speed ms per step in silent replay. Default 200. */
  replaySpeed?: number
}
