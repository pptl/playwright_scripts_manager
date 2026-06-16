"use strict";
const electron = require("electron");
const path = require("path");
const child_process = require("child_process");
const playwrightCore = require("playwright-core");
const uuid = require("uuid");
const fs = require("fs");
const vm = require("vm");
const module$1 = require("module");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
const fs__namespace = /* @__PURE__ */ _interopNamespaceDefault(fs);
const vm__namespace = /* @__PURE__ */ _interopNamespaceDefault(vm);
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
  EXPORT_SCRIPTS: "export:scripts",
  RUN_TESTS: "test:run",
  // Main → Renderer
  ACTION_CAPTURED: "action:captured",
  TEST_OUTPUT: "test:output",
  TEST_FINISHED: "test:finished",
  REPLAY_NODE_START: "replay:nodeStart",
  REPLAY_NODE_COMPLETE: "replay:nodeComplete",
  REPLAY_FINISHED: "replay:finished",
  REPLAY_ERROR: "replay:error"
};
class BrowserController {
  browser = null;
  page = null;
  async launch() {
    this.browser = await playwrightCore.chromium.launch({ headless: false });
    const context = await this.browser.newContext();
    this.page = await context.newPage();
    this.browser.on("disconnected", () => {
      this.browser = null;
      this.page = null;
    });
    this.page.on("close", () => {
      this.page = null;
    });
  }
  async close() {
    try {
      await this.browser?.close();
    } catch {
    } finally {
      this.browser = null;
      this.page = null;
    }
  }
  getPage() {
    if (!this.page || this.page.isClosed()) throw new Error("Browser page not available");
    return this.page;
  }
  isRunning() {
    return this.browser !== null && this.browser.isConnected() && this.page !== null && !this.page.isClosed();
  }
}
const NAV_SUPPRESSION_MS = 5e3;
function shouldSuppressNav(navigationTime, last) {
  if (!last) return false;
  if (!["click", "press", "fill"].includes(last.type)) return false;
  return navigationTime - last.time < NAV_SUPPRESSION_MS;
}
function generateDescription(kind, label, value, selectedText) {
  switch (kind) {
    case "click":
      return `點擊「${label}」`;
    case "fill":
      return `填入「${value ?? ""}」到「${label}」`;
    case "selectOption":
      return `選擇「${selectedText ?? value ?? ""}」from「${label}」`;
    case "check":
      return `勾選「${label}」`;
    case "uncheck":
      return `取消勾選「${label}」`;
    case "press":
      return `在「${label}」按下 ${value}`;
  }
}
function extractSource3() {
  const _req = module$1.createRequire(require("url").pathToFileURL(__filename).href);
  let coreBundlePath;
  try {
    coreBundlePath = _req.resolve("playwright-core/lib/coreBundle.js");
  } catch {
    coreBundlePath = path__namespace.join(process.cwd(), "node_modules", "playwright-core", "lib", "coreBundle.js");
  }
  const src = fs__namespace.readFileSync(coreBundlePath, "utf8");
  const startMarker = "source3 = '";
  const markerIdx = src.indexOf(startMarker);
  if (markerIdx < 0) throw new Error("[FlowTest] Could not locate source3 in playwright-core/lib/coreBundle.js");
  const contentStart = markerIdx + startMarker.length;
  let firstNewline = -1;
  for (let i = contentStart; i < src.length; i++) {
    if (src.charCodeAt(i) === 10) {
      firstNewline = i;
      break;
    }
  }
  if (firstNewline < 0) throw new Error("[FlowTest] Could not find end of source3 in coreBundle.js");
  const escaped = src.slice(contentStart, firstNewline - 2);
  return vm__namespace.runInNewContext(`'${escaped}'`);
}
let _initScript = null;
function getBrowserInitScript() {
  if (_initScript !== null) return _initScript;
  try {
    const source3 = extractSource3();
    const opts = JSON.stringify({
      testIdAttributeName: "data-testid",
      stableRafCount: 1,
      browserName: "chromium",
      shouldPrependErrorPrefix: false,
      isUtilityWorld: false,
      customEngines: []
    });
    _initScript = `(function(){
var module={exports:{}};
${source3}
try{
  window.__ftInjected=new(module.exports.InjectedScript())(globalThis,${opts});
  window.__ftGetLocator=function(el){
    try{
      var sel=window.__ftInjected.generateSelectorSimple(el);
      var loc=asLocator('javascript',sel);
      return loc||null;
    }catch(e){return null;}
  };
}catch(e){
  window.__ftGetLocator=function(){return null;};
}
})();`;
  } catch (e) {
    console.warn("[FlowTest] Playwright InjectedScript extraction failed — falling back to built-in locator logic:", e);
    _initScript = "";
  }
  return _initScript;
}
function getDOMCaptureScript() {
  return () => {
    function generateCSSSelector(el) {
      const h = el;
      const testId = h.getAttribute("data-testid");
      if (testId) return `[data-testid="${testId}"]`;
      if (h.id) return `#${h.id}`;
      const aria = h.getAttribute("aria-label");
      if (aria) return `[aria-label="${aria}"]`;
      const name = h.getAttribute("name");
      if (name) return `[name="${name}"]`;
      const tag = el.tagName.toLowerCase();
      const type = (el.type || "").toLowerCase();
      return type && !["text", ""].includes(type) ? `${tag}[type="${type}"]` : tag;
    }
    function getLocatorExpr(el) {
      const loc = window.__ftGetLocator?.(el);
      if (loc) return loc;
      return `locator(${JSON.stringify(generateCSSSelector(el))})`;
    }
    function extractLabel(locatorExpr, el) {
      const q = `['"]([^'"]+)['"]`;
      const patterns = [
        new RegExp(`\\bname:\\s*${q}`),
        new RegExp(`getByLabel\\(${q}`),
        new RegExp(`getByPlaceholder\\(${q}`),
        new RegExp(`getByTestId\\(${q}`),
        new RegExp(`getByText\\(${q}`),
        new RegExp(`hasText:\\s*${q}`)
      ];
      for (const re of patterns) {
        const m = locatorExpr.match(re);
        if (m) return m[1];
      }
      const h = el;
      return h.getAttribute("aria-label")?.trim() || h.getAttribute("placeholder") || h.getAttribute("name") || el.tagName.toLowerCase();
    }
    function isTextInput(el) {
      const tag = el.tagName.toLowerCase();
      if (tag === "textarea") return true;
      if (tag !== "input") return false;
      const t = (el.type || "").toLowerCase();
      return !["checkbox", "radio", "button", "submit", "reset", "image", "file", "range", "color", "hidden"].includes(t);
    }
    function report(data) {
      try {
        ;
        window.__flowtest_report(data);
      } catch (_) {
      }
    }
    const focusValues = /* @__PURE__ */ new WeakMap();
    document.addEventListener("click", (e) => {
      let el = e.target;
      if (!el?.tagName) return;
      if (isTextInput(el)) return;
      if (el.tagName.toLowerCase() === "select") return;
      let cur = el;
      let foundInteractive = false;
      while (cur) {
        const t = cur.tagName.toLowerCase();
        const r = cur.getAttribute("role");
        const interactive = t === "button" || t === "a" || r === "button" || r === "link" || r === "menuitem" || r === "tab" || r === "option";
        if (interactive) {
          el = cur;
          foundInteractive = true;
          break;
        }
        if (["form", "main", "section", "article", "nav", "header", "footer"].includes(t)) break;
        cur = cur.parentElement;
      }
      const tag = el.tagName.toLowerCase();
      const type = (el.type || "").toLowerCase();
      const nativeInteractive = ["button", "a", "input", "select", "textarea", "label"].includes(tag);
      if (!foundInteractive && !nativeInteractive) return;
      const locatorExpr = getLocatorExpr(el);
      const label = extractLabel(locatorExpr, el);
      if (tag === "input" && (type === "checkbox" || type === "radio")) {
        report({ kind: el.checked ? "check" : "uncheck", locatorExpr, selector: generateCSSSelector(el), label, timestamp: Date.now(), url: window.location.href });
        return;
      }
      report({ kind: "click", locatorExpr, selector: generateCSSSelector(el), label, timestamp: Date.now(), url: window.location.href });
    }, true);
    document.addEventListener("focus", (e) => {
      const el = e.target;
      if (!el?.tagName || !isTextInput(el)) return;
      focusValues.set(el, el.value ?? "");
    }, true);
    document.addEventListener("blur", (e) => {
      const el = e.target;
      if (!el?.tagName || !isTextInput(el)) return;
      const initial = focusValues.get(el);
      const current = el.value ?? "";
      focusValues.delete(el);
      if (initial === void 0 || current === initial) return;
      const locatorExpr = getLocatorExpr(el);
      report({ kind: "fill", locatorExpr, selector: generateCSSSelector(el), label: extractLabel(locatorExpr, el), value: current, timestamp: Date.now(), url: window.location.href });
    }, true);
    document.addEventListener("change", (e) => {
      const el = e.target;
      if (el.tagName.toLowerCase() !== "select") return;
      const opt = el.options[el.selectedIndex];
      const locatorExpr = getLocatorExpr(el);
      report({ kind: "selectOption", locatorExpr, selector: generateCSSSelector(el), label: extractLabel(locatorExpr, el), value: el.value, selectedText: opt?.text?.trim(), timestamp: Date.now(), url: window.location.href });
    }, true);
    document.addEventListener("keydown", (e) => {
      if (!["Enter", "Escape"].includes(e.key)) return;
      const el = e.target;
      if (!el?.tagName) return;
      if (e.key === "Enter" && el.tagName.toLowerCase() === "textarea" && !e.ctrlKey && !e.metaKey) return;
      if (!isTextInput(el) && !["button", "a", "select"].includes(el.tagName.toLowerCase())) return;
      const locatorExpr = getLocatorExpr(el);
      report({ kind: "press", locatorExpr, selector: generateCSSSelector(el), label: extractLabel(locatorExpr, el), value: e.key, timestamp: Date.now(), url: window.location.href });
    }, true);
  };
}
function buildAction(raw) {
  let type;
  let value;
  switch (raw.kind) {
    case "click":
      type = "click";
      break;
    case "fill":
      type = "fill";
      value = raw.value;
      break;
    case "selectOption":
      type = "selectOption";
      value = raw.value;
      break;
    case "check":
      type = "check";
      break;
    case "uncheck":
      type = "uncheck";
      break;
    case "press":
      type = "press";
      value = raw.value;
      break;
    default:
      return null;
  }
  return {
    id: uuid.v4(),
    type,
    selector: raw.selector,
    locatorExpr: raw.locatorExpr,
    value,
    description: generateDescription(raw.kind, raw.label, raw.value, raw.selectedText),
    timestamp: raw.timestamp || Date.now(),
    url: raw.url,
    isPageNavigation: false
  };
}
class CodegenCapture {
  context;
  onAction;
  active = false;
  lastGotoUrl = "";
  lastInteraction = null;
  constructor(context, onAction) {
    this.context = context;
    this.onAction = onAction;
  }
  async start() {
    this.active = true;
    this.lastGotoUrl = "";
    this.lastInteraction = null;
    const pages = this.context.pages();
    const page = pages[0];
    if (!page) throw new Error("No page available in browser context");
    const initScript = getBrowserInitScript();
    if (initScript) {
      await page.addInitScript(initScript);
      await page.evaluate(initScript).catch(() => {
      });
    }
    const captureScript = getDOMCaptureScript();
    await page.addInitScript(captureScript);
    await page.evaluate(captureScript).catch(() => {
    });
    await page.exposeFunction("__flowtest_report", (raw) => {
      if (!this.active) return;
      const action = buildAction(raw);
      if (action) {
        this.lastInteraction = { time: Date.now(), type: action.type };
        this.onAction(action);
      }
    });
    page.on("framenavigated", (frame) => {
      if (!this.active || frame !== page.mainFrame()) return;
      const url = frame.url();
      if (!url || url === "about:blank" || url === this.lastGotoUrl) return;
      this.lastGotoUrl = url;
      const navigationTime = Date.now();
      setTimeout(() => {
        if (!this.active) return;
        if (shouldSuppressNav(navigationTime, this.lastInteraction)) return;
        this.onAction({
          id: uuid.v4(),
          type: "goto",
          selector: "",
          value: url,
          description: `導航到 ${url}`,
          timestamp: navigationTime,
          url,
          isPageNavigation: true
        });
      }, 50);
    });
  }
  async stop() {
    this.active = false;
  }
}
class Recorder {
  page;
  capture;
  recording = false;
  constructor(page, onAction) {
    this.page = page;
    this.capture = new CodegenCapture(page.context(), onAction);
  }
  /**
   * @param baseURL - if provided, navigate to this URL after starting capture.
   *                  Omit for branch recording (already at the right page after silent replay).
   */
  async start(baseURL) {
    if (this.recording) return;
    this.recording = true;
    await this.capture.start();
    if (baseURL) {
      await this.page.goto(baseURL);
    }
  }
  async stop() {
    await this.capture.stop();
    this.recording = false;
  }
  isRecording() {
    return this.recording;
  }
}
class Replayer {
  page;
  constructor(page) {
    this.page = page;
  }
  async replayToNode(nodes, targetNodeId, onNodeStart, onNodeComplete, speed = 500) {
    const path2 = this.findPath(nodes, targetNodeId);
    for (const node of path2) {
      onNodeStart(node.id);
      try {
        await this.executeAction(node.action);
        if (node.action.assertion) {
          await this.executeAssertion(node.action);
        }
        onNodeComplete(node.id, true);
      } catch (err) {
        onNodeComplete(node.id, false, String(err));
        throw err;
      }
      await new Promise((res) => setTimeout(res, speed));
    }
  }
  /**
   * Resolve a Playwright Locator from an Action.
   * Prefers locatorExpr (Codegen-quality) over the fallback CSS selector.
   */
  getLocator(action) {
    if (action.locatorExpr) {
      try {
        const fn = new Function("page", `return page.${action.locatorExpr}`);
        return fn(this.page);
      } catch {
      }
    }
    return this.page.locator(action.selector);
  }
  async executeAction(action) {
    switch (action.type) {
      case "goto":
        await this.page.goto(action.value);
        break;
      case "click":
        await this.getLocator(action).click();
        break;
      case "fill":
        await this.getLocator(action).fill(action.value ?? "");
        break;
      case "selectOption":
        await this.getLocator(action).selectOption(action.value ?? "");
        break;
      case "check":
        await this.getLocator(action).check();
        break;
      case "uncheck":
        await this.getLocator(action).uncheck();
        break;
      case "press":
        if (action.locatorExpr) {
          await this.getLocator(action).press(action.value ?? "");
        } else {
          await this.page.keyboard.press(action.value ?? "");
        }
        break;
      case "wait":
        await this.getLocator(action).waitFor({ state: "visible" });
        break;
    }
  }
  async executeAssertion(action) {
    const assertion = action.assertion;
    if (!assertion) return;
    const TIMEOUT = 1e4;
    switch (assertion.type) {
      case "text": {
        await this.page.locator(assertion.target).waitFor({ state: "visible", timeout: TIMEOUT });
        const text = await this.page.locator(assertion.target).textContent({ timeout: TIMEOUT });
        if (!text?.includes(assertion.expected)) {
          throw new Error(
            `Assertion failed: expected text "${assertion.expected}" in "${assertion.target}", got "${text}"`
          );
        }
        break;
      }
      case "visible": {
        const visible = await this.page.locator(assertion.target).isVisible();
        if (!visible) {
          throw new Error(`Assertion failed: "${assertion.target}" is not visible`);
        }
        break;
      }
      case "url": {
        await this.page.waitForURL(new RegExp(assertion.expected), { timeout: TIMEOUT });
        break;
      }
      case "count": {
        const expected = parseInt(assertion.expected, 10);
        await this.page.waitForFunction(
          ({ sel, cnt }) => document.querySelectorAll(sel).length === cnt,
          { sel: assertion.target, cnt: expected },
          { timeout: TIMEOUT }
        );
        break;
      }
    }
  }
  findPath(nodes, targetId) {
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const path2 = [];
    const visited = /* @__PURE__ */ new Set();
    let current = nodeMap.get(targetId);
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      path2.unshift(current);
      current = current.parentId ? nodeMap.get(current.parentId) : void 0;
    }
    if (path2.length === 0) {
      throw new Error(`Node "${targetId}" not found or graph is empty`);
    }
    return path2;
  }
}
function flowsDir() {
  const base = electron.app.isPackaged ? path.join(electron.app.getPath("userData"), "flows") : path.join(process.cwd(), "flows");
  return base;
}
class FlowStorage {
  static async ensureDir() {
    await fs.promises.mkdir(flowsDir(), { recursive: true });
  }
  static filePath(flowId) {
    return path.join(flowsDir(), `${flowId}.json`);
  }
  static async save(flow) {
    await FlowStorage.ensureDir();
    flow.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    await fs.promises.writeFile(FlowStorage.filePath(flow.id), JSON.stringify(flow, null, 2), "utf-8");
  }
  static async load(flowId) {
    try {
      const raw = await fs.promises.readFile(FlowStorage.filePath(flowId), "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  static async list() {
    await FlowStorage.ensureDir();
    const files = await fs.promises.readdir(flowsDir());
    const results = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.promises.readFile(path.join(flowsDir(), file), "utf-8");
        const flow = JSON.parse(raw);
        results.push({ id: flow.id, name: flow.name, description: flow.description, updatedAt: flow.updatedAt });
      } catch {
      }
    }
    return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  static async delete(flowId) {
    try {
      await fs.promises.unlink(FlowStorage.filePath(flowId));
    } catch {
    }
  }
}
function exportsDir() {
  return electron.app.isPackaged ? path.join(electron.app.getPath("userData"), "exports") : path.join(process.cwd(), "exports");
}
class ScriptExporter {
  static async export(flow, config) {
    const outputDir = config.outputDir || exportsDir();
    await fs.promises.mkdir(outputDir, { recursive: true });
    const paths = ScriptExporter.computePaths(flow);
    const nodeMap = new Map(flow.nodes.map((n) => [n.id, n]));
    let helperImport = "";
    let helperCode = "";
    if (config.helperFunctions) {
      const result = ScriptExporter.extractHelpers(paths, nodeMap, flow);
      helperCode = result.helperCode;
      helperImport = result.helperImport;
      if (helperCode) {
        const helpersDir = path.join(outputDir, "helpers");
        await fs.promises.mkdir(helpersDir, { recursive: true });
        await fs.promises.writeFile(path.join(helpersDir, `${flow.id}-helpers.ts`), helperCode, "utf-8");
      }
    }
    const specContent = ScriptExporter.generateSpec(flow, paths, nodeMap, config, helperImport);
    const specPath = path.join(outputDir, `${flow.id}.spec.ts`);
    await fs.promises.writeFile(specPath, specContent, "utf-8");
    return specPath;
  }
  // Compute all root-to-leaf paths
  static computePaths(flow) {
    const nodeMap = new Map(flow.nodes.map((n) => [n.id, n]));
    const paths = [];
    const walk = (node, currentPath, pathName) => {
      const newPath = [...currentPath, node.id];
      const newName = [...pathName, node.action.description];
      if (node.childIds.length === 0) {
        paths.push({
          id: `path-${paths.length + 1}`,
          name: newName.filter((_, i) => i === 0 || i === newName.length - 1).join(" → "),
          nodeIds: newPath
        });
        return;
      }
      for (const childId of node.childIds) {
        const child = nodeMap.get(childId);
        if (child) walk(child, newPath, newName);
      }
    };
    const root = nodeMap.get(flow.rootNodeId);
    if (root) walk(root, [], []);
    return paths;
  }
  static generateSpec(flow, paths, nodeMap, config, helperImport) {
    const tests = paths.map((path2, idx) => {
      const testName = path2.name || `測試路徑 ${idx + 1}`;
      const steps = path2.nodeIds.map((id) => nodeMap.get(id)).filter(Boolean);
      const stepCode = steps.map((node) => {
        const action = ScriptExporter.actionToCode(node);
        const assertCode = node.action.assertion ? ScriptExporter.assertionToCode(node.action) : "";
        if (config.useTestStep) {
          return `    await test.step('${node.action.description}', async () => {
      ${action}${assertCode ? "\n      " + assertCode : ""}
    });`;
        }
        return `    // ${node.action.description}
    ${action}${assertCode ? "\n    " + assertCode : ""}`;
      }).join("\n\n");
      return `  test('${testName}', async ({ page }) => {
${stepCode}
  });`;
    }).join("\n\n");
    return [
      `import { test, expect } from '@playwright/test';`,
      helperImport,
      "",
      `test.describe('${flow.name}', () => {`,
      "",
      tests,
      "",
      "});"
    ].filter((line) => line !== void 0).join("\n");
  }
  static actionToCode(node) {
    const { action } = node;
    let loc;
    const { locatorExpr, selector } = action;
    if (selector && /^\[name=/.test(selector)) {
      loc = `page.locator('${selector}')`;
    } else if (selector && /^\[data-id=/.test(selector)) {
      loc = `page.locator('${selector}')`;
    } else if (selector && /^\[aria-label=/.test(selector) && locatorExpr && /^getByText\(/.test(locatorExpr)) {
      loc = `page.locator('${selector}')`;
    } else if (locatorExpr && /^getByText\(/.test(locatorExpr)) {
      const textMatch = locatorExpr.match(/^getByText\("([^"]+)"/);
      if (textMatch && selector && /^button/.test(selector)) {
        loc = `page.getByRole("button", { name: "${textMatch[1]}", exact: true })`;
      } else if (textMatch && selector && /^a[\s\[]/.test(selector)) {
        loc = `page.getByRole("link", { name: "${textMatch[1]}", exact: true })`;
      } else if (textMatch) {
        loc = `page.getByText("${textMatch[1]}", { exact: true })`;
      } else {
        loc = `page.${locatorExpr}`;
      }
    } else if (locatorExpr) {
      loc = `page.${locatorExpr}`;
    } else {
      loc = `page.locator('${selector}')`;
    }
    switch (action.type) {
      case "goto":
        return `await page.goto('${action.value}');`;
      case "click":
        return `await ${loc}.click();`;
      case "fill":
        return `await ${loc}.fill('${(action.value ?? "").replace(/'/g, "\\'")}');`;
      case "selectOption":
        return `await ${loc}.selectOption('${(action.value ?? "").replace(/'/g, "\\'")}');`;
      case "check":
        return `await ${loc}.check();`;
      case "uncheck":
        return `await ${loc}.uncheck();`;
      case "press":
        return action.locatorExpr ? `await ${loc}.press('${action.value ?? ""}');` : `await page.keyboard.press('${action.value ?? ""}');`;
      case "wait":
        return `await ${loc}.waitFor({ state: 'visible' });`;
      default:
        return `// TODO: ${action.type}`;
    }
  }
  static assertionToCode(action) {
    const a = action.assertion;
    if (!a) return "";
    switch (a.type) {
      case "text":
        return `await expect(page.locator('${a.target}')).toContainText('${a.expected}');`;
      case "visible":
        return `await expect(page.locator('${a.target}')).toBeVisible();`;
      case "url":
        return `await expect(page).toHaveURL(/${a.expected}/);`;
      case "count":
        return `await expect(page.locator('${a.target}')).toHaveCount(${a.expected});`;
      default:
        return "";
    }
  }
  static extractHelpers(paths, nodeMap, flow) {
    if (paths.length < 2) return { helperCode: "", helperImport: "" };
    const pathArrays = paths.map((p) => p.nodeIds);
    let prefixLen = 0;
    outer: for (let i = 0; i < pathArrays[0].length; i++) {
      const id = pathArrays[0][i];
      for (let j = 1; j < pathArrays.length; j++) {
        if (pathArrays[j][i] !== id) break outer;
      }
      prefixLen++;
    }
    if (prefixLen < 3) return { helperCode: "", helperImport: "" };
    const prefixNodes = pathArrays[0].slice(0, prefixLen).map((id) => nodeMap.get(id));
    const fnName = `setup_${flow.id.replace(/-/g, "_")}`;
    const body = prefixNodes.map((node) => {
      const action = ScriptExporter.actionToCode(node);
      const assertCode = node.action.assertion ? ScriptExporter.assertionToCode(node.action) : "";
      return `  // ${node.action.description}
  ${action}${assertCode ? "\n  " + assertCode : ""}`;
    }).join("\n\n");
    const helperCode = `import { Page, expect } from '@playwright/test';

export async function ${fnName}(page: Page): Promise<void> {
${body}
}
`;
    const helperImport = `import { ${fnName} } from './helpers/${flow.id}-helpers';`;
    return { helperCode, helperImport };
  }
}
let browserController = null;
let recorder = null;
let replayer = null;
function registerIpcHandlers(win) {
  electron.ipcMain.handle(IPC_CHANNELS.BROWSER_LAUNCH, async () => {
    browserController = new BrowserController();
    await browserController.launch();
  });
  electron.ipcMain.handle(IPC_CHANNELS.BROWSER_CLOSE, async () => {
    await browserController?.close();
    browserController = null;
    recorder = null;
    replayer = null;
  });
  electron.ipcMain.handle(IPC_CHANNELS.RECORDING_START, async (_e, payload) => {
    if (browserController) {
      await browserController.close().catch(() => {
      });
    }
    browserController = new BrowserController();
    await browserController.launch();
    const page = browserController.getPage();
    if (payload.branchFromNodeId && payload.branchNodes?.length) {
      const silentReplayer = new Replayer(page);
      try {
        await silentReplayer.replayToNode(
          payload.branchNodes,
          payload.branchFromNodeId,
          () => {
          },
          // no UI feedback during silent replay
          () => {
          },
          payload.replaySpeed ?? 200
        );
      } catch (err) {
        win.webContents.send(IPC_CHANNELS.REPLAY_ERROR, `靜默重播失敗: ${String(err)}`);
        return;
      }
    }
    recorder = new Recorder(page, (action) => {
      win.webContents.send(IPC_CHANNELS.ACTION_CAPTURED, action);
    });
    await recorder.start(payload.branchFromNodeId ? void 0 : payload.baseURL);
  });
  electron.ipcMain.handle(IPC_CHANNELS.RECORDING_STOP, async () => {
    await recorder?.stop();
    recorder = null;
  });
  electron.ipcMain.handle(IPC_CHANNELS.REPLAY_TO_NODE, async (_e, payload) => {
    try {
      if (!browserController || !browserController.isRunning()) {
        browserController = new BrowserController();
        await browserController.launch();
      }
      const page = browserController.getPage();
      replayer = new Replayer(page);
      await replayer.replayToNode(
        payload.nodes,
        payload.targetNodeId,
        (nodeId) => win.webContents.send(IPC_CHANNELS.REPLAY_NODE_START, nodeId),
        (nodeId, success, error) => win.webContents.send(IPC_CHANNELS.REPLAY_NODE_COMPLETE, { nodeId, success, error }),
        payload.speed
      );
      win.webContents.send(IPC_CHANNELS.REPLAY_FINISHED);
    } catch (err) {
      win.webContents.send(IPC_CHANNELS.REPLAY_ERROR, String(err));
    }
  });
  electron.ipcMain.handle(IPC_CHANNELS.REPLAY_STOP, async () => {
    replayer = null;
  });
  electron.ipcMain.handle(IPC_CHANNELS.FLOW_SAVE, async (_e, payload) => {
    await FlowStorage.save(payload.flow);
  });
  electron.ipcMain.handle(IPC_CHANNELS.FLOW_LOAD, async (_e, payload) => {
    return await FlowStorage.load(payload.flowId);
  });
  electron.ipcMain.handle(IPC_CHANNELS.FLOW_LIST, async () => {
    return await FlowStorage.list();
  });
  electron.ipcMain.handle(IPC_CHANNELS.EXPORT_SCRIPTS, async (_e, payload) => {
    return await ScriptExporter.export(payload.flow, payload.config);
  });
  electron.ipcMain.handle(IPC_CHANNELS.RUN_TESTS, async (_e, payload) => {
    const cwd = electron.app.isPackaged ? path.join(electron.app.getPath("userData")) : process.cwd();
    let specPath;
    try {
      specPath = await ScriptExporter.export(payload.flow, payload.config);
      win.webContents.send(IPC_CHANNELS.TEST_OUTPUT, `✓ 腳本已匯出: ${specPath}

`);
    } catch (err) {
      win.webContents.send(IPC_CHANNELS.TEST_OUTPUT, `✗ 匯出失敗: ${String(err)}
`);
      win.webContents.send(IPC_CHANNELS.TEST_FINISHED, { exitCode: 1, passed: false });
      return;
    }
    const relSpecPath = path.relative(cwd, specPath).replace(/\\/g, "/");
    win.webContents.send(IPC_CHANNELS.TEST_OUTPUT, `▶ npx playwright test ${relSpecPath}

`);
    const exitCode = await new Promise((resolve) => {
      const child = child_process.spawn("npx", ["playwright", "test", relSpecPath, "--reporter=list"], {
        cwd,
        shell: true
      });
      child.stdout.on(
        "data",
        (d) => win.webContents.send(IPC_CHANNELS.TEST_OUTPUT, d.toString())
      );
      child.stderr.on(
        "data",
        (d) => win.webContents.send(IPC_CHANNELS.TEST_OUTPUT, d.toString())
      );
      child.on("close", (code) => resolve(code ?? 1));
    });
    win.webContents.send(IPC_CHANNELS.TEST_FINISHED, { exitCode, passed: exitCode === 0 });
    child_process.spawn("npx", ["playwright", "show-report"], { cwd, shell: true, detached: true });
  });
}
function createWindow() {
  const win = new electron.BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: "FlowTest",
    show: false
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    electron.shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  win.on("ready-to-show", () => {
    win.show();
  });
  return win;
}
electron.app.whenReady().then(() => {
  const win = createWindow();
  registerIpcHandlers(win);
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
