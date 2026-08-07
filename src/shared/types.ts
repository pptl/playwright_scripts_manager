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
  | 'code'

export interface Action {
  id: string
  type: ActionType
  selector: string
  /** Full Playwright locator expression from Codegen, e.g. getByRole('button', { name: 'Login' }) */
  locatorExpr?: string
  value?: string
  /** Private data: `value` holds ciphertext (see SECRET_ENVELOPE_PREFIX) rather than the
   *  typed text, and code generation emits a process.env reference instead of a literal.
   *  Not offered for `goto` (the domain is substituted into the URL) or `upload`
   *  (fixture paths are not secrets). */
  secret?: boolean
  /** click only: mouse button — absent means left */
  button?: 'left' | 'right' | 'middle'
  /** click only: modifier keys held during the click (Playwright names: Alt/Control/Meta/Shift) */
  modifiers?: string[]
  /** click only: 2 = double click (replayed/exported as dblclick) */
  clickCount?: number
  /** selectOption only: all selected values when the <select> allows multiple.
   *  Takes precedence over `value` at replay/export. */
  values?: string[]
  /** upload only: the files to send, one entry per file. Paths are either relative to the
   *  data root (`fixtures/cat.jpg`, written when recording imports the picked file) or
   *  absolute. Takes precedence over the comma-joined `value` at replay/export. */
  filePaths?: string[]
  /** Page this action ran on — absent means the initial page. Popups get 'page1', 'page2'… */
  pageAlias?: string
  /** iframe chain (top → innermost) as locator expressions for each iframe element.
   *  Replay/export scope the locator via `.contentFrame()` chains; absent = main frame. */
  framePath?: string[]
  /** Set when this action opened a new page/popup: the alias assigned to that page.
   *  Replay waits for the page event; export emits the waitForEvent('popup') pattern. */
  opensPage?: string
  captureAs?: string
  description: string
  timestamp: number
  url: string
  isPageNavigation: boolean
  /** callFlow only: ID of the flow to call */
  subFlowId?: string
  /** callFlow only: which leaf node in the sub-flow is the exit point */
  subFlowExitNodeId?: string
  /** callFlow only: which profile from the sub-flow to use (legacy — single static selection) */
  subFlowProfileId?: string
  /** callFlow only: display name of the selected profile (single-parent-profile case) */
  subFlowProfileName?: string
  /** callFlow only: per-parent-profile mapping — parentProfileId → subFlowProfileId.
   *  Takes precedence over subFlowProfileId at runtime. Enables dynamic profile resolution
   *  when the parent flow switches environments, including N-level nesting. */
  subFlowProfileMapping?: Record<string, string | null>
  /** code only: raw Playwright/JS body executed with (page, expect, vars) in scope.
   *  Runs verbatim at replay (via AsyncFunction) and is inlined into the exported spec. */
  code?: string
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
  /** If set, this node belongs to the in-place visual group with this id (see Flow.groups).
   *  Groups are pure canvas-layer organization — they create no separate Flow and do not
   *  alter parentId/childIds wiring. */
  groupId?: string
}

/** An in-place collapsible group of contiguous nodes (single entry, single exit).
 *  Purely a canvas-display construct — never produces a separate Flow and never enters
 *  the flow list. Membership is recorded via FlowNode.groupId. */
export interface FlowGroup {
  id: string
  name: string
  collapsed: boolean
}

export interface ProfileVariable {
  key: string
  /** Standalone / fallback value used when no project environment is active.
   *  Ciphertext (see SECRET_ENVELOPE_PREFIX) when `secret` is set. */
  value: string
  description?: string
  /** Per-environment value overrides keyed by ProjectEnvironment.id.
   *  Resolution: envValues[activeEnvId] ?? value */
  envValues?: Record<string, string>
  /** Private data: `value` and every `envValues` entry are stored encrypted, and code
   *  generation emits a process.env reference instead of a literal.
   *  Keys are shared across all profiles of a flow, so this is a per-KEY attribute —
   *  it must be identical on the same key in every profile (see commitProfileVars). */
  secret?: boolean
}

export interface FlowProfile {
  id: string
  name: string
  vars: ProfileVariable[]
}

export interface ProjectEnvironment {
  id: string
  name: string
}

/** A project-level environment variable: one key with a value per environment.
 *  Flow profile variable values can reference it via {{key}}, resolved against the
 *  active environment. Resolution: values[activeEnvironmentId] ?? '' */
export interface ProjectEnvVar {
  key: string
  /** Per-environment value keyed by ProjectEnvironment.id.
   *  Ciphertext (see SECRET_ENVELOPE_PREFIX) when `secret` is set. */
  values: Record<string, string>
  description?: string
  /** Private data — see ProfileVariable.secret. The reserved `domain` key can never be
   *  secret: it is baked into goto URLs as a literal. */
  secret?: boolean
}

