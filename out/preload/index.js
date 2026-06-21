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
  // Renderer → Main (assertion pick)
  START_ASSERTION_PICK: "assertion:pickStart",
  // Main → Renderer
  ASSERTION_PICK_CANCELLED: "assertion:pickCancelled",
  ACTION_CAPTURED: "action:captured",
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
  replayToNode: (nodes, targetNodeId, speed, baseURL, profileVars, activeProfileId) => electron.ipcRenderer.invoke(IPC_CHANNELS.REPLAY_TO_NODE, { nodes, targetNodeId, speed, baseURL, profileVars, activeProfileId }),
  stopReplay: () => electron.ipcRenderer.invoke(IPC_CHANNELS.REPLAY_STOP),
  // Storage
  saveFlow: (flow) => electron.ipcRenderer.invoke(IPC_CHANNELS.FLOW_SAVE, { flow }),
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
  // Sub-flow support
  getFlow: (flowId) => electron.ipcRenderer.invoke(IPC_CHANNELS.FLOW_GET, { flowId }),
  checkFlowCycle: (currentFlowId, candidateSubFlowId) => electron.ipcRenderer.invoke(IPC_CHANNELS.FLOW_CHECK_CYCLE, { currentFlowId, candidateSubFlowId }),
  // Event listeners (Main → Renderer)
  onActionCaptured: (cb) => {
    const handler = (_, action) => cb(action);
    electron.ipcRenderer.on(IPC_CHANNELS.ACTION_CAPTURED, handler);
    return () => electron.ipcRenderer.removeListener(IPC_CHANNELS.ACTION_CAPTURED, handler);
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
  }
});
