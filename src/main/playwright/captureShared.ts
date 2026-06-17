import { v4 as uuidv4 } from 'uuid'
import * as fs from 'fs'
import * as vm from 'vm'
import * as path from 'path'
import { createRequire } from 'module'
import type { Action } from '../../shared/types'

export type ActionCallback = (action: Action) => void

// Mirrors Playwright's RecorderSignalProcessor threshold (5 s in production).
// Navigation within this window after a click/press/fill is treated as a redirect
// side-effect and is NOT recorded as a goto node.
export const NAV_SUPPRESSION_MS = 5_000

export interface LastInteraction {
  time: number          // Date.now() on the Node.js side when the action was received
  type: Action['type']
}

// Returns true when the navigation should be suppressed (i.e. NOT recorded as goto).
// Matches Playwright's RecorderSignalProcessor logic:
//   skip goto if the last action was click/press/fill AND happened within NAV_SUPPRESSION_MS.
export function shouldSuppressNav(
  navigationTime: number,
  last: LastInteraction | null,
): boolean {
  if (!last) return false
  if (!(['click', 'press', 'fill'] as Action['type'][]).includes(last.type)) return false
  // Negative diff (navigation fired before IPC settled) is always suppressed — correct
  // because it means the SPA navigation happened in the same tick as the user action.
  return navigationTime - last.time < NAV_SUPPRESSION_MS
}

export interface RawEvent {
  kind: 'click' | 'fill' | 'selectOption' | 'check' | 'uncheck' | 'press'
  locatorExpr: string
  selector: string
  label: string
  value?: string
  selectedText?: string
  timestamp: number
  url: string
  isInputClick?: boolean
}

export function generateDescription(
  kind: RawEvent['kind'],
  label: string,
  value?: string,
  selectedText?: string,
): string {
  switch (kind) {
    case 'click':        return `點擊「${label}」`
    case 'fill':         return `填入「${value ?? ''}」到「${label}」`
    case 'selectOption': return `選擇「${selectedText ?? value ?? ''}」from「${label}」`
    case 'check':        return `勾選「${label}」`
    case 'uncheck':      return `取消勾選「${label}」`
    case 'press':        return `在「${label}」按下 ${value}`
  }
}

// ── Extract Playwright's InjectedScript ────────────────────────────────────────
//
// playwright-core/lib/coreBundle.js contains `source3`: the JavaScript bundle
// Playwright injects into every page it controls. It exports `InjectedScript`
// (full ARIA accname, selector scoring, uniqueness checks) and `asLocator`
// (converts internal selector format → JS locator expression).
//
// By injecting this ourselves, our selectors are 100% identical to `playwright codegen`.

function extractSource3(): string {
  const _req = createRequire(import.meta.url)
  let coreBundlePath: string
  try {
    coreBundlePath = _req.resolve('playwright-core/lib/coreBundle.js')
  } catch {
    coreBundlePath = path.join(process.cwd(), 'node_modules', 'playwright-core', 'lib', 'coreBundle.js')
  }

  const src = fs.readFileSync(coreBundlePath, 'utf8')

  // source3 is stored as a single-quoted JS string literal inside coreBundle.js,
  // all on one line:  source3 = '\nvar __commonJS = ...';\n  ...
  // A literal newline character (charCode 10) cannot appear inside a single-quoted
  // string, so the first one after contentStart marks the end of the assignment.
  const startMarker = "source3 = '"
  const markerIdx = src.indexOf(startMarker)
  if (markerIdx < 0) throw new Error('[FlowTest] Could not locate source3 in playwright-core/lib/coreBundle.js')
  const contentStart = markerIdx + startMarker.length

  let firstNewline = -1
  for (let i = contentStart; i < src.length; i++) {
    if (src.charCodeAt(i) === 10) { firstNewline = i; break }
  }
  if (firstNewline < 0) throw new Error('[FlowTest] Could not find end of source3 in coreBundle.js')

  // Trim trailing '; (closing quote + semicolon) and decode escape sequences
  const escaped = src.slice(contentStart, firstNewline - 2)
  return vm.runInNewContext(`'${escaped}'`) as string
}

// Build once at module load; shared across CodegenCapture and ActionCapture.
let _initScript: string | null = null