/** Reserved default project ("未分類"). Any flow with no projectId — or a projectId
 *  pointing to a project that no longer exists — is treated as belonging to it.
 *  It cannot be deleted or renamed. */
export const DEFAULT_PROJECT_ID = '__default__'
export const DEFAULT_PROJECT_NAME = '未分類'

/** The reserved project environment variable that drives goto-URL origin substitution.
 *  Every project seeds one; it cannot be deleted or renamed. */
export const DOMAIN_ENV_KEY = 'domain'
/** Default environment name seeded into every new project. */
export const DEFAULT_ENV_NAME = 'DEV'
/** Default value for the seeded `domain` environment variable. */
export const DEFAULT_DOMAIN = 'http://localhost:3000/'

// ── Private data (the vault) ──────────────────────────────────────────────────

/** Marker that makes an encrypted value self-describing, so ciphertext can live in the
 *  same `string` fields as plaintext with no schema surgery.
 *  Full envelope: `enc:v1:<base64 iv>:<base64 ciphertext+authTag>` */
export const SECRET_ENVELOPE_PREFIX = 'enc:v1:'

/** What the UI shows in place of a private value. */
export const SECRET_MASK = '••••••'

/** Environment-variable name prefix used by generated specs to look up private values. */
export const SECRET_ENV_PREFIX = 'FT_SECRET_'

/** Gitignored file the generated spec falls back to when the env var is absent —
 *  written on demand so `npx playwright test` works outside the app. */
export const SECRETS_FILE = '.flowtest/secrets.env'

/** Vault state of the open workspace.
 *  - `none`     — no vault has been created; nothing is encrypted yet
 *  - `locked`   — a vault exists but the key is not in memory; secrets are unreadable
 *  - `unlocked` — the key is in memory; secrets can be read and written */
export type VaultState = 'none' | 'locked' | 'unlocked'

export interface VaultStatus {
  state: VaultState
  /** False when the OS keychain is unavailable (some Linux setups) — the passphrase then
   *  cannot be remembered and must be entered on every launch. */
  canRemember: boolean
}

export interface Project {
  id: string
  name: string
  environments: ProjectEnvironment[]
  /** Project-level environment variables shared by all flows in this project.
   *  Referenced from flow profile variable values via {{key}}. */
  envVars?: ProjectEnvVar[]
  createdAt: string
  updatedAt: string
}

export interface Flow {
  id: string
  name: string
  description?: string
  createdAt: string
  updatedAt: string
  baseURL: string
  /** If set, this flow belongs to the given project and supports environment-level variable overrides */
  projectId?: string
  /** Environment profiles — each holds a named set of key-value variables (e.g. domain, admin_name) */
  profiles?: FlowProfile[]
  nodes: FlowNode[]
  rootNodeId: string
  /** In-place collapsible visual groups over contiguous node ranges (canvas display only). */
  groups?: FlowGroup[]
  /** When true, node positions have been manually set and treeLayout is not applied on render.
   *  Flips to true on first manual drag. */
  positionsFinalized?: boolean
}

/** Lightweight flow summary returned by FLOW_LIST. */
export interface FlowListItem {
  id: string
  name: string
  description?: string
  updatedAt: string
  projectId?: string
  /** How many callFlow nodes across all other flows reference this flow as a sub-flow.
   *  > 0 means it's used as a reusable sub-flow; 0 means it's a top-level test case. */
  refCount: number
}

/** The resolution context a spec is generated under. Specs always go to `<workspace>/exports`
 *  and always wrap each step in `test.step` — neither is configurable. */
export interface ExportConfig {
  /** Active profile's variables as a flat map — used for replay substitution and code generation */
  profileVars?: Record<string, string>
  /** ID of the currently active profile — used to resolve subFlowProfileMapping in nested sub-flows */
  activeProfileId?: string
  /** Active project environment ID — used to resolve envValues overrides in sub-flow profiles */
  activeEnvironmentId?: string
  /** Active project's environment variables, flattened for the active environment (key -> value).
   *  Used to resolve {{key}} references inside sub-flow profile values. */
  envVars?: Record<string, string>
  /** ID of the active project — env-var references only resolve for (sub-)flows in this project */
  activeProjectId?: string
  /** Which of `envVars`' keys are private. Profile-var secrecy is read off the Flow objects
   *  the exporter already loads; project env vars only ever arrive as a flat map, so their
   *  secrecy has to be carried alongside. */
  secretEnvKeys?: string[]
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
  RECORDING_START: 'recording:start',
  RECORDING_STOP: 'recording:stop',
  REPLAY_TO_NODE: 'replay:toNode',
  FLOW_SAVE: 'flow:save',
  FLOW_LOAD: 'flow:load',
  FLOW_LIST: 'flow:list',
  FLOW_DELETE: 'flow:delete',
  EXPORT_SCRIPTS: 'export:scripts',
  RUN_TESTS: 'test:run',
  SHOW_REPORT: 'test:showReport',
  FLOW_GET: 'flow:get',
  FLOW_CHECK_CYCLE: 'flow:checkCycle',

