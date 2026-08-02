"use strict";
const electron = require("electron");
const path = require("path");
const child_process = require("child_process");
const fs = require("fs");
const playwrightCore = require("playwright-core");
const uuid = require("uuid");
const vm = require("vm");
const module$1 = require("module");
const os = require("os");
const crypto = require("crypto");
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
const DEFAULT_PROJECT_ID = "__default__";
const DEFAULT_PROJECT_NAME = "未分類";
const DOMAIN_ENV_KEY = "domain";
const DEFAULT_ENV_NAME = "DEV";
const DEFAULT_DOMAIN = "http://localhost:3000/";
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
class BrowserController {
  browser = null;
  page = null;
  async launch(options) {
    this.browser = await playwrightCore.chromium.launch({
      headless: false,
      args: options?.maximized ? ["--start-maximized"] : void 0
    });
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
function generateDescription(kind, label, value, selectedText, clickOpts) {
  switch (kind) {
    case "click": {
      const mods = clickOpts?.modifiers?.length ? `${clickOpts.modifiers.join("+")}+` : "";
      if ((clickOpts?.clickCount ?? 1) >= 2) return `${mods}雙擊「${label}」`;
      if (clickOpts?.button === "right") return `${mods}右鍵點擊「${label}」`;
      if (clickOpts?.button === "middle") return `${mods}中鍵點擊「${label}」`;
      return `${mods}點擊「${label}」`;
    }
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
    case "upload":
      return `上傳檔案「${value ?? ""}」到「${label}」`;
  }
}
function extractSource3() {
  const _req2 = module$1.createRequire(require("url").pathToFileURL(__filename).href);
  let coreBundlePath;
  try {
    coreBundlePath = _req2.resolve("playwright-core/lib/coreBundle.js");
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
    function qualifyFileInputLocator(expr, el) {
      if (!/^locator\(\s*['"]input\[type=['"]?file['"]?\]['"]\s*\)$/.test(expr)) return expr;
      const h = el;
      const testId = h.getAttribute("data-testid");
      if (testId) return `locator('input[data-testid="${testId}"]')`;
      if (h.id) return `locator('input#${CSS.escape(h.id)}')`;
      const name = h.getAttribute("name");
      if (name) return `locator('input[name="${name}"]')`;
      return expr;
    }
    let lastClickEl = null;
    let lastClickTime = 0;
    function findTriggerSelector(input) {
      const el = lastClickEl;
      if (!el || Date.now() - lastClickTime > 3e5) return void 0;
      const label = input.labels;
      let related = el === input || !!el.id && el.id === input.id || !!label && Array.prototype.some.call(label, (l) => l === el || l.contains(el));
      let anc = input;
      for (let i = 0; !related && i < 3 && anc; i++) {
        anc = anc.parentElement;
        if (anc && (anc === el || anc.contains(el))) related = true;
      }
      return related ? generateCSSSelector(el) : void 0;
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
    const lastTypedValues = /* @__PURE__ */ new WeakMap();
    let currentFocusedInput = null;
    function flushPendingFill() {
      const el = currentFocusedInput;
      if (!el) return;
      const initial = focusValues.get(el);
      const current = lastTypedValues.get(el);
      if (initial === void 0 || current === void 0 || current === initial) return;
      const locatorExpr = getLocatorExpr(el);
      report({ kind: "fill", locatorExpr, selector: generateCSSSelector(el), label: extractLabel(locatorExpr, el), value: current, timestamp: Date.now(), url: window.location.href });
      focusValues.set(el, current);
    }
    function modifiersFor(e) {
      const m = [];
      if (e.altKey) m.push("Alt");
      if (e.ctrlKey) m.push("Control");
      if (e.metaKey) m.push("Meta");
      if (e.shiftKey) m.push("Shift");
      return m;
    }
    function handleMouseAction(e, button, clickCount) {
      let el = getTarget(e);
      if (!el?.tagName) return;
      lastClickEl = el;
      lastClickTime = Date.now();
      if (currentFocusedInput && currentFocusedInput !== el) flushPendingFill();
      const tag = el.tagName.toLowerCase();
      const type = (el.type || "").toLowerCase();
      if (el.id?.startsWith("__ft_")) return;
      if (el.closest?.('[id^="__ft_"]')) return;
      if (tag === "select" || tag === "option") return;
      if (tag === "input" && (type === "date" || type === "range")) return;
      if (tag === "input" && type === "file") return;
      if (tag === "html" || tag === "body") return;
      const mods = modifiersFor(e);
      const extras = {
        button: button !== "left" ? button : void 0,
        clickCount: clickCount >= 2 ? clickCount : void 0,
        modifiers: mods.length ? mods : void 0
      };
      if (isTextInput(el) && button === "left") {
        const locatorExpr2 = getLocatorExpr(el);
        const label2 = extractLabel(locatorExpr2, el);
        report({ kind: "click", locatorExpr: locatorExpr2, selector: generateCSSSelector(el), label: label2, timestamp: Date.now(), url: window.location.href, isInputClick: true, ...extras });
        return;
      }
      if (tag === "input" && (type === "checkbox" || type === "radio") && button === "left") {
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
      let alternativeLocators;
      const tr = button === "left" && clickCount < 2 ? el.closest?.("tr") : null;
      if (tr && tr.parentElement) {
        const rows = Array.from(tr.parentElement.children).filter(
          (c) => c.tagName === "TR"
        );
        const rowIndex = rows.indexOf(tr);
        if (rowIndex >= 0) {
          const parentTag = (tr.parentElement.tagName || "tbody").toLowerCase();
          const table = tr.closest?.("table");
          let rowExpr;
          if (table) {
            const allTables = Array.from(document.querySelectorAll("table"));
            const tableIndex = allTables.indexOf(table);
            if (tableIndex >= 0 && allTables.length > 1) {
              rowExpr = `locator('table').nth(${tableIndex}).locator('${parentTag} tr').nth(${rowIndex})`;
            } else {
              rowExpr = `locator('${parentTag} tr').nth(${rowIndex})`;
            }
          } else {
            rowExpr = `locator('${parentTag} tr').nth(${rowIndex})`;
          }
          alternativeLocators = [
            { label: `Cell — ${locatorExpr}`, expr: locatorExpr },
            { label: `Row ${rowIndex + 1} (nth) — ${rowExpr}`, expr: rowExpr }
          ];
        }
      }
      report({ kind: "click", locatorExpr, selector: generateCSSSelector(el), label, timestamp: Date.now(), url: window.location.href, alternativeLocators, ...extras });
    }
    document.addEventListener("click", (e) => {
      if (e.detail >= 2) return;
      handleMouseAction(e, "left", 1);
    }, true);
    document.addEventListener("dblclick", (e) => {
      handleMouseAction(e, "left", 2);
    }, true);
    document.addEventListener("contextmenu", (e) => {
      handleMouseAction(e, "right", 1);
    }, true);
    document.addEventListener("auxclick", (e) => {
      if (e.button === 1) handleMouseAction(e, "middle", 1);
    }, true);
    document.addEventListener("focus", (e) => {
      const el = getTarget(e);
      if (!el?.tagName) return;
      if (!isTextInput(el) && !isContentEditable(el)) return;
      const value = isContentEditable(el) ? el.innerText : el.value ?? "";
      focusValues.set(el, value);
      lastTypedValues.set(el, value);
      currentFocusedInput = el;
    }, true);
    document.addEventListener("input", (e) => {
      const el = getTarget(e);
      if (!el?.tagName) return;
      if (!isTextInput(el) && !isContentEditable(el)) return;
      const value = isContentEditable(el) ? el.innerText : el.value ?? "";
      lastTypedValues.set(el, value);
    }, true);
    document.addEventListener("blur", (e) => {
      const el = getTarget(e);
      if (!el?.tagName) return;
      if (!isTextInput(el) && !isContentEditable(el)) return;
      if (currentFocusedInput === el) currentFocusedInput = null;
      const initial = focusValues.get(el);
      const current = lastTypedValues.get(el);
      focusValues.delete(el);
      lastTypedValues.delete(el);
      if (initial === void 0 || current === void 0 || current === initial) return;
      const locatorExpr = getLocatorExpr(el);
      report({ kind: "fill", locatorExpr, selector: generateCSSSelector(el), label: extractLabel(locatorExpr, el), value: current, timestamp: Date.now(), url: window.location.href });
    }, true);
    document.addEventListener("change", (e) => {
      const el = getTarget(e);
      if (!el?.tagName) return;
      const tag = el.tagName.toLowerCase();
      if (tag === "select") {
        const locatorExpr = getLocatorExpr(el);
        if (el.multiple) {
          const selected = Array.from(el.selectedOptions);
          const values = selected.map((o) => o.value);
          report({ kind: "selectOption", locatorExpr, selector: generateCSSSelector(el), label: extractLabel(locatorExpr, el), value: values.join(", "), values, selectedText: selected.map((o) => o.text?.trim()).join("、"), timestamp: Date.now(), url: window.location.href });
          return;
        }
        const opt = el.options[el.selectedIndex];
        report({ kind: "selectOption", locatorExpr, selector: generateCSSSelector(el), label: extractLabel(locatorExpr, el), value: el.value, selectedText: opt?.text?.trim(), timestamp: Date.now(), url: window.location.href });
        return;
      }
      const inputType = (el.type || "").toLowerCase();
      if (tag === "input" && inputType === "file") {
        const input = el;
        const names = Array.from(input.files ?? []).map((f) => f.name);
        if (names.length === 0) return;
        try {
          (window.top || window).__ft_lastUploadInput = input;
        } catch (err) {
          window.__ft_lastUploadInput = input;
        }
        const locatorExpr = qualifyFileInputLocator(getLocatorExpr(el), el);
        report({ kind: "upload", locatorExpr, selector: generateCSSSelector(el), label: extractLabel(locatorExpr, el), value: names.join(", "), timestamp: Date.now(), url: window.location.href, triggerSelector: findTriggerSelector(input) });
        return;
      }
      if (tag === "input" && (inputType === "range" || inputType === "color")) {
        const input = el;
        const locatorExpr = getLocatorExpr(el);
        report({ kind: "fill", locatorExpr, selector: generateCSSSelector(el), label: extractLabel(locatorExpr, el), value: input.value, timestamp: Date.now(), url: window.location.href });
      }
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
      if (isTextInput(el) || isContentEditable(el)) {
        const initial = focusValues.get(el);
        const current = lastTypedValues.get(el);
        if (initial !== void 0 && current !== void 0 && current !== initial) {
          const fillLocator = getLocatorExpr(el);
          report({ kind: "fill", locatorExpr: fillLocator, selector: generateCSSSelector(el), label: extractLabel(fillLocator, el), value: current, timestamp: Date.now(), url: window.location.href });
          focusValues.set(el, current);
        }
      }
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
  return `(function(){ try { if (window.__ft_startAssertPick) window.__ft_startAssertPick(${JSON.stringify(assertionType)}); } catch(e){} })();`;
}
function getAssertionToolbarScript() {
  return `(function(){
  // ── Picker overlay (runs in-page; replaces the old IPC round-trip) ──────────
  window.__ft_startAssertPick = function(assertionType) {
    var existing = document.getElementById('__ft_pick_overlay');
    if (existing) existing.remove();
    var existingTip = document.getElementById('__ft_pick_tooltip');
    if (existingTip) existingTip.remove();

    if (window.__ft_setDockPicking) window.__ft_setDockPicking(true);

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

    function finish() {
      if (window.__ft_setDockPicking) window.__ft_setDockPicking(false);
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
      finish();
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
      finish();
      document.removeEventListener('keydown', escHandler, true);
      try { window.__flowtest_assert_cancel(); } catch(e) {}
    }, true);
  };

  // ── Dock UI ────────────────────────────────────────────────────────────────
  if (document.getElementById('__ft_assert_toolbar')) return;

  function install() {
    if (document.getElementById('__ft_assert_toolbar')) return;
    var root = document.body || document.documentElement;
    if (!root) return;

    var dock = document.createElement('div');
    dock.id = '__ft_assert_toolbar';
    dock.style.cssText = 'position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:2147483640;' +
      'display:flex;flex-direction:column;gap:6px;padding:8px;' +
      'background:rgba(15,23,42,0.92);border:1px solid #22c55e;border-right:none;' +
      'border-radius:8px 0 0 8px;box-shadow:-2px 0 12px rgba(0,0,0,0.35);' +
      'font-family:system-ui,-apple-system,sans-serif;';

    var title = document.createElement('div');
    title.textContent = '驗證';
    title.style.cssText = 'font-size:10px;color:#64748b;text-align:center;letter-spacing:1px;';
    dock.appendChild(title);

    var btnWrap = document.createElement('div');
    btnWrap.id = '__ft_assert_btns';
    btnWrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    dock.appendChild(btnWrap);

    var defs = [
      ['👁 可見', 'assertVisible'],
      ['T 文字', 'assertText'],
      ['= 值', 'assertValue']
    ];
    defs.forEach(function(d) {
      var b = document.createElement('button');
      b.textContent = d[0];
      b.style.cssText = 'padding:6px 12px;border-radius:6px;border:1px solid #22c55e;' +
        'cursor:pointer;background:transparent;color:#22c55e;font-size:12px;font-weight:500;white-space:nowrap;';
      b.addEventListener('mouseenter', function(){ b.style.background = 'rgba(34,197,94,0.15)'; });
      b.addEventListener('mouseleave', function(){ b.style.background = 'transparent'; });
      b.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        window.__ft_startAssertPick(d[1]);
      });
      btnWrap.appendChild(b);
    });

    var status = document.createElement('div');
    status.id = '__ft_assert_status';
    status.textContent = '選取元素中… (Esc 取消)';
    status.style.cssText = 'display:none;font-size:11px;color:#fde68a;max-width:120px;text-align:center;';
    dock.appendChild(status);

    root.appendChild(dock);
  }

  window.__ft_setDockPicking = function(picking) {
    var dock = document.getElementById('__ft_assert_toolbar');
    if (!dock) return;
    var btns = document.getElementById('__ft_assert_btns');
    var status = document.getElementById('__ft_assert_status');
    if (picking) {
      dock.style.pointerEvents = 'none';
      if (btns) btns.style.display = 'none';
      if (status) status.style.display = 'block';
    } else {
      dock.style.pointerEvents = 'auto';
      if (btns) btns.style.display = 'flex';
      if (status) status.style.display = 'none';
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})();`;
}
function getLocatorPickerScript(alternatives) {
  return `(function(){
  var alternatives = ${JSON.stringify(alternatives)};
  var existing = document.getElementById('__ft_locator_picker');
  if (existing) existing.remove();

  function extractRowNum(expr) {
    var m = expr.match(/\\.nth\\((\\d+)\\)/);
    return m ? parseInt(m[1], 10) + 1 : 1;
  }

  var selectedIndex = 0;

  var backdrop = document.createElement('div');
  backdrop.id = '__ft_locator_picker';
  backdrop.style.cssText = 'position:fixed;inset:0;z-index:2147483645;background:rgba(0,0,0,0.7);' +
    'display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;';

  var card = document.createElement('div');
  card.style.cssText = 'background:#0f172a;border:1px solid #334155;border-radius:12px;width:520px;max-width:90vw;' +
    'display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,0.6);';
  backdrop.appendChild(card);

  var header = document.createElement('div');
  header.textContent = '選擇 Locator 方式';
  header.style.cssText = 'padding:12px 16px;border-bottom:1px solid #1e293b;font-size:14px;font-weight:600;color:#e2e8f0;';
  card.appendChild(header);

  var body = document.createElement('div');
  body.style.cssText = 'padding:12px 16px;display:flex;flex-direction:column;gap:8px;';
  card.appendChild(body);

  var hint = document.createElement('div');
  hint.textContent = '點擊的元素位於 Table 中，請選擇要記錄的定位方式：';
  hint.style.cssText = 'font-size:11px;color:#64748b;margin-bottom:4px;';
  body.appendChild(hint);

  var optionEls = [];
  function refresh() {
    optionEls.forEach(function(opt, i) {
      var sel = i === selectedIndex;
      opt.row.style.border = '1px solid ' + (sel ? '#3b82f6' : '#334155');
      opt.row.style.background = sel ? '#1e3a5f' : '#1e293b';
      opt.radio.checked = sel;
    });
  }

  alternatives.forEach(function(alt, i) {
    var row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:8px;cursor:pointer;';
    row.addEventListener('click', function(){ selectedIndex = i; refresh(); });

    var radio = document.createElement('input');
    radio.type = 'radio';
    radio.style.cssText = 'margin-top:2px;accent-color:#3b82f6;flex-shrink:0;';

    var col = document.createElement('div');
    col.style.cssText = 'min-width:0;';

    var titleEl = document.createElement('div');
    titleEl.textContent = i === 0 ? 'Cell（依內容）' : ('Row（依位置，第 ' + extractRowNum(alt.expr) + ' 列）');
    titleEl.style.cssText = 'font-size:12px;color:#e2e8f0;font-weight:500;margin-bottom:3px;';

    var exprEl = document.createElement('div');
    exprEl.textContent = alt.expr;
    exprEl.style.cssText = 'font-size:11px;color:#94a3b8;font-family:monospace;word-break:break-all;';

    col.appendChild(titleEl);
    col.appendChild(exprEl);
    row.appendChild(radio);
    row.appendChild(col);
    body.appendChild(row);
    optionEls.push({ row: row, radio: radio });
  });

  var footer = document.createElement('div');
  footer.style.cssText = 'padding:10px 16px;border-top:1px solid #1e293b;display:flex;justify-content:flex-end;';
  card.appendChild(footer);

  var confirm = document.createElement('button');
  confirm.textContent = '確認';
  confirm.style.cssText = 'padding:6px 20px;border-radius:6px;border:1px solid #1d4ed8;background:#1e40af;' +
    'color:#bfdbfe;font-size:13px;font-weight:600;cursor:pointer;';
  confirm.addEventListener('click', function(e){
    e.preventDefault();
    e.stopPropagation();
    backdrop.remove();
    try { window.__flowtest_locator_resolved(selectedIndex); } catch(err) {}
  });
  footer.appendChild(confirm);

  refresh();
  (document.body || document.documentElement).appendChild(backdrop);
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
    case "upload":
      type = "upload";
      value = raw.value;
      break;
    default:
      return null;
  }
  const action = {
    id: uuid.v4(),
    type,
    selector: raw.selector,
    locatorExpr: raw.locatorExpr,
    value,
    description: generateDescription(raw.kind, raw.label, raw.value, raw.selectedText, {
      button: raw.button,
      clickCount: raw.clickCount,
      modifiers: raw.modifiers
    }),
    timestamp: raw.timestamp || Date.now(),
    url: raw.url,
    isPageNavigation: false
  };
  if (raw.button && raw.button !== "left") action.button = raw.button;
  if (raw.modifiers?.length) action.modifiers = raw.modifiers;
  if ((raw.clickCount ?? 1) >= 2) action.clickCount = raw.clickCount;
  if (raw.values?.length) action.values = raw.values;
  return action;
}
const DBLCLICK_MERGE_MS = 350;
const OPENS_PAGE_WINDOW_MS = 1e3;
function topFrameOnly(script) {
  return `(function(){ try { if (window.self !== window.top) return; } catch (e) { return; } ${script} })()`;
}
class CodegenCapture {
  context;
  onAction;
  onActionUpdated;
  onActionRemoved;
  onFilesImported;
  active = false;
  paused = false;
  lastInteraction = null;
  assertCancelCb = null;
  /** One-slot action buffer. Input clicks wait for a possible fill (no timer);
   *  plain left clicks wait DBLCLICK_MERGE_MS for a possible dblclick. */
  pendingAction = null;
  pendingLocatorPick = null;
  /** Last emitted action — a popup arriving shortly after can still be attributed to it. */
  lastEmitted = null;
  /** Page → alias. The initial page maps to '' (actions carry no pageAlias). */
  pageAliases = /* @__PURE__ */ new Map();
  nextPageOrdinal = 1;
  lastGotoUrlByPage = /* @__PURE__ */ new Map();
  /** Frame → iframe locator chain (top → innermost); invalidated on detach/navigation. */
  frameChainCache = /* @__PURE__ */ new Map();
  /** Page → CDP session, used to read real upload paths (Chromium only). */
  cdpSessions = /* @__PURE__ */ new Map();
  constructor(context, onAction, onActionUpdated, onFilesImported, onActionRemoved) {
    this.context = context;
    this.onAction = onAction;
    this.onActionUpdated = onActionUpdated ?? null;
    this.onFilesImported = onFilesImported ?? null;
    this.onActionRemoved = onActionRemoved ?? null;
  }
  async start() {
    this.active = true;
    this.lastInteraction = null;
    this.lastEmitted = null;
    this.cdpSessions.clear();
    this.pageAliases.clear();
    this.lastGotoUrlByPage.clear();
    this.frameChainCache.clear();
    this.nextPageOrdinal = 1;
    const pages = this.context.pages();
    const page = pages[0];
    if (!page) throw new Error("No page available in browser context");
    this.pageAliases.set(page, "");
    await this.context.exposeBinding("__flowtest_assert_report", async ({ page: srcPage, frame }, data) => {
      const srcAlias = this.pageAliases.get(srcPage);
      const framePath = await this.frameLocatorChain(frame, srcPage);
      const action = {
        id: uuid.v4(),
        type: data.type,
        selector: data.selector,
        locatorExpr: data.locatorExpr,
        value: data.value,
        description: generateAssertDescription(data),
        timestamp: Date.now(),
        url: data.url,
        isPageNavigation: false,
        ...srcAlias ? { pageAlias: srcAlias } : {},
        ...framePath.length ? { framePath } : {}
      };
      this.emitAction(action);
    });
    await this.context.exposeBinding("__flowtest_assert_cancel", () => {
      this.assertCancelCb?.();
    });
    await this.context.exposeBinding("__flowtest_locator_resolved", (_source, index) => {
      const pending = this.pendingLocatorPick;
      this.pendingLocatorPick = null;
      this.resume();
      if (!pending) return;
      const chosen = pending.alternatives[index] ?? pending.alternatives[0];
      const finalAction = {
        ...pending.action,
        locatorExpr: chosen.expr,
        description: index === 0 ? pending.action.description : deriveRowDescription(chosen.expr)
      };
      this.emitAction(finalAction);
    });
    await this.context.exposeBinding("__flowtest_report", async ({ page: srcPage, frame }, raw) => {
      const framePath = await this.frameLocatorChain(frame, srcPage);
      const storedFiles = raw.kind === "upload" ? await this.importUploadedFiles(srcPage) : [];
      this.handleRawEvent(srcPage, raw, framePath.length ? framePath : void 0, storedFiles);
    });
    const initScript = getBrowserInitScript();
    if (initScript) await this.context.addInitScript(initScript);
    const captureScript = getDOMCaptureScript();
    await this.context.addInitScript(captureScript);
    const cursorScript = topFrameOnly(getCursorHighlightScript());
    await this.context.addInitScript(cursorScript);
    const toolbarScript = topFrameOnly(getAssertionToolbarScript());
    await this.context.addInitScript(toolbarScript);
    if (initScript) await page.evaluate(initScript).catch(() => {
    });
    await page.evaluate(captureScript).catch(() => {
    });
    await page.evaluate(cursorScript).catch(() => {
    });
    await page.evaluate(toolbarScript).catch(() => {
    });
    this.attachNavListener(page);
    this.context.on("page", (newPage) => {
      if (!this.active) return;
      const alias = `page${this.nextPageOrdinal++}`;
      this.pageAliases.set(newPage, alias);
      this.attachNavListener(newPage);
      this.attributeOpensPage(alias);
    });
  }
  /**
   * Read the real paths of the files the user just picked, and copy them into fixtures/.
   *
   * The chooser is deliberately NOT intercepted: Chromium opens its own dialog, on the
   * browser window the user is already working in. The page still only sees File.name,
   * but the browser process knows the backing path and CDP's DOM.getFileInfo hands it
   * over. The capture script parks the input on the top window as __ft_lastUploadInput
   * (init scripts run in the main world, so Runtime.evaluate can see it).
   *
   * Returns [] on any failure — the node then keeps bare file names and the canvas
   * flags it, which is exactly the pre-CDP behaviour.
   */
  async importUploadedFiles(page) {
    if (!this.onFilesImported) return [];
    try {
      const session = await this.cdpSessionFor(page);
      const count = await session.send("Runtime.evaluate", {
        expression: "window.__ft_lastUploadInput ? window.__ft_lastUploadInput.files.length : 0",
        returnByValue: true
      });
      const n = count.result.value ?? 0;
      if (!n) return [];
      const absPaths = [];
      for (let i = 0; i < n; i++) {
        const handle = await session.send("Runtime.evaluate", {
          expression: `window.__ft_lastUploadInput.files[${i}]`
        });
        const objectId = handle.result.objectId;
        if (!objectId) continue;
        try {
          const info = await session.send("DOM.getFileInfo", { objectId });
          if (info.path) absPaths.push(info.path);
        } finally {
          await session.send("Runtime.releaseObject", { objectId }).catch(() => {
          });
        }
      }
      if (!absPaths.length) return [];
      return await this.onFilesImported(absPaths);
    } catch {
      return [];
    }
  }
  async cdpSessionFor(page) {
    const existing = this.cdpSessions.get(page);
    if (existing) return existing;
    const session = await this.context.newCDPSession(page);
    this.cdpSessions.set(page, session);
    page.once("close", () => this.cdpSessions.delete(page));
    return session;
  }
  /** Mirrors Playwright's RecorderSignalProcessor: navigation within NAV_SUPPRESSION_MS
   *  after a click/press/fill is a redirect side-effect and must NOT generate a goto node.
   *  The 50 ms delay lets pending IPC round-trips (from browser → Node.js) settle first,
   *  so that SPA navigations (which fire framenavigated before the IPC arrives) are also
   *  correctly suppressed. A popup's first navigation is likewise suppressed because the
   *  triggering click sits within the suppression window. */
  attachNavListener(page) {
    page.on("framedetached", (frame) => this.frameChainCache.delete(frame));
    page.on("framenavigated", (frame) => {
      this.frameChainCache.delete(frame);
      if (!this.active || frame !== page.mainFrame()) return;
      const url = frame.url();
      if (!url || url === "about:blank" || url === this.lastGotoUrlByPage.get(page)) return;
      this.lastGotoUrlByPage.set(page, url);
      const navigationTime = Date.now();
      setTimeout(() => {
        if (!this.active) return;
        if (shouldSuppressNav(navigationTime, this.lastInteraction)) return;
        const alias = this.pageAliases.get(page);
        this.emitAction({
          id: uuid.v4(),
          type: "goto",
          selector: "",
          value: url,
          description: `導航到 ${url}`,
          timestamp: navigationTime,
          url,
          isPageNavigation: true,
          ...alias ? { pageAlias: alias } : {}
        });
      }, 50);
    });
  }
  /** Attribute a freshly opened page to the click/press that triggered it:
   *  stamp the buffered action if one is pending, otherwise retro-patch the
   *  last emitted action via ACTION_UPDATED (renderer updates the node). */
  attributeOpensPage(alias) {
    if (this.pendingAction && ["click", "press"].includes(this.pendingAction.action.type)) {
      this.pendingAction.action.opensPage = alias;
      return;
    }
    if (this.lastEmitted && ["click", "press"].includes(this.lastEmitted.action.type) && Date.now() - this.lastEmitted.time < OPENS_PAGE_WINDOW_MS) {
      this.onActionUpdated?.({ actionId: this.lastEmitted.action.id, updates: { opensPage: alias } });
    }
  }
  /** Build the iframe locator chain (top → innermost) for a frame, using the same
   *  __ftGetLocator quality as element locators. Cached per Frame; falls back to
   *  iframe[name=…]/iframe[src=…] when the frame element can't be resolved. */
  async frameLocatorChain(frame, page) {
    if (frame === page.mainFrame()) return [];
    const cached2 = this.frameChainCache.get(frame);
    if (cached2) return cached2;
    const chain = [];
    let cur = frame;
    while (cur && cur !== page.mainFrame()) {
      const parent = cur.parentFrame();
      if (!parent) break;
      let expr = null;
      try {
        const handle = await cur.frameElement();
        expr = await parent.evaluate(
          (el) => {
            try {
              return window.__ftGetLocator?.(el) ?? null;
            } catch {
              return null;
            }
          },
          handle
        );
        await handle.dispose();
      } catch {
      }
      if (!expr) {
        const name = cur.name();
        expr = name ? `locator('iframe[name="${name.replace(/"/g, '\\"')}"]')` : `locator('iframe[src="${cur.url().replace(/"/g, '\\"')}"]')`;
      }
      chain.unshift(expr);
      cur = parent;
    }
    this.frameChainCache.set(frame, chain);
    return chain;
  }
  handleRawEvent(srcPage, raw, framePath, storedFiles = []) {
    if (!this.active || this.paused) return;
    const action = buildAction(raw);
    if (!action) return;
    const alias = this.pageAliases.get(srcPage);
    if (alias) action.pageAlias = alias;
    if (framePath?.length) action.framePath = framePath;
    if (raw.kind === "upload") {
      if (storedFiles.length) {
        action.filePaths = storedFiles;
        action.value = storedFiles.join(", ");
        action.description = `上傳檔案「${storedFiles.map((p) => path.basename(p)).join("、")}」`;
      }
      if (raw.triggerSelector) this.dropTriggerClick(raw.triggerSelector);
    }
    if (action.type === "click" && (action.clickCount ?? 1) >= 2 && this.pendingAction?.action.type === "click" && this.pendingAction.action.selector === action.selector) {
      if (this.pendingAction.action.opensPage) action.opensPage = this.pendingAction.action.opensPage;
      this.discardPendingAction();
    }
    if (raw.isInputClick) {
      this.setPendingAction(action, true);
      this.lastInteraction = { time: Date.now(), type: action.type };
      return;
    }
    if (action.type === "fill" && this.pendingAction?.isInputClick && this.pendingAction.action.selector === action.selector) {
      this.discardPendingAction();
    } else {
      this.flushPendingAction();
    }
    this.lastInteraction = { time: Date.now(), type: action.type };
    if (raw.alternativeLocators?.length) {
      this.showLocatorPicker(action, raw.alternativeLocators, srcPage);
      return;
    }
    if (action.type === "click" && (action.clickCount ?? 1) === 1 && !action.button) {
      this.setPendingAction(action, false);
      return;
    }
    this.emitAction(action);
  }
  emitAction(action) {
    this.lastEmitted = { action, time: Date.now() };
    this.onAction(action);
  }
  /** Un-record the click that opened the file chooser. Usually it is still in the
   *  dblclick buffer; if the user lingered in the dialog it has already reached the
   *  canvas, so ask the renderer to delete that node (it is still the recording head). */
  dropTriggerClick(triggerSelector) {
    if (this.pendingAction?.action.type === "click" && this.pendingAction.action.selector === triggerSelector) {
      this.discardPendingAction();
      return;
    }
    if (this.lastEmitted?.action.type === "click" && this.lastEmitted.action.selector === triggerSelector) {
      const { action } = this.lastEmitted;
      this.lastEmitted = null;
      this.onActionRemoved?.(action.id);
    }
  }
  setPendingAction(action, isInputClick) {
    this.flushPendingAction();
    const timer = isInputClick ? null : setTimeout(() => this.flushPendingAction(), DBLCLICK_MERGE_MS);
    this.pendingAction = { action, isInputClick, timer };
  }
  flushPendingAction() {
    if (!this.pendingAction) return;
    if (this.pendingAction.timer) clearTimeout(this.pendingAction.timer);
    const { action } = this.pendingAction;
    this.pendingAction = null;
    this.emitAction(action);
  }
  discardPendingAction() {
    if (!this.pendingAction) return;
    if (this.pendingAction.timer) clearTimeout(this.pendingAction.timer);
    this.pendingAction = null;
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  async stop() {
    if (this.pendingAction?.isInputClick) this.discardPendingAction();
    else this.flushPendingAction();
    this.active = false;
    this.paused = false;
    this.pendingLocatorPick = null;
    this.cdpSessions.clear();
    for (const page of this.context.pages()) {
      await page.evaluate(() => {
        ["__ft_assert_toolbar", "__ft_pick_overlay", "__ft_pick_tooltip", "__ft_locator_picker"].forEach(
          (id) => {
            document.getElementById(id)?.remove();
          }
        );
      }).catch(() => {
      });
    }
    this.pageAliases.clear();
    this.lastGotoUrlByPage.clear();
    this.frameChainCache.clear();
  }
  // Shows the in-browser "選擇 Locator 方式" dialog and pauses recording until the
  // user confirms (resolved via the exposed __flowtest_locator_resolved binding).
  showLocatorPicker(action, alternatives, page) {
    this.pendingLocatorPick = { action, alternatives, page };
    this.pause();
    page.evaluate(getLocatorPickerScript(alternatives)).catch(() => {
    });
  }
  // Backward-compat entry point. The assertion dock now drives picking in-page;
  // this re-triggers the same in-page overlay for the legacy IPC path.
  async startAssertionPick(assertionType, onCancel) {
    const page = this.context.pages()[0];
    if (!page) return;
    this.assertCancelCb = onCancel;
    await page.evaluate(getAssertionPickScript(assertionType)).catch(() => {
    });
  }
}
function deriveRowDescription(expr) {
  const m = expr.match(/\.nth\((\d+)\)/);
  const rowNum = m ? parseInt(m[1], 10) + 1 : 1;
  return `點擊第 ${rowNum} 列 (row)`;
}
class Recorder {
  page;
  capture;
  recording = false;
  constructor(page, onAction, onActionUpdated, onFilesImported, onActionRemoved) {
    this.page = page;
    this.capture = new CodegenCapture(page.context(), onAction, onActionUpdated, onFilesImported, onActionRemoved);
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
  pause() {
    this.capture.pause();
  }
  resume() {
    this.capture.resume();
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
const MAX_RESOLVE_PASSES = 10;
function resolveValue(value, profileVars, envVars) {
  let out = value;
  for (let i = 0; i < MAX_RESOLVE_PASSES && /\{\{\w+\}\}/.test(out); i++) {
    const prev = out;
    out = out.replace(/\{\{(\w+)\}\}/g, (match, name) => {
      if (profileVars && name in profileVars) return profileVars[name];
      if (envVars && name in envVars) return envVars[name];
      if (name === "randomText") return generateRandomText();
      if (name === "randomNumber") return generateRandomNumber();
      if (name === "randomOneText") return generateRandomOneLetter();
      if (name === "randomOneNumber") return generateRandomOneDigit();
      if (name === "timestamp") return generateTimestamp();
      return match;
    });
    if (out === prev) break;
  }
  return out;
}
function resolveValueWithSession(value, sessionVars, profileVars, envVars) {
  let out = value;
  for (let i = 0; i < MAX_RESOLVE_PASSES && /\{\{\w+\}\}/.test(out); i++) {
    const prev = out;
    out = out.replace(/\{\{(\w+)\}\}/g, (match, name) => {
      if (sessionVars.has(name)) return sessionVars.get(name);
      if (profileVars && name in profileVars) return profileVars[name];
      if (envVars && name in envVars) return envVars[name];
      if (name === "randomText") return generateRandomText();
      if (name === "randomNumber") return generateRandomNumber();
      if (name === "randomOneText") return generateRandomOneLetter();
      if (name === "randomOneNumber") return generateRandomOneDigit();
      if (name === "timestamp") return generateTimestamp();
      return match;
    });
    if (out === prev) break;
  }
  return out;
}
function hasVariables(value) {
  return /\{\{.+?\}\}/.test(value);
}
const PROFILE_VAR_PREFIX = "_ftProf_";
const ENV_VAR_PREFIX = "_ftEnv_";
function varToCodeRef(name, scope) {
  if (scope.sessionVars?.has(name)) return name;
  if (scope.profileVars?.has(name)) return `${PROFILE_VAR_PREFIX}${name}`;
  if (scope.envVars?.has(name)) return `${ENV_VAR_PREFIX}${name}`;
  if (name === "randomText") return "_ftRandomText()";
  if (name === "randomNumber") return "_ftRandomNumber()";
  if (name === "randomOneText") return "_ftRandomOneLetter()";
  if (name === "randomOneNumber") return "_ftRandomOneDigit()";
  if (name === "timestamp") return "_ftTimestamp()";
  return null;
}
function toSingleQuoted(value) {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
function escapeTemplateBody(value) {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}
function valueToCodeExpr(value, scope = {}) {
  if (!hasVariables(value)) return toSingleQuoted(value);
  const inner = escapeTemplateBody(value).replace(/\{\{(\w+)\}\}/g, (m, name) => {
    const ref = varToCodeRef(name, scope);
    return ref ? `\${${ref}}` : m;
  });
  return "`" + inner + "`";
}
function sessionAwareValueToCodeExpr(value, sessionVars, scope = {}) {
  const fullScope = { ...scope, sessionVars };
  if (!hasVariables(value)) return toSingleQuoted(value);
  const singleVar = value.match(/^\{\{(\w+)\}\}$/);
  if (singleVar && sessionVars.has(singleVar[1])) return singleVar[1];
  return valueToCodeExpr(value, fullScope);
}
function locatorExprToCode(expr, scope = {}) {
  const rewriteQuoted = expr.replace(
    /'([^']*\{\{[^}]+\}\}[^']*)'|"([^"]*\{\{[^}]+\}\}[^"]*)"/g,
    (match, sq, dq) => {
      const inner = sq ?? dq;
      const singleVar = inner.match(/^\{\{(\w+)\}\}$/);
      if (singleVar) return varToCodeRef(singleVar[1], scope) ?? match;
      const templateInner = escapeTemplateBody(inner).replace(/\{\{(\w+)\}\}/g, (m, name) => {
        const ref = varToCodeRef(name, scope);
        return ref ? `\${${ref}}` : m;
      });
      return "`" + templateInner + "`";
    }
  );
  return rewriteQuoted.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    return varToCodeRef(name, scope) ?? toSingleQuoted(match);
  });
}
function emitVarDecls(vars, prefix) {
  return Object.entries(vars).filter(([key]) => /^\w+$/.test(key)).map(([key, value]) => `const ${prefix}${key} = ${JSON.stringify(value)};`).join("\n");
}
function emitProfileVarDecls(profileVars) {
  return emitVarDecls(profileVars, PROFILE_VAR_PREFIX);
}
function emitEnvVarDecls(envVars) {
  return emitVarDecls(envVars, ENV_VAR_PREFIX);
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
const RECENT_LIMIT = 8;
const MARKER = ".flowtest.json";
const ARTIFACT_DIR = ".flowtest";
let workspaceRoot = null;
let recent = [];
let settingsLoaded = false;
function settingsPath() {
  return path.join(electron.app.getPath("userData"), "settings.json");
}
function hasWorkspace() {
  return workspaceRoot !== null;
}
function getWorkspaceRoot() {
  if (workspaceRoot === null) {
    throw new Error("[FlowTest] No workspace is open — 請先開啟資料夾");
  }
  return workspaceRoot;
}
function dataRoot() {
  return getWorkspaceRoot();
}
function getRecentWorkspaces() {
  return [...recent];
}
function configPath(root = getWorkspaceRoot()) {
  return path.join(root, "playwright.config.ts");
}
async function loadSettings() {
  if (settingsLoaded) return;
  settingsLoaded = true;
  try {
    const raw = await fs.promises.readFile(settingsPath(), "utf-8");
    const data = JSON.parse(raw);
    recent = Array.isArray(data.recentWorkspaces) ? data.recentWorkspaces : [];
    if (data.workspaceRoot && await isDirectory(data.workspaceRoot)) {
      try {
        await scaffold(data.workspaceRoot);
        workspaceRoot = data.workspaceRoot;
      } catch {
      }
    } else if (data.workspaceRoot) {
      recent = recent.filter((p) => p !== data.workspaceRoot);
      await persist();
    }
  } catch {
  }
}
async function persist() {
  const payload = { workspaceRoot, recentWorkspaces: recent };
  await fs.promises.mkdir(electron.app.getPath("userData"), { recursive: true });
  await fs.promises.writeFile(settingsPath(), JSON.stringify(payload, null, 2), "utf-8");
}
async function removeRecentWorkspace(dir) {
  recent = recent.filter((p) => p !== dir);
  await persist();
}
async function isDirectory(p) {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
function warnAbout(dir) {
  const abs = path.resolve(dir);
  if (abs === path.parse(abs).root) return "這是磁碟根目錄，工作區檔案會散落在整個磁碟中。";
  if (abs === path.resolve(os.homedir())) return "這是你的使用者家目錄，建議改選一個專屬的子資料夾。";
  return null;
}
async function setWorkspaceRoot(dir) {
  const abs = path.resolve(dir);
  if (!await isDirectory(abs)) throw new Error(`資料夾不存在：${abs}`);
  try {
    await scaffold(abs);
  } catch (err) {
    throw new Error(`無法寫入資料夾：${abs}
${String(err)}`);
  }
  workspaceRoot = abs;
  recent = [abs, ...recent.filter((p) => p !== abs)].slice(0, RECENT_LIMIT);
  await persist();
  return abs;
}
async function writeIfMissing(path2, content) {
  try {
    await fs.promises.access(path2);
  } catch {
    await fs.promises.writeFile(path2, content, "utf-8");
  }
}
async function scaffold(root) {
  for (const dir of ["flows", "projects", "fixtures", "exports", ARTIFACT_DIR]) {
    await fs.promises.mkdir(path.join(root, dir), { recursive: true });
  }
  await writeIfMissing(path.join(root, "exports", ".gitignore"), "*\n!.gitignore\n");
  await writeIfMissing(path.join(root, ARTIFACT_DIR, ".gitignore"), "*\n!.gitignore\n");
  await writeIfMissing(configPath(root), PLAYWRIGHT_CONFIG);
  await writeIfMissing(path.join(root, MARKER), JSON.stringify({ version: 1 }, null, 2) + "\n");
}
const PLAYWRIGHT_CONFIG = `import { defineConfig } from '@playwright/test';

// Generated by FlowTest. Runs are always pointed here explicitly with --config,
// so this file is never shadowed by a playwright.config.ts further up the tree.
export default defineConfig({
  testDir: './exports',
  outputDir: './.flowtest/test-results',
  timeout: 30000,
  reporter: [['html', { outputFolder: './.flowtest/playwright-report', open: 'never' }]],
  use: {
    headless: false,
    viewport: null,
    launchOptions: {
      args: ['--start-maximized'],
    },
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
`;
function flowsDir() {
  return path.join(getWorkspaceRoot(), "flows");
}
class FlowStorage {
  static async ensureDir() {
    await fs.promises.mkdir(flowsDir(), { recursive: true });
  }
  static filePath(flowId) {
    return path.join(flowsDir(), `${flowId}.json`);
  }
  /**
   * `touch: false` writes without bumping updatedAt. Used by the debounced save
   * behind node dragging: repositioning is not a content change, and stamping a
   * new timestamp on every drag makes the flow's JSON conflict in git for what
   * is really just a cosmetic move.
   */
  static async save(flow, opts) {
    await FlowStorage.ensureDir();
    if (opts?.touch !== false) flow.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
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
    const summaries = [];
    const usage = /* @__PURE__ */ new Map();
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.promises.readFile(path.join(flowsDir(), file), "utf-8");
        const flow = JSON.parse(raw);
        summaries.push({
          id: flow.id,
          name: flow.name,
          description: flow.description,
          updatedAt: flow.updatedAt,
          projectId: flow.projectId
        });
        for (const node of flow.nodes ?? []) {
          if (isCallFlowAction(node.action)) {
            const subId = node.action.subFlowId;
            usage.set(subId, (usage.get(subId) ?? 0) + 1);
          }
        }
      } catch {
      }
    }
    return summaries.map((s) => ({ ...s, refCount: usage.get(s.id) ?? 0 })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  static async delete(flowId) {
    try {
      await fs.promises.unlink(FlowStorage.filePath(flowId));
    } catch {
    }
  }
}
function fixturesDir() {
  return path.join(dataRoot(), "fixtures");
}
const FIXTURES_PREFIX = "fixtures";
async function sha256(file) {
  return crypto.createHash("sha256").update(await fs.promises.readFile(file)).digest("hex");
}
class FixtureStorage {
  /**
   * Copy a picked file into fixtures/ and return both the stored (relative) path
   * written into the Action and the absolute path on disk.
   *
   * Same name + same content → reuse the existing copy. Same name, different
   * content → insert a short content hash before the extension.
   */
  static async importFile(sourcePath) {
    await fs.promises.mkdir(fixturesDir(), { recursive: true });
    const name = path.basename(sourcePath);
    let target = path.join(fixturesDir(), name);
    try {
      await fs.promises.access(target);
      if (await sha256(target) !== await sha256(sourcePath)) {
        const ext = path.extname(name);
        const stem = ext ? name.slice(0, -ext.length) : name;
        const hash = (await sha256(sourcePath)).slice(0, 6);
        target = path.join(fixturesDir(), `${stem}.${hash}${ext}`);
        await fs.promises.copyFile(sourcePath, target);
      }
    } catch {
      await fs.promises.copyFile(sourcePath, target);
    }
    return { stored: `${FIXTURES_PREFIX}/${path.basename(target)}`, abs: target };
  }
  /**
   * Resolve a stored fixture path for use with setInputFiles.
   * Absolute paths (hand-typed, or legacy nodes) pass through untouched; relative
   * paths resolve against the data root — the main process cwd is not the data root
   * once packaged, so this must never be left to the cwd.
   */
  static toAbsolute(stored) {
    return path.isAbsolute(stored) ? stored : path.resolve(dataRoot(), stored);
  }
  /**
   * Make a user-supplied path portable before it is stored on an Action.
   *
   * An absolute path pins the flow to one machine, which defeats sharing the
   * workspace through git. Anything already inside the workspace just loses its
   * prefix — that also means a flow can reference the surrounding repo's own
   * test data (testdata/foo.png) without a redundant copy under fixtures/.
   * Anything outside is copied in, since nothing else would travel with the repo.
   *
   * Bare filenames (drag & drop uploads, which never expose a path) are left
   * alone for the UI to flag.
   */
  static async normalizeStoredPath(input) {
    const value = input.trim();
    if (!value || !path.isAbsolute(value)) return value;
    const rel = path.relative(dataRoot(), value);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join("/");
    }
    try {
      return (await FixtureStorage.importFile(value)).stored;
    } catch {
      return value;
    }
  }
}
const AsyncFunction = Object.getPrototypeOf(async () => {
}).constructor;
let _expectFn = null;
function getExpect() {
  if (_expectFn !== null) return _expectFn;
  try {
    const req = module$1.createRequire(require("url").pathToFileURL(__filename).href);
    _expectFn = req("@playwright/test").expect;
  } catch {
    _expectFn = void 0;
  }
  return _expectFn;
}
const swallowFileChooser = () => {
};
class Replayer {
  page;
  sessionVars = /* @__PURE__ */ new Map();
  baseOrigin;
  profileVars;
  activeProfileId;
  activeEnvironmentId;
  /** Active project's environment variables (flattened for the active environment). */
  envVars;
  /** Active project ID — env-var references only resolve for sub-flows in this project. */
  activeProjectId;
  /** pageAlias → Page for popups opened during replay (shared with nested Replayers). */
  pages;
  /** Pages this replay muted the file chooser on, released when the replay ends. */
  suppressedPages = /* @__PURE__ */ new Set();
  constructor(page, baseURL = "", profileVars, activeProfileId, activeEnvironmentId, envVars, activeProjectId, sharedPages) {
    this.page = page;
    this.profileVars = profileVars ?? {};
    this.activeProfileId = activeProfileId;
    this.activeEnvironmentId = activeEnvironmentId;
    this.envVars = envVars ?? {};
    this.activeProjectId = activeProjectId;
    this.pages = sharedPages ?? /* @__PURE__ */ new Map();
    this.baseOrigin = (() => {
      try {
        return new URL(baseURL).origin;
      } catch {
        return "";
      }
    })();
  }
  /** Resolve the page an action targets. Absent alias = the initial page. */
  pageFor(action) {
    if (!action.pageAlias) return this.page;
    const p = this.pages.get(action.pageAlias);
    if (!p || p.isClosed()) {
      throw new Error(`頁面 "${action.pageAlias}" 尚未開啟 — 觸發開新頁的動作可能未執行或失敗`);
    }
    return p;
  }
  async replayToNode(nodes, targetNodeId, onNodeStart, onNodeComplete, speed = 500) {
    this.sessionVars.clear();
    const cursorScript = getCursorHighlightScript();
    await this.page.addInitScript(cursorScript);
    await this.page.evaluate(cursorScript).catch(() => {
    });
    this.suppressFileChooser(this.page);
    const path2 = this.findPath(nodes, targetNodeId);
    try {
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
    } finally {
      this.releaseFileChooserSuppression();
    }
  }
  /** Swallow file choosers for the duration of this replay. Only ever removes its own
   *  listener, so a nested call-flow replayer can't lift the outer replay's suppression. */
  suppressFileChooser(page) {
    if (this.suppressedPages.has(page)) return;
    this.suppressedPages.add(page);
    page.on("filechooser", swallowFileChooser);
  }
  releaseFileChooserSuppression() {
    for (const page of this.suppressedPages) {
      if (!page.isClosed()) page.off("filechooser", swallowFileChooser);
    }
    this.suppressedPages.clear();
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
    const subFlowEnvVars = this.activeProjectId && (subFlow.projectId ?? DEFAULT_PROJECT_ID) === this.activeProjectId ? this.envVars : {};
    const resolveVars = (vars) => Object.fromEntries(
      vars.map((v) => {
        const raw = (this.activeEnvironmentId && v.envValues?.[this.activeEnvironmentId]) ?? v.value;
        return [v.key, resolveValue(raw, void 0, subFlowEnvVars)];
      })
    );
    let subProfileVars = {};
    if (resolvedSubProfileId) {
      const profile = subFlow.profiles?.find((p) => p.id === resolvedSubProfileId);
      if (profile) {
        subProfileVars = resolveVars(profile.vars);
      }
    } else if (!resolvedSubProfileId && subFlow.profiles && subFlow.profiles.length > 0) {
      const firstProfile = subFlow.profiles[0];
      subProfileVars = resolveVars(firstProfile.vars);
      resolvedSubProfileId = firstProfile.id;
    }
    const nested = new Replayer(this.page, subFlow.baseURL, subProfileVars, resolvedSubProfileId ?? void 0, this.activeEnvironmentId, subFlowEnvVars, this.activeProjectId, this.pages);
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
  /** Fold the action's framePath into a scope: page → frameLocator chain.
   *  Each entry is a locator expression for an iframe element; `.contentFrame()`
   *  turns it into the scope for the next hop (never baked into locatorExpr). */
  scopeFor(action) {
    let scope = this.pageFor(action);
    for (const frameExpr of action.framePath ?? []) {
      const resolved = resolveValueWithSession(frameExpr, this.sessionVars, this.profileVars, this.envVars);
      const fn = new Function("s", `return s.${resolved}`);
      scope = fn(scope).contentFrame();
    }
    return scope;
  }
  /**
   * Resolve a Playwright Locator from an Action.
   * Prefers locatorExpr (Codegen-quality) over the fallback CSS selector.
   */
  getLocator(action) {
    const scope = this.scopeFor(action);
    if (action.locatorExpr) {
      try {
        const resolved = resolveValueWithSession(action.locatorExpr, this.sessionVars, this.profileVars, this.envVars);
        const fn = new Function("page", `return page.${resolved}`);
        return fn(scope);
      } catch {
      }
    }
    return scope.locator(action.selector);
  }
  /**
   * Resolve the actual <input type=file> for an upload action.
   * Recorded locators are often not usable as-is: these widgets hide the input behind a
   * styled trigger and frequently reuse one id for both, and Chromium reports the input
   * itself as role=button with the trigger's label. Narrow to the one element
   * setInputFiles can accept, rather than failing on a strict-mode violation.
   */
  async resolveFileInput(action) {
    const scope = this.scopeFor(action);
    const fileInputs = scope.locator('input[type="file"]');
    const base = this.getLocator(action);
    const candidates = [
      base.and(fileInputs),
      // same element, but only if it is a file input
      base.locator('input[type="file"]'),
      // recorded locator was a wrapper / label
      base,
      // recorded locator is already unambiguous
      fileInputs
      // page has exactly one file input
    ];
    for (const c of candidates) {
      if (await c.count() === 1) return c;
    }
    throw new Error("找不到唯一的檔案上傳欄位 input[type=file] — 請在屬性面板修正此節點的 Locator");
  }
  substituteOrigin(url) {
    const domainOverride = (this.envVars[DOMAIN_ENV_KEY] ?? "").replace(/\/+$/, "");
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
    const val = action.value != null ? resolveValueWithSession(action.value, this.sessionVars, this.profileVars, this.envVars) : void 0;
    const popupPromise = action.opensPage ? this.pageFor(action).context().waitForEvent("page", { timeout: 15e3 }) : null;
    switch (action.type) {
      case "goto":
        await this.pageFor(action).goto(this.substituteOrigin(val));
        break;
      case "click": {
        const opts = {};
        if (action.button && action.button !== "left") opts.button = action.button;
        if (action.modifiers?.length) opts.modifiers = action.modifiers;
        if ((action.clickCount ?? 1) >= 2) await this.getLocator(action).dblclick(opts);
        else await this.getLocator(action).click(opts);
        break;
      }
      case "fill":
        await this.getLocator(action).fill(val ?? "");
        break;
      case "selectOption":
        if (action.values?.length) {
          await this.getLocator(action).selectOption(
            action.values.map((v) => resolveValueWithSession(v, this.sessionVars, this.profileVars, this.envVars))
          );
        } else {
          await this.getLocator(action).selectOption(val ?? "");
        }
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
          await this.pageFor(action).keyboard.press(val ?? "");
        }
        break;
      case "upload": {
        const raw = action.filePaths?.length ? action.filePaths.map((p) => resolveValueWithSession(p, this.sessionVars, this.profileVars, this.envVars)) : (val ?? "").split(",");
        const files = raw.map((s) => s.trim()).filter(Boolean).map((s) => FixtureStorage.toAbsolute(s));
        if (!files.length) throw new Error("上傳節點沒有檔案路徑 — 請在屬性面板選擇檔案");
        for (const f of files) {
          if (!fs.existsSync(f)) throw new Error(`找不到檔案: ${f}`);
        }
        await (await this.resolveFileInput(action)).setInputFiles(files);
        break;
      }
      case "wait":
        await this.getLocator(action).waitFor({ state: "visible" });
        break;
      case "code": {
        const fn = new AsyncFunction("page", "expect", "vars", action.code ?? "");
        await fn(this.pageFor(action), getExpect(), this.buildCodeVars());
        break;
      }
    }
    if (popupPromise && action.opensPage) {
      const newPage = await popupPromise;
      await newPage.waitForLoadState("domcontentloaded").catch(() => {
      });
      this.suppressFileChooser(newPage);
      this.pages.set(action.opensPage, newPage);
    }
    if (action.captureAs && val != null) {
      this.sessionVars.set(action.captureAs, val);
    }
  }
  /** Build the `vars` object injected into a code node.
   *  Priority (highest last so it wins): env vars < profile vars < session vars.
   *  Built-in random/timestamp variables are exposed as functions (fresh value per call). */
  buildCodeVars() {
    const vars = { ...this.envVars, ...this.profileVars };
    for (const [k, v] of this.sessionVars) vars[k] = v;
    for (const name of ["randomText", "randomNumber", "randomOneText", "randomOneNumber", "timestamp"]) {
      if (!(name in vars)) vars[name] = () => resolveValue(`{{${name}}}`);
    }
    return vars;
  }
  async executeAssertion(action) {
    const assertion = action.assertion;
    if (!assertion) return;
    const TIMEOUT = 1e4;
    const page = this.pageFor(action);
    const scope = this.scopeFor(action);
    switch (assertion.type) {
      case "text": {
        await scope.locator(assertion.target).waitFor({ state: "visible", timeout: TIMEOUT });
        const text = await scope.locator(assertion.target).textContent({ timeout: TIMEOUT });
        if (!text?.includes(assertion.expected)) {
          throw new Error(
            `Assertion failed: expected text "${assertion.expected}" in "${assertion.target}", got "${text}"`
          );
        }
        break;
      }
      case "visible": {
        const visible = await scope.locator(assertion.target).isVisible();
        if (!visible) {
          throw new Error(`Assertion failed: "${assertion.target}" is not visible`);
        }
        break;
      }
      case "url": {
        await page.waitForURL(new RegExp(assertion.expected), { timeout: TIMEOUT });
        break;
      }
      case "count": {
        const expected = parseInt(assertion.expected, 10);
        if (action.framePath?.length) {
          const deadline = Date.now() + TIMEOUT;
          for (; ; ) {
            const count = await scope.locator(assertion.target).count();
            if (count === expected) break;
            if (Date.now() > deadline) {
              throw new Error(`Assertion failed: expected ${expected} of "${assertion.target}", got ${count}`);
            }
            await new Promise((res) => setTimeout(res, 200));
          }
          break;
        }
        await page.waitForFunction(
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
function projectsDir() {
  return path.join(getWorkspaceRoot(), "projects");
}
class ProjectStorage {
  static async ensureDir() {
    await fs.promises.mkdir(projectsDir(), { recursive: true });
  }
  static filePath(projectId) {
    return path.join(projectsDir(), `${projectId}.json`);
  }
  /** Materialize the reserved default project ("未分類") on disk if it doesn't exist yet,
   *  seeded with a DEV environment and a fixed `domain` env var. Writing it to a file (rather
   *  than returning a synthetic object) gives its environment a stable id across loads. */
  static async ensureDefault() {
    await ProjectStorage.ensureDir();
    try {
      await fs.promises.access(ProjectStorage.filePath(DEFAULT_PROJECT_ID));
      return;
    } catch {
    }
    const envId = crypto.randomUUID();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const project = {
      id: DEFAULT_PROJECT_ID,
      name: DEFAULT_PROJECT_NAME,
      environments: [{ id: envId, name: DEFAULT_ENV_NAME }],
      envVars: [{ key: DOMAIN_ENV_KEY, values: { [envId]: DEFAULT_DOMAIN } }],
      createdAt: now,
      updatedAt: now
    };
    await fs.promises.writeFile(ProjectStorage.filePath(DEFAULT_PROJECT_ID), JSON.stringify(project, null, 2), "utf-8");
  }
  static async save(project) {
    await ProjectStorage.ensureDir();
    project.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    await fs.promises.writeFile(ProjectStorage.filePath(project.id), JSON.stringify(project, null, 2), "utf-8");
  }
  static async load(projectId) {
    if (projectId === DEFAULT_PROJECT_ID) {
      await ProjectStorage.ensureDefault();
    }
    try {
      const raw = await fs.promises.readFile(ProjectStorage.filePath(projectId), "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  static async list() {
    await ProjectStorage.ensureDefault();
    const files = await fs.promises.readdir(projectsDir());
    const results = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.promises.readFile(path.join(projectsDir(), file), "utf-8");
        const project = JSON.parse(raw);
        results.push({ id: project.id, name: project.name, updatedAt: project.updatedAt });
      } catch {
      }
    }
    results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return results;
  }
  static async delete(projectId) {
    if (projectId === DEFAULT_PROJECT_ID) return;
    try {
      await fs.promises.unlink(ProjectStorage.filePath(projectId));
    } catch {
    }
  }
}
function exportsDir() {
  return path.join(getWorkspaceRoot(), "exports");
}
function gateEnvVars(flow, envVars, activeProjectId) {
  return activeProjectId && (flow.projectId ?? DEFAULT_PROJECT_ID) === activeProjectId ? envVars ?? {} : {};
}
function resolveFlowDomain(flow, envVars, activeProjectId) {
  return (gateEnvVars(flow, envVars, activeProjectId)[DOMAIN_ENV_KEY] ?? "").replace(/\/+$/, "");
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
  static resolveProfileVars(flow, profileId, activeEnvironmentId, envVars, activeProjectId) {
    const profile = profileId ? (flow.profiles ?? []).find((p) => p.id === profileId) : (flow.profiles ?? [])[0];
    if (!profile) return {};
    const flowEnvVars = gateEnvVars(flow, envVars, activeProjectId);
    return Object.fromEntries(
      profile.vars.map((v) => {
        const raw = (activeEnvironmentId && v.envValues?.[activeEnvironmentId]) ?? v.value;
        return [v.key, resolveValue(raw, void 0, flowEnvVars)];
      })
    );
  }
  /** Resolve which sub-flow profile ID to use given the parent's active profile.
   *  subFlowProfileMapping takes precedence; falls back to legacy subFlowProfileId. */
  static resolveSubFlowProfileId(action, parentActiveProfileId) {
    if (action.subFlowProfileMapping && parentActiveProfileId && parentActiveProfileId in action.subFlowProfileMapping) {
      return action.subFlowProfileMapping[parentActiveProfileId];
    }
    return action.subFlowProfileId ?? null;
  }
  static getSubFlowPath(subFlow, exitNodeId, subFlowMap, subProfileVars, subEnvVars, subBaseOrigin, subDomain, activeProfileId, activeEnvironmentId, envVars, activeProjectId) {
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
          const nestedProfileVars = ScriptExporter.resolveProfileVars(nested, nestedProfileId, activeEnvironmentId, envVars, activeProjectId);
          const nestedEnvVars = gateEnvVars(nested, envVars, activeProjectId);
          const nestedBaseOrigin = (() => {
            try {
              return new URL(nested.baseURL).origin;
            } catch {
              return "";
            }
          })();
          const nestedDomain = resolveFlowDomain(nested, envVars, activeProjectId);
          path2.unshift(...ScriptExporter.getSubFlowPath(nested, cur.action.subFlowExitNodeId, subFlowMap, nestedProfileVars, nestedEnvVars, nestedBaseOrigin, nestedDomain, nestedProfileId ?? void 0, activeEnvironmentId, envVars, activeProjectId));
        }
      } else {
        path2.unshift({ node: cur, profileVars: subProfileVars, envVars: subEnvVars, baseOrigin: subBaseOrigin, inlineVars: true, domain: subDomain });
      }
      cur = cur.parentId ? nodeMap.get(cur.parentId) : void 0;
    }
    return path2;
  }
  static buildStepSequence(nodeIds, nodeMap, subFlowMap, defaultProfileVars = {}, defaultEnvVars = {}, defaultBaseOrigin = "", defaultDomain = "", activeProfileId, activeEnvironmentId, envVars, activeProjectId) {
    const result = [];
    for (const id of nodeIds) {
      const node = nodeMap.get(id);
      if (!node) continue;
      if (isCallFlowAction(node.action)) {
        const subFlow = subFlowMap.get(node.action.subFlowId);
        if (subFlow) {
          const subProfileId = ScriptExporter.resolveSubFlowProfileId(node.action, activeProfileId);
          const subProfileVars = ScriptExporter.resolveProfileVars(subFlow, subProfileId, activeEnvironmentId, envVars, activeProjectId);
          const subEnvVars = gateEnvVars(subFlow, envVars, activeProjectId);
          const subBaseOrigin = (() => {
            try {
              return new URL(subFlow.baseURL).origin;
            } catch {
              return "";
            }
          })();
          const subDomain = resolveFlowDomain(subFlow, envVars, activeProjectId);
          result.push(...ScriptExporter.getSubFlowPath(subFlow, node.action.subFlowExitNodeId, subFlowMap, subProfileVars, subEnvVars, subBaseOrigin, subDomain, subProfileId ?? void 0, activeEnvironmentId, envVars, activeProjectId));
        }
      } else {
        result.push({ node, profileVars: defaultProfileVars, envVars: defaultEnvVars, baseOrigin: defaultBaseOrigin, inlineVars: false, domain: defaultDomain });
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
    const allEnvVars = config.envVars ?? {};
    const hasEnvVars = Object.keys(allEnvVars).length > 0;
    const baseOrigin = (() => {
      try {
        return new URL(flow.baseURL).origin;
      } catch {
        return "";
      }
    })();
    const flowDomain = resolveFlowDomain(flow, config.envVars, config.activeProjectId);
    const flowEnvVars = gateEnvVars(flow, config.envVars, config.activeProjectId);
    const usesVariables = flow.nodes.some(
      (n) => n.action.value && hasVariables(n.action.value) || n.action.locatorExpr && hasVariables(n.action.locatorExpr) || // code nodes emit `const vars = { randomText: _ftRandomText, … }`, so the helpers are needed
      n.action.type === "code"
    );
    let usesPopupHoist = false;
    const tests = paths.map((path2, idx) => {
      const testName = path2.name || `測試路徑 ${idx + 1}`;
      const steps = ScriptExporter.buildStepSequence(path2.nodeIds, nodeMap, subFlowMap, profileVars, flowEnvVars, baseOrigin, flowDomain, activeProfileId, config.activeEnvironmentId, config.envVars, config.activeProjectId);
      const sessionVarsDefined = /* @__PURE__ */ new Set();
      const hoistedVars = config.useTestStep ? new Set(steps.map(({ node }) => node.action.captureAs).filter((v) => !!v)) : /* @__PURE__ */ new Set();
      const hoistedPages = config.useTestStep ? new Set(steps.map(({ node }) => node.action.opensPage).filter((v) => !!v)) : /* @__PURE__ */ new Set();
      if (hoistedPages.size > 0) usesPopupHoist = true;
      const suppressChooser = steps.some(({ node }) => node.action.type === "upload") ? "    page.on('filechooser', () => {});\n" : "";
      const hoistDecls = suppressChooser + (hoistedVars.size > 0 ? [...hoistedVars].map((v) => `    let ${v} = ''`).join("\n") + "\n" : "") + (hoistedPages.size > 0 ? [...hoistedPages].map((p) => `    let ${p}: Page`).join("\n") + "\n" : "");
      const stepCode = steps.map(({ node, profileVars: stepProfileVars, envVars: stepEnvVars, baseOrigin: stepBaseOrigin, inlineVars, domain: stepDomain }) => {
        let rawAction = ScriptExporter.actionToCode(node, sessionVarsDefined, stepBaseOrigin, stepProfileVars, inlineVars, hoistedVars, stepDomain, stepEnvVars);
        if (node.action.opensPage) {
          const alias = node.action.opensPage;
          const pageRef = node.action.pageAlias || "page";
          const assign = hoistedPages.has(alias) ? `${alias} = await ${alias}Promise;` : `const ${alias} = await ${alias}Promise;`;
          rawAction = `const ${alias}Promise = ${pageRef}.waitForEvent('popup');
${rawAction}
${assign}`;
        }
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
      `import { test, expect${usesPopupHoist ? ", Page" : ""} } from '@playwright/test';`,
      helperImport,
      usesVariables ? VARIABLE_HELPERS_CODE : "",
      hasEnvVars ? `
${emitEnvVarDecls(allEnvVars)}` : "",
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
  static actionToCode(node, sessionVarsDefined, baseOrigin = "", profileVars = {}, inlineVars = false, hoistedVars = /* @__PURE__ */ new Set(), domainOverride = "", envVars = {}) {
    const { action } = node;
    const pageRef = action.pageAlias || "page";
    const frameChain = (action.framePath ?? []).map((f) => `.${f}.contentFrame()`).join("");
    const scopeRef = `${pageRef}${frameChain}`;
    const profileVarKeys = inlineVars ? /* @__PURE__ */ new Set() : new Set(Object.keys(profileVars));
    const scope = {
      profileVars: profileVarKeys,
      envVars: new Set(Object.keys(envVars))
    };
    let loc;
    const { selector } = action;
    const locatorExpr = action.locatorExpr && inlineVars ? action.locatorExpr.replace(/\{\{(\w+)\}\}/g, (m, k) => k in profileVars ? profileVars[k] : m) : action.locatorExpr;
    if (selector && /^\[name=/.test(selector)) {
      loc = `${scopeRef}.locator('${selector}')`;
    } else if (selector && /^\[data-id=/.test(selector)) {
      loc = `${scopeRef}.locator('${selector}')`;
    } else if (selector && /^\[aria-label=/.test(selector) && locatorExpr && /^getByText\(/.test(locatorExpr)) {
      loc = `${scopeRef}.locator('${selector}')`;
    } else if (locatorExpr && /^getByText\(/.test(locatorExpr)) {
      const textMatch = locatorExpr.match(/^getByText\("([^"]+)"/);
      if (textMatch && selector && /^button/.test(selector)) {
        loc = `${scopeRef}.getByRole("button", { name: "${textMatch[1]}", exact: true })`;
      } else if (textMatch && selector && /^a[\s\[]/.test(selector)) {
        loc = `${scopeRef}.getByRole("link", { name: "${textMatch[1]}", exact: true })`;
      } else if (textMatch) {
        loc = `${scopeRef}.getByText("${textMatch[1]}", { exact: true })`;
      } else {
        loc = `${scopeRef}.${locatorExpr}`;
      }
    } else if (locatorExpr) {
      loc = `${scopeRef}.${locatorExpr}`;
    } else {
      loc = `${scopeRef}.locator('${selector}')`;
    }
    if (hasVariables(loc)) {
      loc = locatorExprToCode(loc, { ...scope, sessionVars: sessionVarsDefined });
    }
    const resolveProfilePlaceholders = (v) => inlineVars ? v.replace(/\{\{(\w+)\}\}/g, (m, k) => k in profileVars ? profileVars[k] : m) : v;
    const captureAs = action.captureAs;
    let captureDecl = "";
    if (captureAs) {
      const expr = valueToCodeExpr(resolveProfilePlaceholders(action.value ?? ""), scope);
      captureDecl = hoistedVars.has(captureAs) ? `${captureAs} = ${expr};
` : `const ${captureAs} = ${expr};
`;
      sessionVarsDefined.add(captureAs);
    }
    const va = (v) => captureAs ? captureAs : sessionAwareValueToCodeExpr(resolveProfilePlaceholders(v), sessionVarsDefined, scope);
    switch (action.type) {
      case "goto": {
        let gotoVal = action.value ?? "";
        if (domainOverride && baseOrigin) {
          try {
            const parsed = new URL(gotoVal);
            if (parsed.origin === baseOrigin) {
              const rest = parsed.pathname + parsed.search + parsed.hash;
              return `${captureDecl}await ${pageRef}.goto('${domainOverride}${rest}');`;
            }
          } catch {
          }
        }
        if (inlineVars) {
          gotoVal = resolveValue(gotoVal, profileVars, envVars);
        }
        return `${captureDecl}await ${pageRef}.goto(${va(gotoVal)});`;
      }
      case "click": {
        const clickOpts = [];
        if (action.button && action.button !== "left") clickOpts.push(`button: '${action.button}'`);
        if (action.modifiers?.length) clickOpts.push(`modifiers: [${action.modifiers.map((m) => `'${m}'`).join(", ")}]`);
        const optStr = clickOpts.length ? `{ ${clickOpts.join(", ")} }` : "";
        const method = (action.clickCount ?? 1) >= 2 ? "dblclick" : "click";
        return `await ${loc}.${method}(${optStr});`;
      }
      case "fill":
        return `${captureDecl}await ${loc}.fill(${va(action.value ?? "")});`;
      case "selectOption":
        if (action.values?.length) {
          return `${captureDecl}await ${loc}.selectOption([${action.values.map((v) => va(v)).join(", ")}]);`;
        }
        return `${captureDecl}await ${loc}.selectOption(${va(action.value ?? "")});`;
      case "check":
        return `await ${loc}.check();`;
      case "uncheck":
        return `await ${loc}.uncheck();`;
      case "press":
        return action.locatorExpr ? `${captureDecl}await ${loc}.press(${va(action.value ?? "")});` : `${captureDecl}await ${pageRef}.keyboard.press(${va(action.value ?? "")});`;
      case "upload": {
        const files = (action.filePaths?.length ? action.filePaths : (action.value ?? "").split(",")).map((s) => s.trim()).filter(Boolean);
        const arg = files.length === 1 ? va(files[0]) : `[${files.map((f) => va(f)).join(", ")}]`;
        const uploadLoc = /\binput\b/.test(action.locatorExpr ?? action.selector ?? "") ? loc : `${loc}.and(${scopeRef}.locator('input[type="file"]'))`;
        return `${captureDecl}await ${uploadLoc}.setInputFiles(${arg});`;
      }
      case "code": {
        const used = /* @__PURE__ */ new Set();
        const entries = [];
        for (const key of Object.keys(profileVars)) {
          if (used.has(key)) continue;
          used.add(key);
          entries.push(`${JSON.stringify(key)}: ${inlineVars ? JSON.stringify(profileVars[key]) : `_ftProf_${key}`}`);
        }
        for (const key of Object.keys(envVars)) {
          if (used.has(key)) continue;
          used.add(key);
          entries.push(`${JSON.stringify(key)}: _ftEnv_${key}`);
        }
        for (const name of sessionVarsDefined) {
          if (used.has(name)) continue;
          used.add(name);
          entries.push(`${JSON.stringify(name)}: ${name}`);
        }
        const builtins = [
          ["randomText", "_ftRandomText"],
          ["randomNumber", "_ftRandomNumber"],
          ["randomOneText", "_ftRandomOneLetter"],
          ["randomOneNumber", "_ftRandomOneDigit"],
          ["timestamp", "_ftTimestamp"]
        ];
        for (const [name, fn] of builtins) {
          if (used.has(name)) continue;
          entries.push(`${name}: ${fn}`);
        }
        const varsDecl = `const vars = { ${entries.join(", ")} };`;
        return `${varsDecl}
${action.code ?? ""}`;
      }
      case "wait":
        return `await ${loc}.waitFor({ state: 'visible' });`;
      case "assertVisible":
        return `await expect(${loc}).toBeVisible();`;
      case "assertText": {
        const valueExpr = va(action.value ?? "");
        const isSessionVar = !!action.value && /^\{\{(\w+)\}\}$/.test(action.value) && sessionVarsDefined.has(action.value.slice(2, -2));
        const assertLoc = isSessionVar && action.selector ? `${scopeRef}.locator('${action.selector}').filter({ hasText: ${valueExpr} })` : loc;
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
    const pageRef = action.pageAlias || "page";
    const scopeRef = `${pageRef}${(action.framePath ?? []).map((f) => `.${f}.contentFrame()`).join("")}`;
    switch (a.type) {
      case "text":
        return `await expect(${scopeRef}.locator('${a.target}')).toContainText('${a.expected}');`;
      case "visible":
        return `await expect(${scopeRef}.locator('${a.target}')).toBeVisible();`;
      case "url":
        return `await expect(${pageRef}).toHaveURL(/${a.expected}/);`;
      case "count":
        return `await expect(${scopeRef}.locator('${a.target}')).toHaveCount(${a.expected});`;
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
    if (prefixNodes.some((n) => n.action.pageAlias || n.action.opensPage)) {
      return { helperCode: "", helperImport: "" };
    }
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
function browsersRoot() {
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (override) return override === "0" ? null : override;
  switch (process.platform) {
    case "win32":
      return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ms-playwright");
    case "darwin":
      return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
    default:
      return path.join(os.homedir(), ".cache", "ms-playwright");
  }
}
async function hasChromium() {
  const root = browsersRoot();
  if (root === null) return true;
  try {
    const entries = await fs.promises.readdir(root);
    return entries.some((e) => e.startsWith("chromium"));
  } catch {
    return false;
  }
}
function isMissingBrowserError(text) {
  return text.includes("Executable doesn't exist") || text.includes("playwright install") || text.includes("browserType.launch: Executable");
}
const _req = module$1.createRequire(require("url").pathToFileURL(__filename).href);
function unpacked(p) {
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}
let cached;
function resolvePlaywrightCli() {
  if (cached !== void 0) return cached;
  try {
    const path$1 = unpacked(_req.resolve("@playwright/test/cli"));
    const version = _req("@playwright/test/package.json").version;
    cached = { path: path$1, version, nodePath: path.resolve(path$1, "..", "..", "..") };
  } catch {
    cached = null;
  }
  return cached;
}
const HTML_REPORT_DIR = ".flowtest/playwright-report";
function runPlaywright(cli, args, cwd, onOutput) {
  return new Promise((resolve2) => {
    const child = child_process.spawn(process.execPath, [cli.path, ...args], {
      cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_PATH: process.env.NODE_PATH ? `${cli.nodePath}${path.delimiter}${process.env.NODE_PATH}` : cli.nodePath,
        PLAYWRIGHT_HTML_OUTPUT_DIR: HTML_REPORT_DIR,
        // The run must never block on a browser popping open by itself; the user
        // opens the report deliberately via SHOW_REPORT.
        PLAYWRIGHT_HTML_OPEN: "never"
      }
    });
    let output = "";
    const pipe = (d) => {
      const text = d.toString();
      output += text;
      onOutput(text);
    };
    child.stdout.on("data", pipe);
    child.stderr.on("data", pipe);
    child.on("error", (err) => {
      const text = `
✗ 無法啟動測試執行器: ${String(err)}
`;
      output += text;
      onOutput(text);
      resolve2({ exitCode: 1, output });
    });
    child.on("close", (code) => resolve2({ exitCode: code ?? 1, output }));
  });
}
const MISSING_CLI_MESSAGE = "✗ 找不到內建的測試執行器 (@playwright/test)。\n  這是打包問題，不是設定問題 — 請確認建置時有包含並解壓 node_modules/@playwright/test。\n";
let browserController = null;
let recorder = null;
let replayer = null;
function registerIpcHandlers(win) {
  const importFiles = async (absPaths) => (await Promise.all(absPaths.map((p) => FixtureStorage.importFile(p)))).map((i) => i.stored);
  electron.ipcMain.handle(IPC_CHANNELS.PICK_FILES, async (_e, { multiple } = {}) => {
    const result = await electron.dialog.showOpenDialog(win, {
      title: "選擇要上傳的檔案",
      properties: multiple ?? true ? ["openFile", "multiSelections"] : ["openFile"]
    });
    if (result.canceled || !result.filePaths.length) return [];
    return await importFiles(result.filePaths);
  });
  electron.ipcMain.handle(
    IPC_CHANNELS.NORMALIZE_PATHS,
    async (_e, paths) => await Promise.all(paths.map((p) => FixtureStorage.normalizeStoredPath(p)))
  );
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
    await browserController.launch({ maximized: true });
    const page = browserController.getPage();
    if (payload.branchFromNodeId && payload.branchNodes?.length) {
      const silentReplayer = new Replayer(page, payload.baseURL, payload.profileVars, payload.activeProfileId, payload.activeEnvironmentId, payload.envVars, payload.activeProjectId);
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
    recorder = new Recorder(
      page,
      (action) => {
        win.webContents.send(IPC_CHANNELS.ACTION_CAPTURED, action);
      },
      (payload2) => {
        win.webContents.send(IPC_CHANNELS.ACTION_UPDATED, payload2);
      },
      // Uploads: the real paths CDP read out of the browser, copied into fixtures/
      importFiles,
      (actionId) => {
        win.webContents.send(IPC_CHANNELS.ACTION_REMOVED, actionId);
      }
    );
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
  electron.ipcMain.handle(IPC_CHANNELS.LOCATOR_PICK_RESOLVED, () => {
    recorder?.resume();
  });
  electron.ipcMain.handle(IPC_CHANNELS.REPLAY_TO_NODE, async (_e, payload) => {
    try {
      if (!browserController || !browserController.isRunning()) {
        browserController = new BrowserController();
        await browserController.launch({ maximized: true });
      }
      const page = browserController.getPage();
      replayer = new Replayer(page, payload.baseURL, payload.profileVars, payload.activeProfileId, payload.activeEnvironmentId, payload.envVars, payload.activeProjectId);
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
    await FlowStorage.save(payload.flow, { touch: payload.touch });
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
  electron.ipcMain.handle(IPC_CHANNELS.PROJECT_SAVE, async (_e, payload) => {
    await ProjectStorage.save(payload.project);
  });
  electron.ipcMain.handle(IPC_CHANNELS.PROJECT_LOAD, async (_e, payload) => {
    return await ProjectStorage.load(payload.projectId);
  });
  electron.ipcMain.handle(IPC_CHANNELS.PROJECT_LIST, async () => {
    return await ProjectStorage.list();
  });
  electron.ipcMain.handle(IPC_CHANNELS.PROJECT_DELETE, async (_e, projectId) => {
    await ProjectStorage.delete(projectId);
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
  const out = (text) => win.webContents.send(IPC_CHANNELS.TEST_OUTPUT, text);
  electron.ipcMain.handle(IPC_CHANNELS.RUN_TESTS, async (_e, payload) => {
    const finish = (exitCode2) => {
      win.webContents.send(IPC_CHANNELS.TEST_FINISHED, { exitCode: exitCode2, passed: exitCode2 === 0 });
    };
    const cli = resolvePlaywrightCli();
    if (!cli) {
      out(MISSING_CLI_MESSAGE);
      return finish(1);
    }
    let specPath;
    try {
      specPath = await ScriptExporter.export(payload.flow, payload.config);
      out(`✓ 腳本已匯出: ${specPath}
`);
    } catch (err) {
      out(`✗ 匯出失敗: ${String(err)}
`);
      return finish(1);
    }
    const specFilename = path.basename(specPath);
    const cwd = getWorkspaceRoot();
    const args = ["test", specFilename, "--config", configPath(), "--reporter=list,html"];
    out(`✓ 執行器: ${cli.path} (v${cli.version})
`);
    out(`▶ playwright ${args.join(" ")}

`);
    const { exitCode, output } = await runPlaywright(cli, args, cwd, out);
    if (exitCode !== 0 && isMissingBrowserError(output)) {
      out("\n⚠ 缺少 Chromium 瀏覽器 — 請點擊「安裝瀏覽器」後重試。\n");
    }
    finish(exitCode);
  });
  electron.ipcMain.handle(IPC_CHANNELS.SHOW_REPORT, async () => {
    const cli = resolvePlaywrightCli();
    if (!cli) return out(MISSING_CLI_MESSAGE);
    await killProcessOnPort(9323);
    child_process.spawn(process.execPath, [cli.path, "show-report", HTML_REPORT_DIR], {
      cwd: getWorkspaceRoot(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_PATH: cli.nodePath },
      detached: true,
      stdio: "ignore"
    }).unref();
  });
  electron.ipcMain.handle(IPC_CHANNELS.BROWSER_CHECK, async () => await hasChromium());
  electron.ipcMain.handle(IPC_CHANNELS.BROWSER_INSTALL, async () => {
    const cli = resolvePlaywrightCli();
    if (!cli) {
      out(MISSING_CLI_MESSAGE);
      return false;
    }
    out("▶ 正在下載 Chromium…\n\n");
    const { exitCode } = await runPlaywright(cli, ["install", "chromium"], getWorkspaceRoot(), out);
    out(exitCode === 0 ? "\n✓ 瀏覽器安裝完成\n" : `
✗ 安裝失敗 (exit ${exitCode})
`);
    win.webContents.send(IPC_CHANNELS.TEST_FINISHED, { exitCode, passed: exitCode === 0 });
    return exitCode === 0;
  });
  const workspaceInfo = async () => ({
    root: hasWorkspace() ? getWorkspaceRoot() : null,
    recent: await Promise.all(
      getRecentWorkspaces().map(async (p) => ({
        path: p,
        name: path.basename(p) || p,
        exists: await pathExists(p)
      }))
    ),
    hasChromium: await hasChromium()
  });
  electron.ipcMain.handle(IPC_CHANNELS.WORKSPACE_GET, workspaceInfo);
  electron.ipcMain.handle(IPC_CHANNELS.WORKSPACE_PICK, async () => {
    const result = await electron.dialog.showOpenDialog(win, {
      title: "選擇工作區資料夾",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths.length) return null;
    const dir = result.filePaths[0];
    const warning = warnAbout(dir);
    if (warning) {
      const { response } = await electron.dialog.showMessageBox(win, {
        type: "warning",
        buttons: ["取消", "仍要使用"],
        defaultId: 0,
        cancelId: 0,
        message: warning,
        detail: dir
      });
      if (response === 0) return null;
    }
    await setWorkspaceRoot(dir);
    return await workspaceInfo();
  });
  electron.ipcMain.handle(IPC_CHANNELS.WORKSPACE_SET, async (_e, dir) => {
    await setWorkspaceRoot(dir);
    return await workspaceInfo();
  });
  electron.ipcMain.handle(IPC_CHANNELS.WORKSPACE_FORGET, async (_e, dir) => {
    await removeRecentWorkspace(dir);
    return await workspaceInfo();
  });
  electron.ipcMain.handle(IPC_CHANNELS.WORKSPACE_REVEAL, async () => {
    if (hasWorkspace()) await electron.shell.openPath(getWorkspaceRoot());
  });
}
async function pathExists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
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
  win.on("focus", () => {
    if (hasWorkspace()) win.webContents.send(IPC_CHANNELS.WORKSPACE_RELOAD);
  });
  win.on("ready-to-show", () => {
    win.show();
    win.setAlwaysOnTop(true);
    win.focus();
    win.setAlwaysOnTop(false);
  });
  return win;
}
electron.app.whenReady().then(async () => {
  await loadSettings();
  const win = createWindow();
  registerIpcHandlers(win);
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
