"use strict";
const electron = require("electron");
const IPC_CHANNELS = {
  // Renderer → Main
  BROWSER_LAUNCH: "browser:launch",
  BROWSER_CLOSE: "browser:close",
  RECORDING_START: "recording:start",
  RECORDING_STOP: "recording:stop",
  REPLAY_TO_NODE: "replay:toNode",
  REPLAY_STOP: "replay:stop",
  FLOW_SAVE: "flow:save",
  FLOW_LOAD: "flow:load",
  FLOW_LIST: "flow:list",
  FLOW_DELETE: "flow:delete",
  EXPORT_SCRIPTS: "export:scripts",
  RUN_TESTS: "test:run",
  SHOW_REPORT: "test:showReport",
  FLOW_GET: "flow:get",
  FLOW_CHECK_CYCLE: "flow:checkCycle",
  // Project management
  PROJECT_SAVE: "project:save",
  PROJECT_LOAD: "project:load",
  PROJECT_LIST: "project:list",
  PROJECT_DELETE: "project:delete",
  // Renderer → Main (assertion pick)
  START_ASSERTION_PICK: "assertion:pickStart",
  // Renderer → Main (locator pick)
  LOCATOR_PICK_RESOLVED: "locator:pickResolved",
  // Renderer → Main (native file picker — returns paths imported into fixtures/)
  PICK_FILES: "files:pick",
  // Rewrite hand-typed paths into workspace-relative ones before they are stored
  NORMALIZE_PATHS: "files:normalize",
  // Workspace (the user-chosen folder everything is read from / written to)
  WORKSPACE_GET: "workspace:get",
  WORKSPACE_PICK: "workspace:pick",
  WORKSPACE_SET: "workspace:set",
  WORKSPACE_FORGET: "workspace:forget",
  WORKSPACE_REVEAL: "workspace:reveal",
  // Renderer → Main (download the Playwright browsers)
  BROWSER_INSTALL: "browser:install",
  BROWSER_CHECK: "browser:check",
  // Private data — the key never leaves the main process; the renderer only ever
  // holds ciphertext, plus whatever single value it explicitly asks to reveal.
  VAULT_STATUS: "vault:status",
  VAULT_SETUP: "vault:setup",
  VAULT_UNLOCK: "vault:unlock",
  VAULT_LOCK: "vault:lock",
  VAULT_CHANGE_PASSPHRASE: "vault:changePassphrase",
  SECRET_ENCRYPT: "secret:encrypt",
  SECRET_REVEAL: "secret:reveal",
  SECRETS_FILE_WRITE: "secret:writeFile",
  // Main → Renderer
  WORKSPACE_RELOAD: "workspace:reload",
  LOCATOR_PICK_NEEDED: "locator:pickNeeded",
  ASSERTION_PICK_CANCELLED: "assertion:pickCancelled",
  ACTION_CAPTURED: "action:captured",
  ACTION_UPDATED: "action:updated",
  ACTION_REMOVED: "action:removed",
  TEST_OUTPUT: "test:output",
  TEST_FINISHED: "test:finished",
  REPLAY_NODE_START: "replay:nodeStart",
  REPLAY_NODE_COMPLETE: "replay:nodeComplete",
  REPLAY_FINISHED: "replay:finished",
  REPLAY_ERROR: "replay:error"
};
electron.contextBridge.exposeInMainWorld("electronAPI", {
  // Browser
  launchBrowser: () => electron.ipcRenderer.invoke(IPC_CHANNELS.BROWSER_LAUNCH),
  closeBrowser: () => electron.ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CLOSE),
  // Recording
  startRecording: (payload) => electron.ipcRenderer.invoke(IPC_CHANNELS.RECORDING_START, payload),
  stopRecording: () => electron.ipcRenderer.invoke(IPC_CHANNELS.RECORDING_STOP),
  // Replay
  replayToNode: (nodes, targetNodeId, speed, baseURL, profileVars, activeProfileId, activeEnvironmentId, envVars, activeProjectId) => electron.ipcRenderer.invoke(IPC_CHANNELS.REPLAY_TO_NODE, { nodes, targetNodeId, speed, baseURL, profileVars, activeProfileId, activeEnvironmentId, envVars, activeProjectId }),
  stopReplay: () => electron.ipcRenderer.invoke(IPC_CHANNELS.REPLAY_STOP),
  // Storage
  saveFlow: (flow, touch) => electron.ipcRenderer.invoke(IPC_CHANNELS.FLOW_SAVE, { flow, touch }),
  loadFlow: (flowId) => electron.ipcRenderer.invoke(IPC_CHANNELS.FLOW_LOAD, { flowId }),
  listFlows: () => electron.ipcRenderer.invoke(IPC_CHANNELS.FLOW_LIST),
  deleteFlow: (flowId) => electron.ipcRenderer.invoke(IPC_CHANNELS.FLOW_DELETE, flowId),
  // Export
  exportScripts: (flow, config) => electron.ipcRenderer.invoke(IPC_CHANNELS.EXPORT_SCRIPTS, { flow, config }),
  // Run tests
  runTests: (flow, config) => electron.ipcRenderer.invoke(IPC_CHANNELS.RUN_TESTS, { flow, config }),
  showReport: () => electron.ipcRenderer.invoke(IPC_CHANNELS.SHOW_REPORT),
  // Assertion pick
  startAssertionPick: (assertionType) => electron.ipcRenderer.invoke(IPC_CHANNELS.START_ASSERTION_PICK, assertionType),
  // Locator pick
  resolveLocatorPick: () => electron.ipcRenderer.invoke(IPC_CHANNELS.LOCATOR_PICK_RESOLVED),
  // Native file picker — copies the picks into fixtures/ and returns their stored paths
  pickFiles: (multiple) => electron.ipcRenderer.invoke(IPC_CHANNELS.PICK_FILES, { multiple }),
  normalizePaths: (paths) => electron.ipcRenderer.invoke(IPC_CHANNELS.NORMALIZE_PATHS, paths),
  // Sub-flow support
  getFlow: (flowId) => electron.ipcRenderer.invoke(IPC_CHANNELS.FLOW_GET, { flowId }),
  checkFlowCycle: (currentFlowId, candidateSubFlowId) => electron.ipcRenderer.invoke(IPC_CHANNELS.FLOW_CHECK_CYCLE, { currentFlowId, candidateSubFlowId }),
  // Workspace — the user-chosen folder everything is read from / written to
  getWorkspace: () => electron.ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GET),
  pickWorkspace: () => electron.ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_PICK),
  setWorkspace: (dir) => electron.ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SET, dir),
  forgetWorkspace: (dir) => electron.ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_FORGET, dir),
  revealWorkspace: () => electron.ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REVEAL),
  // Browsers
  checkBrowser: () => electron.ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CHECK),
  installBrowser: () => electron.ipcRenderer.invoke(IPC_CHANNELS.BROWSER_INSTALL),
  // Private data — the vault key stays in the main process; the renderer holds only
  // ciphertext, plus whatever single value it explicitly asks to reveal.
  getVaultStatus: () => electron.ipcRenderer.invoke(IPC_CHANNELS.VAULT_STATUS),
  setupVault: (passphrase) => electron.ipcRenderer.invoke(IPC_CHANNELS.VAULT_SETUP, passphrase),
  unlockVault: (passphrase) => electron.ipcRenderer.invoke(IPC_CHANNELS.VAULT_UNLOCK, passphrase),
  lockVault: () => electron.ipcRenderer.invoke(IPC_CHANNELS.VAULT_LOCK),
  changeVaultPassphrase: (oldPassphrase, newPassphrase) => electron.ipcRenderer.invoke(IPC_CHANNELS.VAULT_CHANGE_PASSPHRASE, { oldPassphrase, newPassphrase }),
  encryptSecret: (plain) => electron.ipcRenderer.invoke(IPC_CHANNELS.SECRET_ENCRYPT, plain),
  revealSecret: (envelope) => electron.ipcRenderer.invoke(IPC_CHANNELS.SECRET_REVEAL, envelope),
  writeSecretsFile: (flow, config) => electron.ipcRenderer.invoke(IPC_CHANNELS.SECRETS_FILE_WRITE, { flow, config }),
  // Projects
  saveProject: (project) => electron.ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SAVE, { project }),
  loadProject: (projectId) => electron.ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LOAD, { projectId }),
  listProjects: () => electron.ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LIST),
  deleteProject: (projectId) => electron.ipcRenderer.invoke(IPC_CHANNELS.PROJECT_DELETE, projectId),
  // Event listeners (Main → Renderer)
  onActionCaptured: (cb) => {
    const handler = (_, action) => cb(action);
    electron.ipcRenderer.on(IPC_CHANNELS.ACTION_CAPTURED, handler);
    return () => electron.ipcRenderer.removeListener(IPC_CHANNELS.ACTION_CAPTURED, handler);
  },
  onActionUpdated: (cb) => {
    const handler = (_, payload) => cb(payload);
    electron.ipcRenderer.on(IPC_CHANNELS.ACTION_UPDATED, handler);
    return () => electron.ipcRenderer.removeListener(IPC_CHANNELS.ACTION_UPDATED, handler);
  },
  onActionRemoved: (cb) => {
    const handler = (_, actionId) => cb(actionId);
    electron.ipcRenderer.on(IPC_CHANNELS.ACTION_REMOVED, handler);
    return () => electron.ipcRenderer.removeListener(IPC_CHANNELS.ACTION_REMOVED, handler);
  },
  onReplayNodeStart: (cb) => {
    const handler = (_, nodeId) => cb(nodeId);
    electron.ipcRenderer.on(IPC_CHANNELS.REPLAY_NODE_START, handler);
    return () => electron.ipcRenderer.removeListener(IPC_CHANNELS.REPLAY_NODE_START, handler);
  },
  onReplayNodeComplete: (cb) => {
    const handler = (_, payload) => cb(payload);
    electron.ipcRenderer.on(IPC_CHANNELS.REPLAY_NODE_COMPLETE, handler);
    return () => electron.ipcRenderer.removeListener(IPC_CHANNELS.REPLAY_NODE_COMPLETE, handler);
  },
  onReplayFinished: (cb) => {
    const handler = () => cb();
    electron.ipcRenderer.on(IPC_CHANNELS.REPLAY_FINISHED, handler);
    return () => electron.ipcRenderer.removeListener(IPC_CHANNELS.REPLAY_FINISHED, handler);
  },
  onReplayError: (cb) => {
    const handler = (_, error) => cb(error);
    electron.ipcRenderer.on(IPC_CHANNELS.REPLAY_ERROR, handler);
    return () => electron.ipcRenderer.removeListener(IPC_CHANNELS.REPLAY_ERROR, handler);
  },
  onTestOutput: (cb) => {
    const handler = (_, line) => cb(line);
    electron.ipcRenderer.on(IPC_CHANNELS.TEST_OUTPUT, handler);
    return () => electron.ipcRenderer.removeListener(IPC_CHANNELS.TEST_OUTPUT, handler);
  },
  onTestFinished: (cb) => {
    const handler = (_, payload) => cb(payload);
    electron.ipcRenderer.on(IPC_CHANNELS.TEST_FINISHED, handler);
    return () => electron.ipcRenderer.removeListener(IPC_CHANNELS.TEST_FINISHED, handler);
  },
  onAssertionPickCancelled: (cb) => {
    const handler = () => cb();
    electron.ipcRenderer.on(IPC_CHANNELS.ASSERTION_PICK_CANCELLED, handler);
    return () => electron.ipcRenderer.removeListener(IPC_CHANNELS.ASSERTION_PICK_CANCELLED, handler);
  },
  onLocatorPickNeeded: (cb) => {
    const handler = (_, payload) => cb(payload);
    electron.ipcRenderer.on(IPC_CHANNELS.LOCATOR_PICK_NEEDED, handler);
    return () => electron.ipcRenderer.removeListener(IPC_CHANNELS.LOCATOR_PICK_NEEDED, handler);
  },
  onWorkspaceReload: (cb) => {
    const handler = () => cb();
    electron.ipcRenderer.on(IPC_CHANNELS.WORKSPACE_RELOAD, handler);
    return () => electron.ipcRenderer.removeListener(IPC_CHANNELS.WORKSPACE_RELOAD, handler);
  }
});
