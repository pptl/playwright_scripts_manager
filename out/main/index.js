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
function isCallFlowAction(action) {
  return action.type === "callFlow" && typeof action.subFlowId === "string" && typeof action.subFlowExitNodeId === "string";
}
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
class BrowserController {
  browser = null;
  page = null;
  async launch() {
    this.browser = await playwrightCore.chromium.launch({ headless: false });
    const context = await this.browser.newContext({ viewport: null });
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
    function isContentEditable(el) {
      return el.isContentEditable === true;
    }
    function getTarget(e) {
      const path2 = e.composedPath();
      return path2.length > 0 ? path2[0] : e.target;
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
      let el = getTarget(e);
      if (!el?.tagName) return;
      const tag = el.tagName.toLowerCase();
      const type = (el.type || "").toLowerCase();
      if (el.id?.startsWith("__ft_")) return;
      if (tag === "select" || tag === "option") return;
      if (tag === "input" && (type === "date" || type === "range")) return;
      if (tag === "html" || tag === "body") return;
      if (isTextInput(el)) {
        const locatorExpr2 = getLocatorExpr(el);
        const label2 = extractLabel(locatorExpr2, el);
        report({ kind: "click", locatorExpr: locatorExpr2, selector: generateCSSSelector(el), label: label2, timestamp: Date.now(), url: window.location.href, isInputClick: true });
        return;
      }
      if (tag === "input" && (type === "checkbox" || type === "radio")) {
        const locatorExpr2 = getLocatorExpr(el);
        const label2 = extractLabel(locatorExpr2, el);
        report({ kind: el.checked ? "check" : "uncheck", locatorExpr: locatorExpr2, selector: generateCSSSelector(el), label: label2, timestamp: Date.now(), url: window.location.href });
        return;
      }
      let cur = el;
      while (cur) {
        const t = cur.tagName.toLowerCase();
        if (t === "button" || t === "a") {
          el = cur;
          break;
        }
        if (t === "html" || t === "body") break;
        cur = cur.parentElement;
      }
      const locatorExpr = getLocatorExpr(el);
      const label = extractLabel(locatorExpr, el);
      report({ kind: "click", locatorExpr, selector: generateCSSSelector(el), label, timestamp: Date.now(), url: window.location.href });
    }, true);
    document.addEventListener("focus", (e) => {
      const el = getTarget(e);
      if (!el?.tagName) return;
      if (!isTextInput(el) && !isContentEditable(el)) return;
      const value = isContentEditable(el) ? el.innerText : el.value ?? "";
      focusValues.set(el, value);
    }, true);
    document.addEventListener("blur", (e) => {
      const el = getTarget(e);
      if (!el?.tagName) return;
      if (!isTextInput(el) && !isContentEditable(el)) return;
      const initial = focusValues.get(el);
      const current = isContentEditable(el) ? el.innerText : el.value ?? "";
      focusValues.delete(el);
      if (initial === void 0 || current === initial) return;
      const locatorExpr = getLocatorExpr(el);
      report({ kind: "fill", locatorExpr, selector: generateCSSSelector(el), label: extractLabel(locatorExpr, el), value: current, timestamp: Date.now(), url: window.location.href });
    }, true);
    document.addEventListener("change", (e) => {
      const el = getTarget(e);
      if (!el?.tagName || el.tagName.toLowerCase() !== "select") return;
      const opt = el.options[el.selectedIndex];
      const locatorExpr = getLocatorExpr(el);
      report({ kind: "selectOption", locatorExpr, selector: generateCSSSelector(el), label: extractLabel(locatorExpr, el), value: el.value, selectedText: opt?.text?.trim(), timestamp: Date.now(), url: window.location.href });
    }, true);
    document.addEventListener("keydown", (e) => {
      if (typeof e.key !== "string") return;
      const el = getTarget(e);
      if (!el?.tagName) return;
      if (e.key === "Enter" && (el.tagName.toLowerCase() === "textarea" || isContentEditable(el))) return;
      if (["Backspace", "Delete", "AltGraph"].includes(e.key)) return;
      if (e.key === "@" && e.code === "KeyL") return;
      const isMac = navigator.platform.includes("Mac");
      if (isMac && e.key === "v" && e.metaKey) return;
      if (!isMac && e.key === "v" && e.ctrlKey) return;
      if (!isMac && e.key === "Insert" && e.shiftKey) return;
      if (["Shift", "Control", "Meta", "Alt", "Process"].includes(e.key)) return;
      const hasModifier = e.ctrlKey || e.altKey || e.metaKey;
      if (e.key.length === 1 && !hasModifier) return;
      const locatorExpr = getLocatorExpr(el);
      report({ kind: "press", locatorExpr, selector: generateCSSSelector(el), label: extractLabel(locatorExpr, el), value: e.key, timestamp: Date.now(), url: window.location.href });
    }, true);
  };
}
function generateAssertDescription(data) {
  const q = `['"]([^'"]+)['"]`;
  const patterns = [
    new RegExp(`\\bname:\\s*${q}`),
    new RegExp(`getByRole[^(]*\\([^,]+,\\s*\\{[^}]*name:\\s*${q}`),
    new RegExp(`getByLabel\\(${q}`),
    new RegExp(`getByPlaceholder\\(${q}`),
    new RegExp(`getByTestId\\(${q}`),
    new RegExp(`getByText\\(${q}`),
    new RegExp(`getByRole\\(${q}`)
  ];
  let label = data.locatorExpr;
  for (const re of patterns) {
    const m = data.locatorExpr.match(re);
    if (m) {
      label = m[1];
      break;
    }
  }
  if (label === data.locatorExpr && data.selector) label = data.selector;
  switch (data.type) {
    case "assertVisible":
      return `驗證「${label}」可見`;
    case "assertText":
      return `驗證「${label}」文字包含「${data.value ?? ""}」`;
    case "assertValue":
      return `驗證「${label}」值為「${data.value ?? ""}」`;
  }
}
function getAssertionPickScript(assertionType) {
  return `(function(){
  var assertionType = ${JSON.stringify(assertionType)};
  var existing = document.getElementById('__ft_pick_overlay');
  if (existing) existing.remove();
  var existingTip = document.getElementById('__ft_pick_tooltip');
  if (existingTip) existingTip.remove();

  var highlighted = null;
  var prevOutline = '';
  var prevOutlineOffset = '';

  function generateCSSSelector(el) {
    var testId = el.getAttribute('data-testid');
    if (testId) return '[data-testid="' + testId + '"]';
    if (el.id) return '#' + el.id;
    var aria = el.getAttribute('aria-label');
    if (aria) return '[aria-label="' + aria.replace(/"/g, '\\\\"') + '"]';
    var name = el.getAttribute('name');
    if (name) return '[name="' + name.replace(/"/g, '\\\\"') + '"]';
    var tag = el.tagName.toLowerCase();
    var type = (el.type || '').toLowerCase();
    return (type && !['text', ''].includes(type)) ? tag + '[type="' + type + '"]' : tag;
  }

  function getLocatorExpr(el) {
    try {
      var loc = window.__ftGetLocator && window.__ftGetLocator(el);
      if (loc) return loc;
    } catch(e) {}
    return 'locator(' + JSON.stringify(generateCSSSelector(el)) + ')';
  }

  function clearHighlight() {
    if (highlighted) {
      highlighted.style.outline = prevOutline;
      highlighted.style.outlineOffset = prevOutlineOffset;
      highlighted = null;
    }
  }

  function setHighlight(el) {
    if (el === highlighted) return;
    clearHighlight();
    highlighted = el;
    prevOutline = el.style.outline || '';
    prevOutlineOffset = el.style.outlineOffset || '';
    el.style.outline = '2px solid #22c55e';
    el.style.outlineOffset = '2px';
  }

  var overlay = document.createElement('div');
  overlay.id = '__ft_pick_overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;cursor:crosshair;background:transparent;';
  document.documentElement.appendChild(overlay);

  var tooltip = document.createElement('div');
  tooltip.id = '__ft_pick_tooltip';
  tooltip.style.cssText = 'position:fixed;z-index:2147483647;padding:4px 8px;background:#0f172a;color:#22c55e;border:1px solid #22c55e;border-radius:4px;font-size:11px;font-family:monospace;pointer-events:none;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:none;';
  document.documentElement.appendChild(tooltip);

  overlay.addEventListener('mousemove', function(e) {
    overlay.style.display = 'none';
    var el = document.elementFromPoint(e.clientX, e.clientY);
    overlay.style.display = '';
    if (!el || el === overlay || el === tooltip) return;
    setHighlight(el);
    tooltip.textContent = getLocatorExpr(el);
    var tx = Math.min(e.clientX + 14, window.innerWidth - 370);
    var ty = e.clientY + 22;
    if (ty + 30 > window.innerHeight) ty = e.clientY - 32;
    tooltip.style.left = tx + 'px';
    tooltip.style.top = ty + 'px';
    tooltip.style.display = 'block';
  });

  overlay.addEventListener('mouseleave', function() {
    tooltip.style.display = 'none';
  });

  overlay.addEventListener('click', function(e) {
    overlay.style.display = 'none';
    var el = document.elementFromPoint(e.clientX, e.clientY);
    overlay.remove();
    tooltip.remove();
    clearHighlight();
    if (!el) return;
    var selector = generateCSSSelector(el);
    var locatorExpr = getLocatorExpr(el);
    var value;
    if (assertionType === 'assertText') {
      value = (el.textContent || '').trim().slice(0, 500);
    } else if (assertionType === 'assertValue') {
      value = el.value !== undefined ? String(el.value) : '';
    }
    try {
      window.__flowtest_assert_report({ type: assertionType, selector: selector, locatorExpr: locatorExpr, value: value, url: window.location.href });
    } catch(e) {}
  });

  document.addEventListener('keydown', function escHandler(e) {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    overlay.remove();
    tooltip.remove();
    clearHighlight();
    document.removeEventListener('keydown', escHandler, true);
    try { window.__flowtest_assert_cancel(); } catch(e) {}
  }, true);
})();`;
}
function getCursorHighlightScript() {
  return `(function() {
  function install() {
    if (document.getElementById('__ft_cursor_highlight')) return;
    var root = document.body || document.documentElement;
    if (!root) return;
    var dot = document.createElement('div');
    dot.id = '__ft_cursor_highlight';
    dot.style.cssText = 'position:fixed;top:0;left:0;width:32px;height:32px;border-radius:50%;' +
      'background:rgba(234,179,8,0.25);border:2.5px solid rgba(234,179,8,0.85);' +
      'box-shadow:0 0 0 4px rgba(234,179,8,0.12);pointer-events:none;' +
      'z-index:2147483645;display:none';
    root.appendChild(dot);
    document.addEventListener('mousemove', function(e) {
      dot.style.transform = 'translate(' + (e.clientX - 16) + 'px,' + (e.clientY - 16) + 'px)';
      dot.style.display = 'block';
    }, true);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})()`;
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
  assertFunctionsExposed = false;
  assertReportCb = null;
  assertCancelCb = null;
  pendingInputClick = null;
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
    const cursorScript = getCursorHighlightScript();
    await page.addInitScript(cursorScript);
    await page.evaluate(cursorScript).catch(() => {
    });
    await page.exposeFunction("__flowtest_report", (raw) => {
      if (!this.active) return;
      const action = buildAction(raw);
      if (!action) return;
      if (raw.isInputClick) {
        this.flushPendingInputClick();
        this.pendingInputClick = action;
        this.lastInteraction = { time: Date.now(), type: action.type };
        return;
      }
      if (action.type === "fill" && this.pendingInputClick?.selector === action.selector) {
        this.pendingInputClick = null;
      } else {
        this.flushPendingInputClick();
      }
      this.lastInteraction = { time: Date.now(), type: action.type };
      this.onAction(action);
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
  flushPendingInputClick() {
    if (this.pendingInputClick) {
      this.onAction(this.pendingInputClick);
      this.pendingInputClick = null;
    }
  }
  async stop() {
    this.pendingInputClick = null;
    this.active = false;
  }
  async startAssertionPick(assertionType, onCancel) {
    const pages = this.context.pages();
    const page = pages[0];
    if (!page) return;
    if (!this.assertFunctionsExposed) {
      this.assertFunctionsExposed = true;
      await page.exposeFunction("__flowtest_assert_report", (data) => {
        this.assertReportCb?.(data);
      });
      await page.exposeFunction("__flowtest_assert_cancel", () => {
        this.assertCancelCb?.();
      });
    }
    this.assertReportCb = (data) => {
      const action = {
        id: uuid.v4(),
        type: data.type,
        selector: data.selector,
        locatorExpr: data.locatorExpr,
        value: data.value,
        description: generateAssertDescription(data),
        timestamp: Date.now(),
        url: data.url,
        isPageNavigation: false
      };
      this.onAction(action);
    };
    this.assertCancelCb = onCancel;
    await page.evaluate(getAssertionPickScript(assertionType));
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
  async startAssertionPick(assertionType, onCancel) {
    await this.capture.startAssertionPick(assertionType, onCancel);
  }
  isRecording() {
    return this.recording;
  }
}
function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}
function generateRandomText(len = 8) {
  return Math.random().toString(36).substring(2, 2 + len).padEnd(len, "0");
}
function generateRandomNumber(len = 8) {
  const min = Math.pow(10, len - 1);
  const max = Math.pow(10, len) - 1;
  return String(Math.floor(Math.random() * (max - min + 1)) + min);
}
function generateRandomOneLetter() {
  return String.fromCharCode(65 + Math.floor(Math.random() * 26));
}
function generateRandomOneDigit() {
  return String(Math.floor(Math.random() * 10));
}
function generateTimestamp() {
  const d = /* @__PURE__ */ new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`;
}
function resolveValue(value, profileVars) {
  return value.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    if (profileVars && name in profileVars) return profileVars[name];
    if (name === "randomText") return generateRandomText();
    if (name === "randomNumber") return generateRandomNumber();
    if (name === "randomOneText") return generateRandomOneLetter();
    if (name === "randomOneNumber") return generateRandomOneDigit();
    if (name === "timestamp") return generateTimestamp();
    return match;
  });
}
function resolveValueWithSession(value, sessionVars, profileVars) {
  return value.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    if (sessionVars.has(name)) return sessionVars.get(name);
    if (profileVars && name in profileVars) return profileVars[name];
    if (name === "randomText") return generateRandomText();
    if (name === "randomNumber") return generateRandomNumber();
    if (name === "randomOneText") return generateRandomOneLetter();
    if (name === "randomOneNumber") return generateRandomOneDigit();
    if (name === "timestamp") return generateTimestamp();
    return match;
  });
}
function hasVariables(value) {
  return /\{\{.+?\}\}/.test(value);
}
function valueToCodeExpr(value, profileVarKeys) {
  if (!hasVariables(value)) {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  const inner = value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${").replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (profileVarKeys?.has(name)) return `\${_ftProf_${name}}`;
    if (name === "randomText") return "${_ftRandomText()}";
    if (name === "randomNumber") return "${_ftRandomNumber()}";
    if (name === "randomOneText") return "${_ftRandomOneLetter()}";
    if (name === "randomOneNumber") return "${_ftRandomOneDigit()}";
    if (name === "timestamp") return "${_ftTimestamp()}";
    return `{{${name}}}`;
  });
  return "`" + inner + "`";
}
function sessionAwareValueToCodeExpr(value, sessionVarNames, profileVarKeys) {
  if (!hasVariables(value)) {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  const singleVar = value.match(/^\{\{(\w+)\}\}$/);
  if (singleVar && sessionVarNames.has(singleVar[1])) {
    return singleVar[1];
  }
  const inner = value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${").replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (sessionVarNames.has(name)) return `\${${name}}`;
    if (profileVarKeys?.has(name)) return `\${_ftProf_${name}}`;
    if (name === "randomText") return "${_ftRandomText()}";
    if (name === "randomNumber") return "${_ftRandomNumber()}";
    if (name === "randomOneText") return "${_ftRandomOneLetter()}";
    if (name === "randomOneNumber") return "${_ftRandomOneDigit()}";
    if (name === "timestamp") return "${_ftTimestamp()}";
    return `{{${name}}}`;
  });
  return "`" + inner + "`";
}
function emitProfileVarDecls(profileVars) {
  return Object.entries(profileVars).map(([key, value]) => `const _ftProf_${key} = ${JSON.stringify(value)};`).join("\n");
}
const VARIABLE_HELPERS_CODE = `
function _ftRandomText(len = 8) {
  return Math.random().toString(36).substring(2, 2 + len).padEnd(len, '0');
}
function _ftRandomNumber(len = 8) {
  const min = Math.pow(10, len - 1);
  return String(Math.floor(Math.random() * (Math.pow(10, len) - min)) + min);
}
function _ftRandomOneLetter() {
  return String.fromCharCode(65 + Math.floor(Math.random() * 26));
}
function _ftRandomOneDigit() {
  return String(Math.floor(Math.random() * 10));
}
function _ftTimestamp() {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return \`\${d.getFullYear()}\${p(d.getMonth() + 1)}\${p(d.getDate())}\${p(d.getHours())}\${p(d.getMinutes())}\${p(d.getSeconds())}\${p(d.getMilliseconds(), 3)}\`;
}
`;
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
class Replayer {
  page;
  sessionVars = /* @__PURE__ */ new Map();
  baseOrigin;
  profileVars;
  activeProfileId;
  constructor(page, baseURL = "", profileVars, activeProfileId) {
    this.page = page;
    this.profileVars = profileVars ?? {};
    this.activeProfileId = activeProfileId;
    this.baseOrigin = (() => {
      try {
        return new URL(baseURL).origin;
      } catch {
        return "";
      }
    })();
  }
  async replayToNode(nodes, targetNodeId, onNodeStart, onNodeComplete, speed = 500) {
    this.sessionVars.clear();
    const cursorScript = getCursorHighlightScript();
    await this.page.addInitScript(cursorScript);
    await this.page.evaluate(cursorScript).catch(() => {
    });
    const path2 = this.findPath(nodes, targetNodeId);
    for (const node of path2) {
      onNodeStart(node.id);
      try {
        if (isCallFlowAction(node.action)) {
          await this.executeCallFlow(node.action, onNodeStart, onNodeComplete, speed);
        } else {
          await this.executeAction(node.action);
          if (node.action.assertion) {
            await this.executeAssertion(node.action);
          }
        }
        onNodeComplete(node.id, true);
      } catch (err) {
        onNodeComplete(node.id, false, String(err));
        throw err;
      }
      await new Promise((res) => setTimeout(res, speed));
    }
  }
  getSessionVars() {
    return this.sessionVars;
  }
  async executeCallFlow(action, onNodeStart, onNodeComplete, speed) {
    const subFlow = await FlowStorage.load(action.subFlowId);
    if (!subFlow) throw new Error(`子流程 "${action.subFlowId}" 不存在`);
    let resolvedSubProfileId = action.subFlowProfileId ?? null;
    if (action.subFlowProfileMapping && this.activeProfileId && this.activeProfileId in action.subFlowProfileMapping) {
      resolvedSubProfileId = action.subFlowProfileMapping[this.activeProfileId];
    }
    let subProfileVars = {};
    if (resolvedSubProfileId) {
      const profile = subFlow.profiles?.find((p) => p.id === resolvedSubProfileId);
      if (profile) {
        subProfileVars = Object.fromEntries(profile.vars.map((v) => [v.key, v.value]));
      }
    } else if (!resolvedSubProfileId && subFlow.profiles && subFlow.profiles.length > 0) {
      const firstProfile = subFlow.profiles[0];
      subProfileVars = Object.fromEntries(firstProfile.vars.map((v) => [v.key, v.value]));
      resolvedSubProfileId = firstProfile.id;
    }
    const nested = new Replayer(this.page, subFlow.baseURL, subProfileVars, resolvedSubProfileId ?? void 0);
    await nested.replayToNode(
      subFlow.nodes,
      action.subFlowExitNodeId,
      onNodeStart,
      onNodeComplete,
      speed
    );
    for (const [k, v] of nested.getSessionVars()) {
      this.sessionVars.set(k, v);
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
  substituteOrigin(url) {
    const domainOverride = this.profileVars["domain"];
    if (!domainOverride || !this.baseOrigin) return url;
    try {
      const parsed = new URL(url);
      if (parsed.origin === this.baseOrigin) {
        return domainOverride + parsed.pathname + parsed.search + parsed.hash;
      }
    } catch {
    }
    return url;
  }
  async executeAction(action) {
    const val = action.value != null ? resolveValueWithSession(action.value, this.sessionVars, this.profileVars) : void 0;
    switch (action.type) {
      case "goto":
        await this.page.goto(this.substituteOrigin(val));
        break;
      case "click":
        await this.getLocator(action).click();
        break;
      case "fill":
        await this.getLocator(action).fill(val ?? "");
        break;
      case "selectOption":
        await this.getLocator(action).selectOption(val ?? "");
        break;
      case "check":
        await this.getLocator(action).check();
        break;
      case "uncheck":
        await this.getLocator(action).uncheck();
        break;
      case "press":
        if (action.locatorExpr) {
          await this.getLocator(action).press(val ?? "");
        } else {
          await this.page.keyboard.press(val ?? "");
        }
        break;
      case "wait":
        await this.getLocator(action).waitFor({ state: "visible" });
        break;
    }
    if (action.captureAs && val != null) {
      this.sessionVars.set(action.captureAs, val);
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
function exportsDir() {
  return electron.app.isPackaged ? path.join(electron.app.getPath("userData"), "exports") : path.join(process.cwd(), "exports");
}
class ScriptExporter {
  static async export(flow, config) {
    const outputDir = config.outputDir || exportsDir();
    await fs.promises.mkdir(outputDir, { recursive: true });
    const subFlowMap = await ScriptExporter.resolveSubFlows(flow);
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
    const specContent = ScriptExporter.generateSpec(flow, paths, nodeMap, config, helperImport, subFlowMap, config.activeProfileId);
    const specPath = path.join(outputDir, `${flow.id}.spec.ts`);
    await fs.promises.writeFile(specPath, specContent, "utf-8");
    return specPath;
  }
  static async resolveSubFlows(flow, visited = /* @__PURE__ */ new Set()) {
    const result = /* @__PURE__ */ new Map();
    for (const node of flow.nodes) {
      if (isCallFlowAction(node.action) && !visited.has(node.action.subFlowId)) {
        visited.add(node.action.subFlowId);
        const sub = await FlowStorage.load(node.action.subFlowId);
        if (sub) {
          result.set(sub.id, sub);
          const nested = await ScriptExporter.resolveSubFlows(sub, visited);
          for (const [k, v] of nested) result.set(k, v);
        }
      }
    }
    return result;
  }
  static resolveProfileVars(flow, profileId) {
    const profile = profileId ? (flow.profiles ?? []).find((p) => p.id === profileId) : (flow.profiles ?? [])[0];
    if (!profile) return {};
    return Object.fromEntries(profile.vars.map((v) => [v.key, v.value]));
  }
  /** Resolve which sub-flow profile ID to use given the parent's active profile.
   *  subFlowProfileMapping takes precedence; falls back to legacy subFlowProfileId. */
  static resolveSubFlowProfileId(action, parentActiveProfileId) {
    if (action.subFlowProfileMapping && parentActiveProfileId && parentActiveProfileId in action.subFlowProfileMapping) {
      return action.subFlowProfileMapping[parentActiveProfileId];
    }
    return action.subFlowProfileId ?? null;
  }
  static getSubFlowPath(subFlow, exitNodeId, subFlowMap, subProfileVars, subBaseOrigin, activeProfileId) {
    const nodeMap = new Map(subFlow.nodes.map((n) => [n.id, n]));
    const path2 = [];
    const visited = /* @__PURE__ */ new Set();
    let cur = nodeMap.get(exitNodeId);
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id);
      if (isCallFlowAction(cur.action)) {
        const nested = subFlowMap.get(cur.action.subFlowId);
        if (nested) {
          const nestedProfileId = ScriptExporter.resolveSubFlowProfileId(cur.action, activeProfileId);
          const nestedProfileVars = ScriptExporter.resolveProfileVars(nested, nestedProfileId);
          const nestedBaseOrigin = (() => {
            try {
              return new URL(nested.baseURL).origin;
            } catch {
              return "";
            }
          })();
          path2.unshift(...ScriptExporter.getSubFlowPath(nested, cur.action.subFlowExitNodeId, subFlowMap, nestedProfileVars, nestedBaseOrigin, nestedProfileId ?? void 0));
        }
      } else {
        path2.unshift({ node: cur, profileVars: subProfileVars, baseOrigin: subBaseOrigin, inlineVars: true });
      }
      cur = cur.parentId ? nodeMap.get(cur.parentId) : void 0;
    }
    return path2;
  }
  static buildStepSequence(nodeIds, nodeMap, subFlowMap, defaultProfileVars = {}, defaultBaseOrigin = "", activeProfileId) {
    const result = [];
    for (const id of nodeIds) {
      const node = nodeMap.get(id);
      if (!node) continue;
      if (isCallFlowAction(node.action)) {
        const subFlow = subFlowMap.get(node.action.subFlowId);
        if (subFlow) {
          const subProfileId = ScriptExporter.resolveSubFlowProfileId(node.action, activeProfileId);
          const subProfileVars = ScriptExporter.resolveProfileVars(subFlow, subProfileId);
          const subBaseOrigin = (() => {
            try {
              return new URL(subFlow.baseURL).origin;
            } catch {
              return "";
            }
          })();
          result.push(...ScriptExporter.getSubFlowPath(subFlow, node.action.subFlowExitNodeId, subFlowMap, subProfileVars, subBaseOrigin, subProfileId ?? void 0));
        }
      } else {
        result.push({ node, profileVars: defaultProfileVars, baseOrigin: defaultBaseOrigin, inlineVars: false });
      }
    }
    return result;
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
    const root = nodeMap.get(flow.rootNodeId) ?? flow.nodes.find((n) => n.parentId === null);
    if (root) walk(root, [], []);
    return paths;
  }
  static generateSpec(flow, paths, nodeMap, config, helperImport, subFlowMap = /* @__PURE__ */ new Map(), activeProfileId) {
    const profileVars = config.profileVars ?? {};
    const profileVarKeys = new Set(Object.keys(profileVars));
    const hasProfileVars = profileVarKeys.size > 0;
    const baseOrigin = (() => {
      try {
        return new URL(flow.baseURL).origin;
      } catch {
        return "";
      }
    })();
    const usesVariables = flow.nodes.some((n) => n.action.value && hasVariables(n.action.value));
    const tests = paths.map((path2, idx) => {
      const testName = path2.name || `測試路徑 ${idx + 1}`;
      const steps = ScriptExporter.buildStepSequence(path2.nodeIds, nodeMap, subFlowMap, profileVars, baseOrigin, activeProfileId);
      const sessionVarsDefined = /* @__PURE__ */ new Set();
      const hoistedVars = config.useTestStep ? new Set(steps.map(({ node }) => node.action.captureAs).filter((v) => !!v)) : /* @__PURE__ */ new Set();
      const hoistDecls = hoistedVars.size > 0 ? [...hoistedVars].map((v) => `    let ${v} = ''`).join("\n") + "\n" : "";
      const stepCode = steps.map(({ node, profileVars: stepProfileVars, baseOrigin: stepBaseOrigin, inlineVars }) => {
        const rawAction = ScriptExporter.actionToCode(node, sessionVarsDefined, stepBaseOrigin, stepProfileVars, inlineVars, hoistedVars);
        const assertCode = node.action.assertion ? ScriptExporter.assertionToCode(node.action) : "";
        if (config.useTestStep) {
          const action2 = rawAction.replace(/\n/g, "\n      ");
          return `    await test.step('${node.action.description}', async () => {
      ${action2}${assertCode ? "\n      " + assertCode : ""}
    });`;
        }
        const action = rawAction.replace(/\n/g, "\n    ");
        return `    // ${node.action.description}
    ${action}${assertCode ? "\n    " + assertCode : ""}`;
      }).join("\n\n");
      return `  test('${testName}', async ({ page }) => {
${hoistDecls}${stepCode}
  });`;
    }).join("\n\n");
    return [
      `import { test, expect } from '@playwright/test';`,
      helperImport,
      usesVariables ? VARIABLE_HELPERS_CODE : "",
      hasProfileVars ? `
${emitProfileVarDecls(profileVars)}` : "",
      "",
      `test.describe('${flow.name}', () => {`,
      "",
      tests,
      "",
      "});"
    ].filter((line) => line !== void 0).join("\n");
  }
  static actionToCode(node, sessionVarsDefined, baseOrigin = "", profileVars = {}, inlineVars = false, hoistedVars = /* @__PURE__ */ new Set()) {
    const { action } = node;
    const profileVarKeys = inlineVars ? /* @__PURE__ */ new Set() : new Set(Object.keys(profileVars));
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
    const resolveProfilePlaceholders = (v) => inlineVars ? v.replace(/\{\{(\w+)\}\}/g, (m, k) => k in profileVars ? profileVars[k] : m) : v;
    const captureAs = action.captureAs;
    let captureDecl = "";
    if (captureAs) {
      const expr = valueToCodeExpr(resolveProfilePlaceholders(action.value ?? ""), profileVarKeys);
      captureDecl = hoistedVars.has(captureAs) ? `${captureAs} = ${expr};
` : `const ${captureAs} = ${expr};
`;
      sessionVarsDefined.add(captureAs);
    }
    const va = (v) => captureAs ? captureAs : sessionAwareValueToCodeExpr(resolveProfilePlaceholders(v), sessionVarsDefined, profileVarKeys);
    switch (action.type) {
      case "goto": {
        let gotoVal = action.value ?? "";
        const domainOverride = profileVars["domain"];
        if (domainOverride && baseOrigin) {
          try {
            const parsed = new URL(gotoVal);
            if (parsed.origin === baseOrigin) {
              const rest = parsed.pathname + parsed.search + parsed.hash;
              if (inlineVars) {
                return `${captureDecl}await page.goto('${domainOverride}${rest}');`;
              }
              return `${captureDecl}await page.goto(\`\${_ftProf_domain}${rest}\`);`;
            }
          } catch {
          }
        }
        if (inlineVars) {
          gotoVal = resolveValue(gotoVal, profileVars);
        }
        return `${captureDecl}await page.goto(${va(gotoVal)});`;
      }
      case "click":
        return `await ${loc}.click();`;
      case "fill":
        return `${captureDecl}await ${loc}.fill(${va(action.value ?? "")});`;
      case "selectOption":
        return `${captureDecl}await ${loc}.selectOption(${va(action.value ?? "")});`;
      case "check":
        return `await ${loc}.check();`;
      case "uncheck":
        return `await ${loc}.uncheck();`;
      case "press":
        return action.locatorExpr ? `${captureDecl}await ${loc}.press(${va(action.value ?? "")});` : `${captureDecl}await page.keyboard.press(${va(action.value ?? "")});`;
      case "wait":
        return `await ${loc}.waitFor({ state: 'visible' });`;
      case "assertVisible":
        return `await expect(${loc}).toBeVisible();`;
      case "assertText": {
        const valueExpr = va(action.value ?? "");
        const isSessionVar = !!action.value && /^\{\{(\w+)\}\}$/.test(action.value) && sessionVarsDefined.has(action.value.slice(2, -2));
        const assertLoc = isSessionVar && action.selector ? `page.locator('${action.selector}').filter({ hasText: ${valueExpr} })` : loc;
        return `${captureDecl}await expect(${assertLoc}).toContainText(${valueExpr});`;
      }
      case "assertValue":
        return `${captureDecl}await expect(${loc}).toHaveValue(${va(action.value ?? "")});`;
      case "callFlow":
        return "// [callFlow — should have been expanded by buildStepSequence]";
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
    const helperSessionVars = /* @__PURE__ */ new Set();
    const body = prefixNodes.map((node) => {
      const rawAction = ScriptExporter.actionToCode(node, helperSessionVars);
      const action = rawAction.replace(/\n/g, "\n  ");
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
      const silentReplayer = new Replayer(page, payload.baseURL, payload.profileVars, payload.activeProfileId);
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
  electron.ipcMain.handle(IPC_CHANNELS.START_ASSERTION_PICK, async (_e, assertionType) => {
    if (!recorder) return;
    await recorder.startAssertionPick(
      assertionType,
      () => win.webContents.send(IPC_CHANNELS.ASSERTION_PICK_CANCELLED)
    );
  });
  electron.ipcMain.handle(IPC_CHANNELS.REPLAY_TO_NODE, async (_e, payload) => {
    try {
      if (!browserController || !browserController.isRunning()) {
        browserController = new BrowserController();
        await browserController.launch();
      }
      const page = browserController.getPage();
      replayer = new Replayer(page, payload.baseURL, payload.profileVars, payload.activeProfileId);
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
  electron.ipcMain.handle(IPC_CHANNELS.FLOW_DELETE, async (_e, flowId) => {
    await FlowStorage.delete(flowId);
  });
  electron.ipcMain.handle(IPC_CHANNELS.FLOW_GET, async (_e, { flowId }) => {
    return await FlowStorage.load(flowId);
  });
  electron.ipcMain.handle(
    IPC_CHANNELS.FLOW_CHECK_CYCLE,
    async (_e, { currentFlowId, candidateSubFlowId }) => {
      return await hasCallFlowCycle(currentFlowId, candidateSubFlowId);
    }
  );
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
    const specFilename = path.basename(specPath);
    win.webContents.send(IPC_CHANNELS.TEST_OUTPUT, `▶ npx playwright test ${specFilename}

`);
    const exitCode = await new Promise((resolve) => {
      const child = child_process.spawn("npx", ["playwright", "test", specFilename, "--reporter=list,html"], {
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
  });
  electron.ipcMain.handle(IPC_CHANNELS.SHOW_REPORT, async () => {
    const cwd = electron.app.isPackaged ? path.join(electron.app.getPath("userData")) : process.cwd();
    await killProcessOnPort(9323);
    child_process.spawn("npx", ["playwright", "show-report"], { cwd, shell: true, detached: true });
  });
}
async function hasCallFlowCycle(startFlowId, candidateSubFlowId, visited = /* @__PURE__ */ new Set()) {
  if (candidateSubFlowId === startFlowId) return true;
  if (visited.has(candidateSubFlowId)) return false;
  visited.add(candidateSubFlowId);
  const subFlow = await FlowStorage.load(candidateSubFlowId);
  if (!subFlow) return false;
  const nestedCallIds = subFlow.nodes.filter((n) => isCallFlowAction(n.action)).map((n) => n.action.subFlowId);
  for (const nestedId of nestedCallIds) {
    if (await hasCallFlowCycle(startFlowId, nestedId, visited)) return true;
  }
  return false;
}
function killProcessOnPort(port) {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      const finder = child_process.spawn("cmd", ["/c", `netstat -ano | findstr :${port}`], { shell: false });
      let output = "";
      finder.stdout.on("data", (d) => {
        output += d.toString();
      });
      finder.on("close", () => {
        const pids = /* @__PURE__ */ new Set();
        for (const line of output.split("\n")) {
          if (/LISTENING/i.test(line)) {
            const localAddr = line.trim().split(/\s+/)[1] ?? "";
            if (localAddr.endsWith(`:${port}`)) {
              const pid = line.trim().split(/\s+/).at(-1) ?? "";
              if (/^\d+$/.test(pid)) pids.add(pid);
            }
          }
        }
        if (pids.size === 0) return resolve();
        let remaining = pids.size;
        const done = () => {
          if (--remaining === 0) setTimeout(resolve, 300);
        };
        for (const pid of pids) {
          const killer = child_process.spawn("taskkill", ["/F", "/PID", pid], { shell: true });
          killer.on("close", done);
          killer.on("error", done);
        }
      });
      finder.on("error", () => resolve());
    } else {
      const finder = child_process.spawn("sh", ["-c", `lsof -ti :${port}`], { shell: false });
      let output = "";
      finder.stdout.on("data", (d) => {
        output += d.toString();
      });
      finder.on("close", () => {
        const pids = output.trim().split("\n").filter((p) => /^\d+$/.test(p));
        if (pids.length === 0) return resolve();
        let remaining = pids.length;
        const done = () => {
          if (--remaining === 0) setTimeout(resolve, 300);
        };
        for (const pid of pids) {
          const killer = child_process.spawn("kill", ["-9", pid], { shell: false });
          killer.on("close", done);
          killer.on("error", done);
        }
      });
      finder.on("error", () => resolve());
    }
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
