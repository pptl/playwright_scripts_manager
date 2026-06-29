import { v4 as uuidv4 } from 'uuid'
import * as fs from 'fs'
import * as vm from 'vm'
import * as path from 'path'
import { createRequire } from 'module'
import type { Action, LocatorOption } from '../../shared/types'

export type ActionCallback = (action: Action, alternatives?: LocatorOption[]) => void

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
  alternativeLocators?: LocatorOption[]
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
//
// Event filtering mirrors Playwright's RecordActionTool / JsonRecordActionTool:
//   Click  — blacklist (only skip SELECT/OPTION/date/range/html/body), not whitelist
//   Fill   — blur-based value capture for text inputs AND contentEditable
//   Select — native <select> change event
//   Press  — matches Playwright's _shouldGenerateKeyPressFor (Tab, Arrow, F-keys,
//             modifier+char, Enter outside textarea; excludes Backspace/Delete/paste)
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

    function isContentEditable(el: Element): boolean {
      return (el as HTMLElement).isContentEditable === true
    }

    // Use composedPath to pierce Shadow DOM, matching Playwright's deepEventTarget().
    function getTarget(e: Event): Element | null {
      const path = e.composedPath()
      return (path.length > 0 ? path[0] : e.target) as Element | null
    }

    function report(data: object): void {
      try { ;(window as any).__flowtest_report(data) } catch (_) { /* ignore */ }
    }

    const focusValues = new WeakMap<Element, string>()

    // ── Click ─────────────────────────────────────────────────────────────
    // Blacklist approach matching Playwright's _shouldIgnoreMouseEvent:
    // Record ANY element click EXCEPT SELECT/OPTION/html/body/date/range inputs.
    document.addEventListener('click', (e: MouseEvent) => {
      let el = getTarget(e) as Element
      if (!el?.tagName) return

      const tag = el.tagName.toLowerCase()
      const type = ((el as HTMLInputElement).type || '').toLowerCase()

      // Skip FlowTest-injected UI (assertion dock, picker overlay, cursor highlight).
      // Check the element itself AND any ancestor, since the dock's buttons have no
      // id of their own — they live inside #__ft_assert_toolbar.
      if ((el as HTMLElement).id?.startsWith('__ft_')) return
      if ((el as HTMLElement).closest?.('[id^="__ft_"]')) return

      // Playwright blacklist
      if (tag === 'select' || tag === 'option') return
      if (tag === 'input' && (type === 'date' || type === 'range')) return
      if (tag === 'html' || tag === 'body') return

      // Text inputs: report with isInputClick so a subsequent fill can suppress it
      if (isTextInput(el)) {
        const locatorExpr = getLocatorExpr(el)
        const label = extractLabel(locatorExpr, el)
        report({ kind: 'click', locatorExpr, selector: generateCSSSelector(el), label, timestamp: Date.now(), url: window.location.href, isInputClick: true })
        return
      }

      // Checkbox / radio → check / uncheck
      if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
        const locatorExpr = getLocatorExpr(el)
        const label = extractLabel(locatorExpr, el)
        report({ kind: (el as HTMLInputElement).checked ? 'check' : 'uncheck', locatorExpr, selector: generateCSSSelector(el), label, timestamp: Date.now(), url: window.location.href })
        return
      }

      // Bubble up to nearest <button> or <a> only for better locator quality —
      // not as a filter. Any other element still gets recorded.
      let cur: Element | null = el
      while (cur) {
        const t = cur.tagName.toLowerCase()
        if (t === 'button' || t === 'a') { el = cur; break }
        if (t === 'html' || t === 'body') break
        cur = cur.parentElement
      }

      const locatorExpr = getLocatorExpr(el)
      const label = extractLabel(locatorExpr, el)

      // Table cell detection: offer row-based alternative locators
      let alternativeLocators: { label: string, expr: string }[] | undefined
      const tr = (el as HTMLElement).closest?.('tr')
      if (tr && tr.parentElement) {
        const rows = Array.from(tr.parentElement.children).filter(
          (c) => c.tagName === 'TR'
        )
        const rowIndex = rows.indexOf(tr)
        if (rowIndex >= 0) {
          // Scope to the actual parent section (tbody/thead/tfoot) so rowIndex is correct
          // even when a <thead> exists — getByRole('row') would include header rows in the count
          const parentTag = (tr.parentElement.tagName || 'tbody').toLowerCase()

          // Scope to the specific <table> when multiple tables exist on the page,
          // so nth(rowIndex) doesn't accidentally match a row in a different table.
          const table = tr.closest?.('table')
          let rowExpr: string
          if (table) {
            const allTables = Array.from(document.querySelectorAll('table'))
            const tableIndex = allTables.indexOf(table as HTMLTableElement)
            if (tableIndex >= 0 && allTables.length > 1) {
              rowExpr = `locator('table').nth(${tableIndex}).locator('${parentTag} tr').nth(${rowIndex})`
            } else {
              rowExpr = `locator('${parentTag} tr').nth(${rowIndex})`
            }
          } else {
            rowExpr = `locator('${parentTag} tr').nth(${rowIndex})`
          }

          alternativeLocators = [
            { label: `Cell — ${locatorExpr}`, expr: locatorExpr },
            { label: `Row ${rowIndex + 1} (nth) — ${rowExpr}`, expr: rowExpr },
          ]
        }
      }

      report({ kind: 'click', locatorExpr, selector: generateCSSSelector(el), label, timestamp: Date.now(), url: window.location.href, alternativeLocators })
    }, true)

    // ── Fill: emit on blur when value changed ──────────────────────────────
    // Covers text inputs and contentEditable elements (matches Playwright onInput/onFocus).
    document.addEventListener('focus', (e: FocusEvent) => {
      const el = getTarget(e) as Element
      if (!el?.tagName) return
      if (!isTextInput(el) && !isContentEditable(el)) return
      const value = isContentEditable(el)
        ? (el as HTMLElement).innerText
        : (el as HTMLInputElement).value ?? ''
      focusValues.set(el, value)
    }, true)

    document.addEventListener('blur', (e: FocusEvent) => {
      const el = getTarget(e) as Element
      if (!el?.tagName) return
      if (!isTextInput(el) && !isContentEditable(el)) return
      const initial = focusValues.get(el)
      const current = isContentEditable(el)
        ? (el as HTMLElement).innerText
        : (el as HTMLInputElement).value ?? ''
      focusValues.delete(el)
      if (initial === undefined || current === initial) return
      const locatorExpr = getLocatorExpr(el)
      report({ kind: 'fill', locatorExpr, selector: generateCSSSelector(el), label: extractLabel(locatorExpr, el), value: current, timestamp: Date.now(), url: window.location.href })
    }, true)

    // ── SelectOption ───────────────────────────────────────────────────────
    document.addEventListener('change', (e: Event) => {
      const el = getTarget(e) as HTMLSelectElement
      if (!el?.tagName || el.tagName.toLowerCase() !== 'select') return
      const opt = el.options[el.selectedIndex]
      const locatorExpr = getLocatorExpr(el)
      report({ kind: 'selectOption', locatorExpr, selector: generateCSSSelector(el), label: extractLabel(locatorExpr, el), value: el.value, selectedText: opt?.text?.trim(), timestamp: Date.now(), url: window.location.href })
    }, true)

    // ── Press: matches Playwright's _shouldGenerateKeyPressFor ────────────
    // Records Tab, Enter (outside textarea/contentEditable), Escape, Arrow keys,
    // F-keys, and modifier+char combos. Skips Backspace/Delete/paste shortcuts
    // and bare single-char keys (those become fill values).
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (typeof e.key !== 'string') return
      const el = getTarget(e) as Element
      if (!el?.tagName) return

      // Skip Enter inside textarea or contentEditable (it's a newline → fill)
      if (e.key === 'Enter' && (el.tagName.toLowerCase() === 'textarea' || isContentEditable(el))) return

      // Keys Playwright never records
      if (['Backspace', 'Delete', 'AltGraph'].includes(e.key)) return
      // @ on certain keyboard layouts triggers Alt+key; skip
      if (e.key === '@' && (e as any).code === 'KeyL') return
      // Paste shortcuts
      const isMac = navigator.platform.includes('Mac')
      if (isMac  && e.key === 'v' && e.metaKey) return
      if (!isMac && e.key === 'v' && e.ctrlKey) return
      if (!isMac && e.key === 'Insert' && e.shiftKey) return
      // Bare modifier keys
      if (['Shift', 'Control', 'Meta', 'Alt', 'Process'].includes(e.key)) return

      const hasModifier = e.ctrlKey || e.altKey || e.metaKey
      // Single printable char without modifier → becomes fill value, not a press
      if (e.key.length === 1 && !hasModifier) return

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

