"use strict";
const electron = require("electron");
const path = require("path");
const playwrightCore = require("playwright-core");
const uuid = require("uuid");
const fs = require("fs");
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
  // Main → Renderer
  ACTION_CAPTURED: "action:captured",
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
class CodegenCapture {
  context;
  onAction;
  active = false;
  lastGotoUrl = "";
  constructor(context, onAction) {
    this.context = context;
    this.onAction = onAction;
  }
  async start() {
    this.active = true;
    this.lastGotoUrl = "";
    const pages = this.context.pages();
    const page = pages[0];
    if (!page) throw new Error("No page available in browser context");
    await page.addInitScript(() => {
      function getCSSPseudoContent(el, pseudo) {
        try {
          const raw = window.getComputedStyle(el, pseudo).content;
          if (!raw || raw === "none" || raw === "normal") return "";
          if (!/^["']/.test(raw)) return "";
          return raw.slice(1, -1);
        } catch {
          return "";
        }
      }
      function collectText(el) {
        const htmlEl = el;
        const parts = [];
        parts.push(getCSSPseudoContent(htmlEl, "::before"));
        for (const child of el.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            parts.push(child.textContent || "");
          } else if (child.nodeType === Node.ELEMENT_NODE) {
            const childEl = child;
            if (childEl.getAttribute("aria-hidden") === "true") continue;
            if (childEl.hidden) continue;
            const childAriaLabel = childEl.getAttribute("aria-label")?.trim();
            if (childAriaLabel) {
              parts.push(childAriaLabel);
              continue;
            }
            const childText = collectText(childEl);
            if (!childText.trim()) continue;
            const display = window.getComputedStyle(childEl).display || "inline";
            parts.push(display === "inline" ? childText : " " + childText + " ");
          }
        }
        parts.push(getCSSPseudoContent(htmlEl, "::after"));
        return parts.join("");
      }
      function computeAriaName(el) {
        const htmlEl = el;
        const ariaLabel = htmlEl.getAttribute("aria-label")?.trim();
        if (ariaLabel) return ariaLabel;
        const labelledByIds = htmlEl.getAttribute("aria-labelledby")?.trim();
        if (labelledByIds) {
          const text = labelledByIds.split(/\s+/).map((id) => {
            const ref = document.getElementById(id);
            return ref ? computeAriaName(ref) : "";
          }).filter(Boolean).join(" ");
          if (text) return text.replace(/\s+/g, " ").trim();
        }
        const inp = el;
        if (inp.labels && inp.labels.length > 0) {
          const text = inp.labels[0].textContent?.replace(/\s+/g, " ").trim();
          if (text) return text;
        }
        return collectText(el).replace(/\s+/g, " ").trim();
      }
      function getRole(el) {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit.trim().split(/\s+/)[0];
        const tag = el.tagName.toLowerCase();
        const type = (el.type || "").toLowerCase();
        if (tag === "button") return "button";
        if (tag === "a" && el.href) return "link";
        if (tag === "input") {
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (["button", "submit", "reset", "image"].includes(type)) return "button";
          if (type === "range") return "slider";
          if (type === "number") return "spinbutton";
          if (type === "search") return "searchbox";
          return "textbox";
        }
        if (tag === "select") return "combobox";
        if (tag === "textarea") return "textbox";
        return null;
      }
      const INTERACTIVE_ROLES = /* @__PURE__ */ new Set([
        "button",
        "link",
        "checkbox",
        "radio",
        "combobox",
        "textbox",
        "searchbox",
        "spinbutton",
        "slider",
        "menuitem",
        "tab",
        "switch",
        "option",
        "treeitem",
        "gridcell",
        "menuitemcheckbox",
        "menuitemradio"
      ]);
      function uniqueCSS(selector) {
        try {
          return document.querySelectorAll(selector).length === 1;
        } catch {
          return false;
        }
      }
      function countByRoleAndName(role, name) {
        const byAttr = [...document.querySelectorAll(`[role="${role}"]`)];
        const byTag = [];
        if (role === "button") byTag.push(...document.querySelectorAll("button"));
        if (role === "link") byTag.push(...document.querySelectorAll("a"));
        if (role === "combobox") byTag.push(...document.querySelectorAll("select"));
        if (role === "textbox") byTag.push(...document.querySelectorAll('input:not([type]),input[type="text"],input[type="email"],input[type="password"],input[type="tel"],input[type="url"],textarea'));
        if (role === "checkbox") byTag.push(...document.querySelectorAll('input[type="checkbox"]'));
        if (role === "radio") byTag.push(...document.querySelectorAll('input[type="radio"]'));
        const candidates = [.../* @__PURE__ */ new Set([...byAttr, ...byTag])];
        return candidates.filter((el) => {
          const n = computeAriaName(el).replace(/\s+/g, " ").trim();
          return n === name;
        }).length;
      }
      function countByLabel(labelText) {
        const associated = /* @__PURE__ */ new Set();
        document.querySelectorAll("label").forEach((lbl) => {
          const clone = lbl.cloneNode(true);
          clone.querySelectorAll("input,select,textarea,button").forEach((n) => n.remove());
          const text = clone.textContent?.replace(/\s+/g, " ").trim();
          if (text !== labelText) return;
          const forId = lbl.getAttribute("for");
          if (forId) {
            const el = document.getElementById(forId);
            if (el) associated.add(el);
          }
          lbl.querySelectorAll("input,select,textarea").forEach((el) => associated.add(el));
        });
        return associated.size;
      }
      function q(s) {
        return JSON.stringify(s);
      }
      function generateLocator(el) {
        const htmlEl = el;
        const tag = el.tagName.toLowerCase();
        const type = (el.type || "").toLowerCase();
        const role = getRole(el);
        const testId = htmlEl.getAttribute("data-testid") || htmlEl.dataset?.testid;
        if (testId && uniqueCSS(`[data-testid="${testId}"]`))
          return `getByTestId(${q(testId)})`;
        if (role && INTERACTIVE_ROLES.has(role)) {
          const name = computeAriaName(el);
          if (name && countByRoleAndName(role, name) === 1)
            return `getByRole(${q(role)}, { name: ${q(name)}, exact: true })`;
        }
        if (["input", "select", "textarea"].includes(tag)) {
          const inp = el;
          let labelText;
          if (inp.labels && inp.labels.length > 0)
            labelText = inp.labels[0].textContent?.replace(/\s+/g, " ").trim() || void 0;
          if (!labelText) {
            const parentLabel = el.closest("label");
            if (parentLabel) {
              const clone = parentLabel.cloneNode(true);
              clone.querySelectorAll("input,select,textarea,button").forEach((n) => n.remove());
              labelText = clone.textContent?.replace(/\s+/g, " ").trim() || void 0;
            }
          }
          if (labelText && countByLabel(labelText) === 1)
            return `getByLabel(${q(labelText)})`;
        }
        const nameAttr = htmlEl.getAttribute("name");
        if (nameAttr && ["input", "select", "textarea"].includes(tag) && uniqueCSS(`[name="${nameAttr}"]`))
          return `locator(${q(`[name="${nameAttr}"]`)})`;
        const placeholder = htmlEl.getAttribute("placeholder");
        if (placeholder && uniqueCSS(`[placeholder="${placeholder}"]`))
          return `getByPlaceholder(${q(placeholder)})`;
        const id = htmlEl.id;
        if (id && !/^[0-9a-f-]{20,}$|^[0-9a-f]{8}-/.test(id) && uniqueCSS(`#${id}`))
          return `locator(${q("#" + id)})`;
        const ariaLabel = htmlEl.getAttribute("aria-label");
        if (ariaLabel && uniqueCSS(`[aria-label="${ariaLabel}"]`))
          return `locator(${q(`[aria-label="${ariaLabel}"]`)})`;
        const fallback = type && !["text", ""].includes(type) ? `${tag}[type="${type}"]` : tag;
        return `locator(${q(fallback)})`;
      }
      function generateCSSSelector(el) {
        const htmlEl = el;
        const testId = htmlEl.getAttribute("data-testid");
        if (testId) return `[data-testid="${testId}"]`;
        if (htmlEl.id) return `#${htmlEl.id}`;
        const ariaLabel = htmlEl.getAttribute("aria-label");
        if (ariaLabel) return `[aria-label="${ariaLabel}"]`;
        const name = htmlEl.getAttribute("name");
        if (name) return `[name="${name}"]`;
        const tag = el.tagName.toLowerCase();
        const type = (el.type || "").toLowerCase();
        return type && !["text", ""].includes(type) ? `${tag}[type="${type}"]` : tag;
      }
      function getLabel(el) {
        const name = computeAriaName(el);
        if (name) return name;
        const htmlEl = el;
        const placeholder = htmlEl.getAttribute("placeholder");
        if (placeholder) return placeholder;
        const nameAttr = htmlEl.getAttribute("name");
        if (nameAttr) return nameAttr;
        return el.tagName.toLowerCase();
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
        if (tag === "input" && (type === "checkbox" || type === "radio")) {
          report({
            kind: el.checked ? "check" : "uncheck",
            locatorExpr: generateLocator(el),
            selector: generateCSSSelector(el),
            label: getLabel(el),
            timestamp: Date.now(),
            url: window.location.href
          });
          return;
        }
        report({
          kind: "click",
          locatorExpr: generateLocator(el),
          selector: generateCSSSelector(el),
          label: getLabel(el),
          timestamp: Date.now(),
          url: window.location.href
        });
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
        report({
          kind: "fill",
          locatorExpr: generateLocator(el),
          selector: generateCSSSelector(el),
          label: getLabel(el),
          value: current,
          timestamp: Date.now(),
          url: window.location.href
        });
      }, true);
      document.addEventListener("change", (e) => {
        const el = e.target;
        if (el.tagName.toLowerCase() !== "select") return;
        const opt = el.options[el.selectedIndex];
        report({
          kind: "selectOption",
          locatorExpr: generateLocator(el),
          selector: generateCSSSelector(el),
          label: getLabel(el),
          value: el.value,
          selectedText: opt?.text?.trim(),
          timestamp: Date.now(),
          url: window.location.href
        });
      }, true);
      document.addEventListener("keydown", (e) => {
        if (!["Enter", "Escape"].includes(e.key)) return;
        const el = e.target;
        if (!el?.tagName) return;
        if (e.key === "Enter" && el.tagName.toLowerCase() === "textarea" && !e.ctrlKey && !e.metaKey) return;
        if (!isTextInput(el) && !["button", "a", "select"].includes(el.tagName.toLowerCase())) return;
        report({
          kind: "press",
          locatorExpr: generateLocator(el),
          selector: generateCSSSelector(el),
          label: getLabel(el),
          value: e.key,
          timestamp: Date.now(),
          url: window.location.href
        });
      }, true);
    });
    await page.exposeFunction("__flowtest_report", (raw) => {
      if (!this.active) return;
      this.processEvent(raw);
    });
    page.on("framenavigated", (frame) => {
      if (!this.active || frame !== page.mainFrame()) return;
      const url = frame.url();
      if (!url || url === "about:blank" || url === this.lastGotoUrl) return;
      this.lastGotoUrl = url;
      this.onAction({
        id: uuid.v4(),
        type: "goto",
        selector: "",
        value: url,
        description: `導航到 ${url}`,
        timestamp: Date.now(),
        url,
        isPageNavigation: true
      });
    });
  }
  async stop() {
    this.active = false;
  }
  processEvent(raw) {
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
        return;
    }
    this.onAction({
      id: uuid.v4(),
      type,
      selector: raw.selector,
      locatorExpr: raw.locatorExpr,
      value,
      description: generateDescription(raw.kind, raw.label, raw.value, raw.selectedText),
      timestamp: raw.timestamp || Date.now(),
      url: raw.url,
      isPageNavigation: false
    });
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
