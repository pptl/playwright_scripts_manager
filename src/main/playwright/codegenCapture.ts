import { BrowserContext } from 'playwright-core'
import { v4 as uuidv4 } from 'uuid'
import type { Action } from '../../shared/types'
import {
  type ActionCallback,
  type RawEvent,
  type LastInteraction,
  getBrowserInitScript,
  getDOMCaptureScript,
  buildAction,
  shouldSuppressNav,
} from './captureShared'

export class CodegenCapture {
  private context: BrowserContext
  private onAction: ActionCallback
  private active = false
  private lastGotoUrl = ''
  private lastInteraction: LastInteraction | null = null

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

    // Step 3 — Expose report channel to browser
    await page.exposeFunction('__flowtest_report', (raw: RawEvent) => {
      if (!this.active) return
      const action = buildAction(raw)
      if (action) {
        this.lastInteraction = { time: Date.now(), type: action.type }
        this.onAction(action)
      }
    })

    // Step 4 — Navigation
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

  async stop(): Promise<void> {
    this.active = false
  }
}