export function getBrowserInitScript(): string {
  if (_initScript !== null) return _initScript
  try {
    const source3 = extractSource3()
    const opts = JSON.stringify({
      testIdAttributeName: 'data-testid',
      stableRafCount: 1,
      browserName: 'chromium',
      shouldPrependErrorPrefix: false,
      isUtilityWorld: false,
      customEngines: [],
    })
    // Wrap source3 in an IIFE that:
    //  1. Provides the CommonJS `module` object source3 expects
    //  2. Instantiates InjectedScript and stores it on window.__ftInjected
    //  3. Exposes window.__ftGetLocator(el) → Playwright JS locator string
    // asLocator() is defined inside source3 and accessible within the same IIFE scope.
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
})();`
  } catch (e) {
    console.warn('[FlowTest] Playwright InjectedScript extraction failed — falling back to built-in locator logic:', e)
    _initScript = ''
  }
  return _initScript
}

// Returns the DOM-side event capture script to pass to page.addInitScript().
// Identical logic is used by both CodegenCapture and ActionCapture.
export function getDOMCaptureScript(): () => void {
  return () => {
    function generateCSSSelector(el: Element): string {
      const h = el as HTMLElement
      const testId = h.getAttribute('data-testid')
      if (testId) return `[data-testid="${testId}"]`
      if (h.id) return `#${h.id}`
      const aria = h.getAttribute('aria-label')
      if (aria) return `[aria-label="${aria}"]`
      const name = h.getAttribute('name')
      if (name) return `[name="${name}"]`
      const tag = el.tagName.toLowerCase()
      const type = ((el as HTMLInputElement).type || '').toLowerCase()
      return type && !['text', ''].includes(type) ? `${tag}[type="${type}"]` : tag
    }

    function getLocatorExpr(el: Element): string {
      const loc = (window as any).__ftGetLocator?.(el) as string | null
      if (loc) return loc
      return `locator(${JSON.stringify(generateCSSSelector(el))})`
    }

    function extractLabel(locatorExpr: string, el: Element): string {
      // Playwright's asLocator() generates single-quoted JS; accept both quote styles.
      const q = `['"]([^'"]+)['"]`
      const patterns = [
        new RegExp(`\\bname:\\s*${q}`),
        new RegExp(`getByLabel\\(${q}`),
        new RegExp(`getByPlaceholder\\(${q}`),
        new RegExp(`getByTestId\\(${q}`),
        new RegExp(`getByText\\(${q}`),
        new RegExp(`hasText:\\s*${q}`),
      ]
      for (const re of patterns) {
        const m = locatorExpr.match(re)
        if (m) return m[1]
      }
      const h = el as HTMLElement
      return h.getAttribute('aria-label')?.trim()
        || h.getAttribute('placeholder')
        || h.getAttribute('name')
        || el.tagName.toLowerCase()
    }

    function isTextInput(el: Element): boolean {
      const tag = el.tagName.toLowerCase()
      if (tag === 'textarea') return true
      if (tag !== 'input') return false
      const t = ((el as HTMLInputElement).type || '').toLowerCase()
      return !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color', 'hidden'].includes(t)
    }

    function report(data: object): void {
      try { ;(window as any).__flowtest_report(data) } catch (_) { /* ignore */ }
    }

    const focusValues = new WeakMap<Element, string>()

    // ── Click ─────────────────────────────────────────────────────────────
    document.addEventListener('click', (e: MouseEvent) => {
      let el = e.target as Element
      if (!el?.tagName) return
      if (isTextInput(el)) {
        // Always report text input clicks with isInputClick flag.
        // Node.js will discard it if a fill on the same element follows
        // (regular typing), or keep it if nothing follows (e.g., opening a dropdown).
        const locatorExpr = getLocatorExpr(el)
        const label = extractLabel(locatorExpr, el)
        report({ kind: 'click', locatorExpr, selector: generateCSSSelector(el), label, timestamp: Date.now(), url: window.location.href, isInputClick: true })
        return
      }
      if (el.tagName.toLowerCase() === 'select') return

      // Bubble up to nearest interactive ancestor (mirrors Playwright codegen)
      let cur: Element | null = el
      let foundInteractive = false
      while (cur) {
        const t = cur.tagName.toLowerCase()
        const r = cur.getAttribute('role')
        const interactive =
          t === 'button' || t === 'a' ||
          r === 'button' || r === 'link' || r === 'menuitem' || r === 'tab' || r === 'option'
        if (interactive) { el = cur; foundInteractive = true; break }
        if (['form', 'main', 'section', 'article', 'nav', 'header', 'footer'].includes(t)) break
        cur = cur.parentElement
      }

      const tag = el.tagName.toLowerCase()
      const type = ((el as HTMLInputElement).type || '').toLowerCase()
      const nativeInteractive = ['button', 'a', 'input', 'select', 'textarea', 'label'].includes(tag)
      if (!foundInteractive && !nativeInteractive) return

      const locatorExpr = getLocatorExpr(el)
      const label = extractLabel(locatorExpr, el)

      if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
        report({ kind: (el as HTMLInputElement).checked ? 'check' : 'uncheck', locatorExpr, selector: generateCSSSelector(el), label, timestamp: Date.now(), url: window.location.href })
        return
      }
      report({ kind: 'click', locatorExpr, selector: generateCSSSelector(el), label, timestamp: Date.now(), url: window.location.href })
    }, true)

    // ── Fill: emit on blur when value changed ──────────────────────────────
    document.addEventListener('focus', (e: FocusEvent) => {
      const el = e.target as HTMLInputElement
      if (!el?.tagName || !isTextInput(el)) return
      focusValues.set(el, el.value ?? '')
    }, true)

    document.addEventListener('blur', (e: FocusEvent) => {
      const el = e.target as HTMLInputElement
      if (!el?.tagName || !isTextInput(el)) return
      const initial = focusValues.get(el)
      const current = el.value ?? ''
      focusValues.delete(el)
      if (initial === undefined || current === initial) return
      const locatorExpr = getLocatorExpr(el)
      report({ kind: 'fill', locatorExpr, selector: generateCSSSelector(el), label: extractLabel(locatorExpr, el), value: current, timestamp: Date.now(), url: window.location.href })
    }, true)

    // ── SelectOption ───────────────────────────────────────────────────────
    document.addEventListener('change', (e: Event) => {
      const el = e.target as HTMLSelectElement
      if (el.tagName.toLowerCase() !== 'select') return
      const opt = el.options[el.selectedIndex]
      const locatorExpr = getLocatorExpr(el)
      report({ kind: 'selectOption', locatorExpr, selector: generateCSSSelector(el), label: extractLabel(locatorExpr, el), value: el.value, selectedText: opt?.text?.trim(), timestamp: Date.now(), url: window.location.href })
    }, true)

    // ── Press: Enter / Escape ──────────────────────────────────────────────
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (!['Enter', 'Escape'].includes(e.key)) return
      const el = e.target as Element
      if (!el?.tagName) return
      if (e.key === 'Enter' && el.tagName.toLowerCase() === 'textarea' && !e.ctrlKey && !e.metaKey) return
      if (!isTextInput(el) && !['button', 'a', 'select'].includes(el.tagName.toLowerCase())) return
      const locatorExpr = getLocatorExpr(el)
      report({ kind: 'press', locatorExpr, selector: generateCSSSelector(el), label: extractLabel(locatorExpr, el), value: e.key, timestamp: Date.now(), url: window.location.href })
    }, true)
  }
}

