/**
 * ActionCapture — Single-Page recorder (vs CodegenCapture which takes a BrowserContext).
 * Uses the same Playwright InjectedScript injection for selector generation.
 * Prefer CodegenCapture for most use-cases; use this when you only have a Page.
 */

import { Page } from 'playwright-core'
import { v4 as uuidv4 } from 'uuid'
import * as fs from 'fs'
import * as vm from 'vm'
import * as path from 'path'
import { createRequire } from 'module'
import type { Action } from '../../shared/types'

type ActionCallback = (action: Action) => void

interface RawEvent {
  kind: 'click' | 'fill' | 'selectOption' | 'check' | 'uncheck' | 'press'
  locatorExpr: string
  selector: string
  label: string
  value?: string
  selectedText?: string
  timestamp: number
  url: string
}

function generateDescription(kind: RawEvent['kind'], label: string, value?: string, selectedText?: string): string {
  switch (kind) {
    case 'click':        return `點擊「${label}」`
    case 'fill':         return `填入「${value ?? ''}」到「${label}」`
    case 'selectOption': return `選擇「${selectedText ?? value ?? ''}」from「${label}」`
    case 'check':        return `勾選「${label}」`
    case 'uncheck':      return `取消勾選「${label}」`
    case 'press':        return `在「${label}」按下 ${value}`
  }
}

function extractSource3(): string {
  const _req = createRequire(import.meta.url)
  let coreBundlePath: string
  try {
    coreBundlePath = _req.resolve('playwright-core/lib/coreBundle.js')
  } catch {
    coreBundlePath = path.join(process.cwd(), 'node_modules', 'playwright-core', 'lib', 'coreBundle.js')
  }
  const src = fs.readFileSync(coreBundlePath, 'utf8')
  const startMarker = "source3 = '"
  const markerIdx = src.indexOf(startMarker)
  if (markerIdx < 0) throw new Error('[FlowTest] Could not locate source3 in playwright-core/lib/coreBundle.js')
  const contentStart = markerIdx + startMarker.length

  let firstNewline = -1
  for (let i = contentStart; i < src.length; i++) {
    if (src.charCodeAt(i) === 10) { firstNewline = i; break }
  }
  if (firstNewline < 0) throw new Error('[FlowTest] Could not find end of source3 in coreBundle.js')

  const escaped = src.slice(contentStart, firstNewline - 2)
  return vm.runInNewContext(`'${escaped}'`) as string
}

let _initScript: string | null = null

function getBrowserInitScript(): string {
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
    console.warn('[FlowTest] Playwright InjectedScript extraction failed:', e)
    _initScript = ''
  }
  return _initScript
}

export class ActionCapture {
  private page: Page
  private onAction: ActionCallback
  private active = false
  private initialized = false
  private lastGotoUrl = ''

  constructor(page: Page, onAction: ActionCallback) {
    this.page = page
    this.onAction = onAction
  }

  async start(): Promise<void> {
    this.active = true
    this.lastGotoUrl = ''

    if (this.initialized) return
    this.initialized = true

    const initScript = getBrowserInitScript()
    if (initScript) {
      await this.page.addInitScript(initScript)
    }

    await this.page.addInitScript(() => {

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
        const patterns = [
          /name:\s*"((?:[^"\\]|\\.)*)"/,
          /getByLabel\("((?:[^"\\]|\\.)*)"/,
          /getByPlaceholder\("((?:[^"\\]|\\.)*)"/,
          /getByTestId\("((?:[^"\\]|\\.)*)"/,
          /getByText\("((?:[^"\\]|\\.)*)"/,
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

      document.addEventListener('click', (e: MouseEvent) => {
        let el = e.target as Element
        if (!el?.tagName) return
        if (isTextInput(el)) return
        if (el.tagName.toLowerCase() === 'select') return

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

      document.addEventListener('change', (e: Event) => {
        const el = e.target as HTMLSelectElement
        if (el.tagName.toLowerCase() !== 'select') return
        const opt = el.options[el.selectedIndex]
        const locatorExpr = getLocatorExpr(el)
        report({ kind: 'selectOption', locatorExpr, selector: generateCSSSelector(el), label: extractLabel(locatorExpr, el), value: el.value, selectedText: opt?.text?.trim(), timestamp: Date.now(), url: window.location.href })
      }, true)

      document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (!['Enter', 'Escape'].includes(e.key)) return
        const el = e.target as Element
        if (!el?.tagName) return
        if (e.key === 'Enter' && el.tagName.toLowerCase() === 'textarea' && !e.ctrlKey && !e.metaKey) return
        if (!isTextInput(el) && !['button', 'a', 'select'].includes(el.tagName.toLowerCase())) return
        const locatorExpr = getLocatorExpr(el)
        report({ kind: 'press', locatorExpr, selector: generateCSSSelector(el), label: extractLabel(locatorExpr, el), value: e.key, timestamp: Date.now(), url: window.location.href })
      }, true)
    })

    await this.page.exposeFunction('__flowtest_report', (raw: RawEvent) => {
      if (!this.active) return
      this.processEvent(raw)
    })

    this.page.on('framenavigated', (frame) => {
      if (!this.active || frame !== this.page.mainFrame()) return
      const url = frame.url()
      if (!url || url === 'about:blank' || url === this.lastGotoUrl) return
      this.lastGotoUrl = url
      this.onAction({
        id: uuidv4(),
        type: 'goto',
        selector: '',
        value: url,
        description: `導航到 ${url}`,
        timestamp: Date.now(),
        url,
        isPageNavigation: true,
      })
    })
  }

  stop(): void {
    this.active = false
  }

  private processEvent(raw: RawEvent): void {
    let type: Action['type']
    let value: string | undefined
    switch (raw.kind) {
      case 'click':        type = 'click'; break
      case 'fill':         type = 'fill';         value = raw.value; break
      case 'selectOption': type = 'selectOption'; value = raw.value; break
      case 'check':        type = 'check'; break
      case 'uncheck':      type = 'uncheck'; break
      case 'press':        type = 'press';        value = raw.value; break
      default: return
    }
    this.onAction({
      id: uuidv4(),
      type,
      selector: raw.selector,
      locatorExpr: raw.locatorExpr,
      value,
      description: generateDescription(raw.kind, raw.label, raw.value, raw.selectedText),
      timestamp: raw.timestamp || Date.now(),
      url: raw.url,
      isPageNavigation: false,
    })
  }
}
