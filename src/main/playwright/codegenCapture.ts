import { BrowserContext, Frame, Page } from 'playwright-core'
import { v4 as uuidv4 } from 'uuid'
import type { Action, ActionUpdatedPayload, LocatorOption } from '../../shared/types'
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

// How long a plain single click stays buffered waiting for a possible dblclick
// (mirrors Playwright's 200 ms pending-click merge, with margin for IPC latency).
const DBLCLICK_MERGE_MS = 350

// How long after an action was emitted a new page can still be attributed to it
// as a popup (ACTION_UPDATED retro-patch window).
const OPENS_PAGE_WINDOW_MS = 1_000

export type ActionUpdatedCallback = (payload: ActionUpdatedPayload) => void

/** Wrap a self-executing script so it only runs in the top frame (dock/cursor UI
 *  must not render inside iframes — context init scripts run in every frame). */
function topFrameOnly(script: string): string {
  return `(function(){ try { if (window.self !== window.top) return; } catch (e) { return; } ${script} })()`
}

export class CodegenCapture {
  private context: BrowserContext
  private onAction: ActionCallback
  private onActionUpdated: ActionUpdatedCallback | null
  private active = false
  private paused = false
  private lastInteraction: LastInteraction | null = null
  private assertCancelCb: (() => void) | null = null
  /** One-slot action buffer. Input clicks wait for a possible fill (no timer);
   *  plain left clicks wait DBLCLICK_MERGE_MS for a possible dblclick. */
  private pendingAction: { action: Action; isInputClick: boolean; timer: ReturnType<typeof setTimeout> | null } | null = null
  private pendingLocatorPick: { action: Action; alternatives: LocatorOption[]; page: Page } | null = null
  /** Last emitted action — a popup arriving shortly after can still be attributed to it. */
  private lastEmitted: { action: Action; time: number } | null = null
  /** Page → alias. The initial page maps to '' (actions carry no pageAlias). */
  private pageAliases = new Map<Page, string>()
  private nextPageOrdinal = 1
  private lastGotoUrlByPage = new Map<Page, string>()
  /** Frame → iframe locator chain (top → innermost); invalidated on detach/navigation. */
  private frameChainCache = new Map<Frame, string[]>()

  constructor(context: BrowserContext, onAction: ActionCallback, onActionUpdated?: ActionUpdatedCallback) {
    this.context = context
    this.onAction = onAction
    this.onActionUpdated = onActionUpdated ?? null
  }

  async start(): Promise<void> {
    this.active = true
    this.lastInteraction = null
    this.lastEmitted = null
    this.pageAliases.clear()
    this.lastGotoUrlByPage.clear()
    this.frameChainCache.clear()
    this.nextPageOrdinal = 1

    const pages = this.context.pages()
    const page = pages[0]
    if (!page) throw new Error('No page available in browser context')
    this.pageAliases.set(page, '')

    // ── Bindings (context-level: available on every page & frame) ─────────
    // The browser is relaunched fresh on every recording start, so exposeBinding
    // is safe to call unconditionally here (no double-registration risk).
    await this.context.exposeBinding('__flowtest_assert_report', async ({ page: srcPage, frame }, data: AssertPickResult) => {
      const srcAlias = this.pageAliases.get(srcPage)
      const framePath = await this.frameLocatorChain(frame, srcPage)
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
        ...(srcAlias ? { pageAlias: srcAlias } : {}),
        ...(framePath.length ? { framePath } : {}),
      }
      this.emitAction(action)
    })
    await this.context.exposeBinding('__flowtest_assert_cancel', () => {
      // Dock restores its own UI in-page; nothing to do on the Node side.
      this.assertCancelCb?.()
    })

    // Resolves the in-browser "選擇 Locator 方式" picker (Cell vs Row).
    await this.context.exposeBinding('__flowtest_locator_resolved', (_source, index: number) => {
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
      this.emitAction(finalAction)
    })

    // Report channel — source.page/source.frame tell us where the event came from.
    await this.context.exposeBinding('__flowtest_report', async ({ page: srcPage, frame }, raw: RawEvent) => {
      const framePath = await this.frameLocatorChain(frame, srcPage)
      this.handleRawEvent(srcPage, raw, framePath.length ? framePath : undefined)
    })

    // ── Init scripts (context-level: injected into every current & future page) ──
    const initScript = getBrowserInitScript()
    if (initScript) await this.context.addInitScript(initScript)