// ── Assertion pick overlay script ─────────────────────────────────────────────
//
// Injected via page.evaluate() when user clicks one of the assertion buttons.
// Creates a transparent full-screen overlay that intercepts mouse events:
//   - mousemove: highlights the element underneath via CSS outline + tooltip
//   - click: captures selector/locator/value, removes overlay, calls __flowtest_assert_report
//   - Escape: removes overlay, calls __flowtest_assert_cancel

export type AssertPickType = 'assertVisible' | 'assertText' | 'assertValue'

export interface AssertPickResult {
  type: AssertPickType
  selector: string
  locatorExpr: string
  value?: string
  url: string
}

export function generateAssertDescription(data: AssertPickResult): string {
  // Extract a human-readable label from the locatorExpr
  const q = `['"]([^'"]+)['"]`
  const patterns = [
    new RegExp(`\\bname:\\s*${q}`),
    new RegExp(`getByRole[^(]*\\([^,]+,\\s*\\{[^}]*name:\\s*${q}`),
    new RegExp(`getByLabel\\(${q}`),
    new RegExp(`getByPlaceholder\\(${q}`),
    new RegExp(`getByTestId\\(${q}`),
    new RegExp(`getByText\\(${q}`),
    new RegExp(`getByRole\\(${q}`),
  ]
  let label = data.locatorExpr
  for (const re of patterns) {
    const m = data.locatorExpr.match(re)
    if (m) { label = m[1]; break }
  }
  if (label === data.locatorExpr && data.selector) label = data.selector

  switch (data.type) {
    case 'assertVisible': return `驗證「${label}」可見`
    case 'assertText':    return `驗證「${label}」文字包含「${data.value ?? ''}」`
    case 'assertValue':   return `驗證「${label}」值為「${data.value ?? ''}」`
  }
}

export function getAssertionPickScript(assertionType: AssertPickType): string {
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
})();`
}

export function getCursorHighlightScript(): string {
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
})()`
}

// Converts a raw browser event into an Action. Returns null for unknown kinds.
export function buildAction(raw: RawEvent): Action | null {
  let type: Action['type']
  let value: string | undefined

  switch (raw.kind) {
    case 'click':        type = 'click'; break
    case 'fill':         type = 'fill';         value = raw.value; break
    case 'selectOption': type = 'selectOption'; value = raw.value; break
    case 'check':        type = 'check'; break
    case 'uncheck':      type = 'uncheck'; break
    case 'press':        type = 'press';        value = raw.value; break
    default:             return null
  }

  return {
    id: uuidv4(),
    type,
    selector: raw.selector,
    locatorExpr: raw.locatorExpr,
    value,
    description: generateDescription(raw.kind, raw.label, raw.value, raw.selectedText),
    timestamp: raw.timestamp || Date.now(),
    url: raw.url,
    isPageNavigation: false,
  }
}
