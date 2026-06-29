import { BrowserContext } from 'playwright-core'
import { v4 as uuidv4 } from 'uuid'
import type { Action, LocatorOption } from '../../shared/types'
import {
  type ActionCallback,
  type RawEvent,
  type LastInteraction,
  type AssertPickType,
  type AssertPickResult,
  getBrowserInitScript,
  getDOMCaptureScript,
  getCursorHighlightScript,
  buildAction,
  shouldSuppressNav,
  getAssertionPickScript,
  getAssertionToolbarScript,
  getLocatorPickerScript,
  generateAssertDescription,
} from './captureShared'

export class CodegenCapture {
  private context: BrowserContext
  private onAction: ActionCallback
  private active = false
  private paused = false
  private lastGotoUrl = ''
  private lastInteraction: LastInteraction | null = null
  private assertCancelCb: (() => void) | null = null
  private pendingInputClick: Action | null = null
  private pendingLocatorPick: { action: Action; alternatives: LocatorOption[] } | null = null

  constructor(context: BrowserContext, onAction: ActionCallback) {
    this.context = context
    this.onAction = onAction
  }

  async start(): Promise<void> {
    this.active = true
    this.lastGotoUrl = ''
    this.lastInteraction = null

    const pages = this.context.pages()
    const page = pages[0]
    if (!page) throw new Error('No page available in browser context')

    // Step 1 — Inject Playwright's InjectedScript + window.__ftGetLocator
    const initScript = getBrowserInitScript()
    if (initScript) {
      await page.addInitScript(initScript)
      // addInitScript only runs on future navigations; evaluate immediately so
      // branch recording (page already loaded, no upcoming navigation) works too.
      await page.evaluate(initScript).catch(() => {})
    }

    // Step 2 — DOM event capture handlers
    const captureScript = getDOMCaptureScript()
    await page.addInitScript(captureScript)
    // Same as above: evaluate immediately so DOM listeners are active right now
    // even when the page is already loaded (branch recording scenario).
    await page.evaluate(captureScript).catch(() => {})

    // Step 3 — Cursor highlight overlay (follows mouse, pointer-events:none)
    const cursorScript = getCursorHighlightScript()
    await page.addInitScript(cursorScript)
    await page.evaluate(cursorScript).catch(() => {})

    // Step 3b — Assertion functions + right-edge assertion dock.
    // The browser is relaunched fresh on every recording start, so exposeFunction
    // is safe to call unconditionally here (no double-registration risk).
    await page.exposeFunction('__flowtest_assert_report', (data: AssertPickResult) => {
      const action: Action = {
        id: uuidv4(),
        type: data.type,
        selector: data.selector,
        locatorExpr: data.locatorExpr,
        value: data.value,
        description: generateAssertDescription(data),
        timestamp: Date.now(),
        url: data.url,
        isPageNavigation: false,
      }
      this.onAction(action)
    })
    await page.exposeFunction('__flowtest_assert_cancel', () => {
      // Dock restores its own UI in-page; nothing to do on the Node side.
      this.assertCancelCb?.()
    })

    // Resolves the in-browser "選擇 Locator 方式" picker (Cell vs Row).
    await page.exposeFunction('__flowtest_locator_resolved', (index: number) => {
      const pending = this.pendingLocatorPick
      this.pendingLocatorPick = null
      this.resume()
      if (!pending) return
      const chosen = pending.alternatives[index] ?? pending.alternatives[0]
      const finalAction: Action = {
        ...pending.action,
        locatorExpr: chosen.expr,
        description: index === 0 ? pending.action.description : deriveRowDescription(chosen.expr),
      }
      this.onAction(finalAction)
    })

    const toolbarScript = getAssertionToolbarScript()
    await page.addInitScript(toolbarScript)
    await page.evaluate(toolbarScript).catch(() => {})

    // Step 4 — Expose report channel to browser
    await page.exposeFunction('__flowtest_report', (raw: RawEvent) => {
      if (!this.active || this.paused) return
      const action = buildAction(raw)
      if (!action) return

      if (raw.isInputClick) {
        // Buffer the click — keep it only if no fill on the same element follows.
        // Flush any previously buffered click first (user clicked a different input).
        this.flushPendingInputClick()
        this.pendingInputClick = action
        this.lastInteraction = { time: Date.now(), type: action.type }
        return
      }

      if (action.type === 'fill' && this.pendingInputClick?.selector === action.selector) {
        // Fill on the same element → this was just a focus click before typing; discard it.
        this.pendingInputClick = null
      } else {
        // Any other action → flush the buffered click first (e.g., user opened a dropdown).
        this.flushPendingInputClick()
      }

      this.lastInteraction = { time: Date.now(), type: action.type }
      if (raw.alternativeLocators?.length) {
        // Repeated table/list item → let the user pick Cell vs Row in-browser.
        this.showLocatorPicker(action, raw.alternativeLocators)
      } else {
        this.onAction(action)
      }
    })

    // Step 5 — Navigation
    // Mirrors Playwright's RecorderSignalProcessor: navigation within NAV_SUPPRESSION_MS
    // after a click/press/fill is a redirect side-effect and must NOT generate a goto node.
    // The 50 ms delay lets pending IPC round-trips (from browser → Node.js) settle first,
    // so that SPA navigations (which fire framenavigated before the IPC arrives) are also
    // correctly suppressed.
    page.on('framenavigated', (frame) => {
      if (!this.active || frame !== page.mainFrame()) return
      const url = frame.url()
      if (!url || url === 'about:blank' || url === this.lastGotoUrl) return
      this.lastGotoUrl = url
      const navigationTime = Date.now()
      setTimeout(() => {
        if (!this.active) return
        if (shouldSuppressNav(navigationTime, this.lastInteraction)) return
        this.onAction({
          id: uuidv4(),
          type: 'goto',
          selector: '',
          value: url,
          description: `導航到 ${url}`,
          timestamp: navigationTime,
          url,
          isPageNavigation: true,
        } as Action)
      }, 50)
    })
  }