// Backward-compat entry point for the Main-process `startAssertionPick` path.
// The overlay logic now lives in `window.__ft_startAssertPick`, defined by
// getAssertionToolbarScript() (always injected during recording). This just invokes it.
export function getAssertionPickScript(assertionType: AssertPickType): string {
  return `(function(){ try { if (window.__ft_startAssertPick) window.__ft_startAssertPick(${JSON.stringify(assertionType)}); } catch(e){} })();`
}

// ── In-page assertion toolbar dock ──────────────────────────────────────────────
//
// Injected during recording. Renders a fixed dock stuck to the right edge of the
// recorded browser with three buttons (👁 可見 / T 文字 / = 值), and defines
// window.__ft_startAssertPick(type) which runs the element-picker overlay in-page.
// On pick/cancel it reports via the exposed __flowtest_assert_report /
// __flowtest_assert_cancel functions (set up by CodegenCapture at start()).
//
// The dock id starts with '__ft_', so getDOMCaptureScript()'s click blacklist
// never records dock clicks as actions.
export function getAssertionToolbarScript(): string {
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
})();`
}

// ── In-page "選擇 Locator 方式" picker ───────────────────────────────────────────
//
// Shown when a recorded click lands on a repeated table/list item that has
// alternative locators (Cell vs Row). Rendered as a modal inside the recorded
// browser; on confirm it reports the chosen index via the exposed
// __flowtest_locator_resolved function (set up by CodegenCapture at start()).
//
// The backdrop id starts with '__ft_', so getDOMCaptureScript()'s blacklist never
// records clicks on it; the recorder is also paused while it is open.
export function getLocatorPickerScript(alternatives: LocatorOption[]): string {
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
