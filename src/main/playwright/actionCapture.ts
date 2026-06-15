/**
 * ActionCapture — Single-Page recorder (vs CodegenCapture which takes a BrowserContext).
 * Prefer CodegenCapture for most use-cases; use this when you only have a Page.
 * Supports multiple stop()/start() cycles without re-injecting page scripts.
 */

import { Page } from 'playwright-core'
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

export class ActionCapture {
  private page: Page
  private onAction: ActionCallback
  private active = false
  private initialized = false
  private lastGotoUrl = ''
  private lastInteraction: LastInteraction | null = null

  constructor(page: Page, onAction: ActionCallback) {
    this.page = page
    this.onAction = onAction
  }

  async start(): Promise<void> {
    this.active = true
    this.lastGotoUrl = ''
    this.lastInteraction = null

    // Scripts are only injected once; subsequent start() calls just re-activate.
    if (this.initialized) return
    this.initialized = true

    const initScript = getBrowserInitScript()
    if (initScript) {
      await this.page.addInitScript(initScript)
    }

    await this.page.addInitScript(getDOMCaptureScript())

    await this.page.exposeFunction('__flowtest_report', (raw: RawEvent) => {
      if (!this.active) return
      const action = buildAction(raw)
      if (action) {
        this.lastInteraction = { time: Date.now(), type: action.type }
        this.onAction(action)
      }
    })

    this.page.on('framenavigated', (frame) => {
      if (!this.active || frame !== this.page.mainFrame()) return
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

  stop(): void {
    this.active = false
  }
}