  private flushPendingInputClick(): void {
    if (this.pendingInputClick) {
      this.onAction(this.pendingInputClick)
      this.pendingInputClick = null
    }
  }

  pause(): void  { this.paused = true }
  resume(): void { this.paused = false }

  async stop(): Promise<void> {
    this.pendingInputClick = null
    this.active = false
    this.paused = false

    this.pendingLocatorPick = null

    // Remove the in-page assertion dock + any leftover picker overlay/dialog.
    const page = this.context.pages()[0]
    if (page) {
      await page
        .evaluate(() => {
          ;['__ft_assert_toolbar', '__ft_pick_overlay', '__ft_pick_tooltip', '__ft_locator_picker'].forEach(
            (id) => {
              document.getElementById(id)?.remove()
            },
          )
        })
        .catch(() => {})
    }
  }

  // Shows the in-browser "選擇 Locator 方式" dialog and pauses recording until the
  // user confirms (resolved via the exposed __flowtest_locator_resolved function).
  private showLocatorPicker(action: Action, alternatives: LocatorOption[]): void {
    const page = this.context.pages()[0]
    if (!page) {
      // No page to render the dialog — fall back to the default (Cell) locator.
      this.onAction(action)
      return
    }
    this.pendingLocatorPick = { action, alternatives }
    this.pause()
    page.evaluate(getLocatorPickerScript(alternatives)).catch(() => {})
  }

  // Backward-compat entry point. The assertion dock now drives picking in-page;
  // this re-triggers the same in-page overlay for the legacy IPC path.
  async startAssertionPick(assertionType: AssertPickType, onCancel: () => void): Promise<void> {
    const page = this.context.pages()[0]
    if (!page) return
    this.assertCancelCb = onCancel
    await page.evaluate(getAssertionPickScript(assertionType)).catch(() => {})
  }
}

/** Mirrors LocatorPickerModal's deriveDescription: `點擊第 N 列 (row)`. */
function deriveRowDescription(expr: string): string {
  const m = expr.match(/\.nth\((\d+)\)/)
  const rowNum = m ? parseInt(m[1], 10) + 1 : 1
  return `點擊第 ${rowNum} 列 (row)`
}