    const captureScript = getDOMCaptureScript()
    await this.context.addInitScript(captureScript)

    const cursorScript = topFrameOnly(getCursorHighlightScript())
    await this.context.addInitScript(cursorScript)

    const toolbarScript = topFrameOnly(getAssertionToolbarScript())
    await this.context.addInitScript(toolbarScript)

    // addInitScript only runs on future navigations; evaluate immediately so
    // branch recording (page already loaded, no upcoming navigation) works too.
    if (initScript) await page.evaluate(initScript).catch(() => {})
    await page.evaluate(captureScript).catch(() => {})
    await page.evaluate(cursorScript).catch(() => {})
    await page.evaluate(toolbarScript).catch(() => {})

    // ── Navigation (per page) ──────────────────────────────────────────────
    this.attachNavListener(page)

    // ── New pages (popup / window.open / target=_blank) ────────────────────
    this.context.on('page', (newPage) => {
      if (!this.active) return
      const alias = `page${this.nextPageOrdinal++}`
      this.pageAliases.set(newPage, alias)
      this.attachNavListener(newPage)
      this.attributeOpensPage(alias)
    })
  }

  /** Mirrors Playwright's RecorderSignalProcessor: navigation within NAV_SUPPRESSION_MS
   *  after a click/press/fill is a redirect side-effect and must NOT generate a goto node.
   *  The 50 ms delay lets pending IPC round-trips (from browser → Node.js) settle first,
   *  so that SPA navigations (which fire framenavigated before the IPC arrives) are also
   *  correctly suppressed. A popup's first navigation is likewise suppressed because the
   *  triggering click sits within the suppression window. */
  private attachNavListener(page: Page): void {
    page.on('framedetached', (frame) => this.frameChainCache.delete(frame))
    page.on('framenavigated', (frame) => {
      this.frameChainCache.delete(frame)
      if (!this.active || frame !== page.mainFrame()) return
      const url = frame.url()
      if (!url || url === 'about:blank' || url === this.lastGotoUrlByPage.get(page)) return
      this.lastGotoUrlByPage.set(page, url)
      const navigationTime = Date.now()
      setTimeout(() => {
        if (!this.active) return
        if (shouldSuppressNav(navigationTime, this.lastInteraction)) return
        const alias = this.pageAliases.get(page)
        this.emitAction({
          id: uuidv4(),
          type: 'goto',
          selector: '',
          value: url,
          description: `導航到 ${url}`,
          timestamp: navigationTime,
          url,
          isPageNavigation: true,
          ...(alias ? { pageAlias: alias } : {}),
        } as Action)
      }, 50)
    })
  }

  /** Attribute a freshly opened page to the click/press that triggered it:
   *  stamp the buffered action if one is pending, otherwise retro-patch the
   *  last emitted action via ACTION_UPDATED (renderer updates the node). */
  private attributeOpensPage(alias: string): void {
    if (this.pendingAction && ['click', 'press'].includes(this.pendingAction.action.type)) {
      this.pendingAction.action.opensPage = alias
      return
    }
    if (
      this.lastEmitted &&
      ['click', 'press'].includes(this.lastEmitted.action.type) &&
      Date.now() - this.lastEmitted.time < OPENS_PAGE_WINDOW_MS
    ) {
      this.onActionUpdated?.({ actionId: this.lastEmitted.action.id, updates: { opensPage: alias } })
    }
  }

  /** Build the iframe locator chain (top → innermost) for a frame, using the same
   *  __ftGetLocator quality as element locators. Cached per Frame; falls back to
   *  iframe[name=…]/iframe[src=…] when the frame element can't be resolved. */
  private async frameLocatorChain(frame: Frame, page: Page): Promise<string[]> {
    if (frame === page.mainFrame()) return []
    const cached = this.frameChainCache.get(frame)
    if (cached) return cached

    const chain: string[] = []
    let cur: Frame | null = frame
    while (cur && cur !== page.mainFrame()) {
      const parent = cur.parentFrame()
      if (!parent) break
      let expr: string | null = null
      try {
        const handle = await cur.frameElement()
        expr = await parent.evaluate(
          (el) => {
            try { return ((window as any).__ftGetLocator?.(el) as string | null) ?? null } catch { return null }
          },
          handle,
        )
        await handle.dispose()
      } catch { /* detached or sandboxed frame — fall back below */ }
      if (!expr) {
        const name = cur.name()
        expr = name
          ? `locator('iframe[name="${name.replace(/"/g, '\\"')}"]')`
          : `locator('iframe[src="${cur.url().replace(/"/g, '\\"')}"]')`
      }
      chain.unshift(expr)
      cur = parent
    }

    this.frameChainCache.set(frame, chain)
    return chain
  }

  private handleRawEvent(srcPage: Page, raw: RawEvent, framePath?: string[]): void {
    if (!this.active || this.paused) return
    const action = buildAction(raw)
    if (!action) return

    const alias = this.pageAliases.get(srcPage)
    if (alias) action.pageAlias = alias
    if (framePath?.length) action.framePath = framePath

    // Double-click merge: the DOM fires click → dblclick, so a dblclick report on
    // the same element supersedes the buffered single click (mirrors Playwright's
    // pending-click cancellation).
    if (
      action.type === 'click' &&
      (action.clickCount ?? 1) >= 2 &&
      this.pendingAction?.action.type === 'click' &&
      this.pendingAction.action.selector === action.selector
    ) {
      // Carry over a popup attribution the buffered click may have received.
      if (this.pendingAction.action.opensPage) action.opensPage = this.pendingAction.action.opensPage
      this.discardPendingAction()
    }

    if (raw.isInputClick) {
      // Buffer the click — keep it only if no fill on the same element follows.
      // Flush any previously buffered action first (user clicked a different input).
      this.setPendingAction(action, true)
      this.lastInteraction = { time: Date.now(), type: action.type }
      return
    }

    if (action.type === 'fill' && this.pendingAction?.isInputClick && this.pendingAction.action.selector === action.selector) {
      // Fill on the same element → this was just a focus click before typing; discard it.
      this.discardPendingAction()
    } else {
      // Any other action → flush the buffered action first (e.g., user opened a dropdown).
      this.flushPendingAction()
    }

    this.lastInteraction = { time: Date.now(), type: action.type }
    if (raw.alternativeLocators?.length) {
      // Repeated table/list item → let the user pick Cell vs Row in-browser.
      this.showLocatorPicker(action, raw.alternativeLocators, srcPage)
      return
    }

    // Plain left single clicks are buffered briefly so a following dblclick can merge
    // (and so a popup event can stamp opensPage before emission).
    if (action.type === 'click' && (action.clickCount ?? 1) === 1 && !action.button) {
      this.setPendingAction(action, false)
      return
    }

    this.emitAction(action)
  }

  private emitAction(action: Action): void {
    this.lastEmitted = { action, time: Date.now() }
    this.onAction(action)
  }

  private setPendingAction(action: Action, isInputClick: boolean): void {
    this.flushPendingAction()
    const timer = isInputClick ? null : setTimeout(() => this.flushPendingAction(), DBLCLICK_MERGE_MS)
    this.pendingAction = { action, isInputClick, timer }
  }

  private flushPendingAction(): void {
    if (!this.pendingAction) return
    if (this.pendingAction.timer) clearTimeout(this.pendingAction.timer)
    const { action } = this.pendingAction
    this.pendingAction = null
    this.emitAction(action)
  }

  private discardPendingAction(): void {
    if (!this.pendingAction) return
    if (this.pendingAction.timer) clearTimeout(this.pendingAction.timer)
    this.pendingAction = null
  }

  pause(): void  { this.paused = true }
  resume(): void { this.paused = false }

  async stop(): Promise<void> {
    // Input clicks were only ever kept when no fill followed — discard on stop
    // (pre-existing behavior). Plain buffered clicks are real actions: flush them.
    if (this.pendingAction?.isInputClick) this.discardPendingAction()
    else this.flushPendingAction()
    this.active = false
    this.paused = false

    this.pendingLocatorPick = null

    // Remove the in-page assertion dock + any leftover picker overlay/dialog on every page.
    for (const page of this.context.pages()) {
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

    this.pageAliases.clear()
    this.lastGotoUrlByPage.clear()
    this.frameChainCache.clear()
  }

  // Shows the in-browser "選擇 Locator 方式" dialog and pauses recording until the
  // user confirms (resolved via the exposed __flowtest_locator_resolved binding).
  private showLocatorPicker(action: Action, alternatives: LocatorOption[], page: Page): void {
    this.pendingLocatorPick = { action, alternatives, page }
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