  // Project management
  PROJECT_SAVE: 'project:save',
  PROJECT_LOAD: 'project:load',
  PROJECT_LIST: 'project:list',
  PROJECT_DELETE: 'project:delete',

  // Renderer → Main (native file picker — returns paths imported into fixtures/)
  PICK_FILES: 'files:pick',
  // Rewrite hand-typed paths into workspace-relative ones before they are stored
  NORMALIZE_PATHS: 'files:normalize',

  // Workspace (the user-chosen folder everything is read from / written to)
  WORKSPACE_GET: 'workspace:get',
  WORKSPACE_PICK: 'workspace:pick',
  WORKSPACE_SET: 'workspace:set',
  WORKSPACE_FORGET: 'workspace:forget',
  WORKSPACE_REVEAL: 'workspace:reveal',

  // Renderer → Main (download the Playwright browsers)
  BROWSER_INSTALL: 'browser:install',

  // Private data — the key never leaves the main process; the renderer only ever
  // holds ciphertext, plus whatever single value it explicitly asks to reveal.
  VAULT_STATUS: 'vault:status',
  VAULT_SETUP: 'vault:setup',
  VAULT_UNLOCK: 'vault:unlock',
  VAULT_LOCK: 'vault:lock',
  VAULT_CHANGE_PASSPHRASE: 'vault:changePassphrase',
  SECRET_ENCRYPT: 'secret:encrypt',
  SECRET_REVEAL: 'secret:reveal',
  SECRETS_FILE_WRITE: 'secret:writeFile',

  // Main → Renderer
  WORKSPACE_RELOAD: 'workspace:reload',
  ACTION_CAPTURED: 'action:captured',
  ACTION_UPDATED: 'action:updated',
  ACTION_REMOVED: 'action:removed',
  TEST_OUTPUT: 'test:output',
  TEST_FINISHED: 'test:finished',
  REPLAY_NODE_START: 'replay:nodeStart',
  REPLAY_NODE_COMPLETE: 'replay:nodeComplete',
  REPLAY_FINISHED: 'replay:finished',
  REPLAY_ERROR: 'replay:error',
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

/** A remembered workspace, with whether it still exists on disk. */
export interface RecentWorkspace {
  path: string
  name: string
  exists: boolean
}

export interface WorkspaceInfo {
  root: string | null
  recent: RecentWorkspace[]
  /** false only when no Chromium build exists at all — never on a version mismatch. */
  hasChromium: boolean
}

// IPC payload types
export interface ReplayToNodePayload {
  nodes: FlowNode[]
  targetNodeId: string
  speed: number
  /** Flow's baseURL — used to derive base origin for goto URL substitution */
  baseURL?: string
  /** Active profile's variables — used for variable resolution and goto origin substitution */
  profileVars?: Record<string, string>
  /** ID of the currently active profile — used to resolve subFlowProfileMapping in nested sub-flows */
  activeProfileId?: string
  /** Active project environment ID — used to resolve envValues overrides in sub-flow profiles */
  activeEnvironmentId?: string
  /** Active project's environment variables, flattened for the active environment (key -> value) */
  envVars?: Record<string, string>
  /** ID of the active project — env-var references only resolve for (sub-)flows in this project */
  activeProjectId?: string
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
  /** false leaves updatedAt alone — for saves that only move nodes around. */
  touch?: boolean
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
  /** Active profile variables for silent replay variable substitution */
  profileVars?: Record<string, string>
  /** ID of the currently active profile — used to resolve subFlowProfileMapping in nested sub-flows */
  activeProfileId?: string
  /** Active project environment ID — used to resolve envValues overrides in sub-flow profiles */
  activeEnvironmentId?: string
  /** Active project's environment variables, flattened for the active environment (key -> value) */
  envVars?: Record<string, string>
  /** ID of the active project — env-var references only resolve for (sub-)flows in this project */
  activeProjectId?: string
}

export interface ProjectSavePayload {
  project: Project
}

export interface ProjectLoadPayload {
  projectId: string
}

/** Main → Renderer: retroactively patch fields of an already-captured action
 *  (e.g. a popup that arrived after its triggering click was emitted). */
export interface ActionUpdatedPayload {
  actionId: string
  updates: Partial<Action>
}

/** One Cell-vs-Row alternative offered by the in-browser locator picker
 *  (see getLocatorPickerScript / CodegenCapture.showLocatorPicker). */
export interface LocatorOption {
  label: string
  expr: string
}
