import { Page, Locator, FrameLocator } from 'playwright-core'
import type { Action, FlowNode } from '../../shared/types'
import { isCallFlowAction } from '../../shared/types'
import { resolveValueWithSession, resolveValue } from '../../shared/variableResolver'
import { getCursorHighlightScript } from './captureShared'
import { FlowStorage } from '../storage/flowStorage'

type NodeStartCallback = (nodeId: string) => void
type NodeCompleteCallback = (nodeId: string, success: boolean, error?: string) => void

export class Replayer {
  private page: Page
  private sessionVars = new Map<string, string>()
  private baseOrigin: string
  private profileVars: Record<string, string>
  private activeProfileId?: string
  private activeEnvironmentId?: string
  /** Active project's environment variables (flattened for the active environment). */
  private envVars: Record<string, string>
  /** Active project ID — env-var references only resolve for sub-flows in this project. */
  private activeProjectId?: string
  /** pageAlias → Page for popups opened during replay (shared with nested Replayers). */
  private pages: Map<string, Page>

  constructor(page: Page, baseURL = '', profileVars?: Record<string, string>, activeProfileId?: string, activeEnvironmentId?: string, envVars?: Record<string, string>, activeProjectId?: string, sharedPages?: Map<string, Page>) {
    this.page = page
    this.profileVars = profileVars ?? {}
    this.activeProfileId = activeProfileId
    this.activeEnvironmentId = activeEnvironmentId
    this.envVars = envVars ?? {}
    this.activeProjectId = activeProjectId
    this.pages = sharedPages ?? new Map()
    this.baseOrigin = (() => { try { return new URL(baseURL).origin } catch { return '' } })()
  }

  /** Resolve the page an action targets. Absent alias = the initial page. */
  private pageFor(action: Action): Page {
    if (!action.pageAlias) return this.page
    const p = this.pages.get(action.pageAlias)
    if (!p || p.isClosed()) {
      throw new Error(`頁面 "${action.pageAlias}" 尚未開啟 — 觸發開新頁的動作可能未執行或失敗`)
    }
    return p
  }

  async replayToNode(
    nodes: FlowNode[],
    targetNodeId: string,
    onNodeStart: NodeStartCallback,
    onNodeComplete: NodeCompleteCallback,
    speed = 500,
  ): Promise<void> {
    this.sessionVars.clear()
    const cursorScript = getCursorHighlightScript()
    await this.page.addInitScript(cursorScript)
    await this.page.evaluate(cursorScript).catch(() => {})
    const path = this.findPath(nodes, targetNodeId)

    for (const node of path) {
      onNodeStart(node.id)
      try {
        if (isCallFlowAction(node.action)) {
          await this.executeCallFlow(node.action, onNodeStart, onNodeComplete, speed)
        } else {
          await this.executeAction(node.action)
          if (node.action.assertion) {
            await this.executeAssertion(node.action)
          }
        }
        onNodeComplete(node.id, true)
      } catch (err) {
        onNodeComplete(node.id, false, String(err))
        throw err
      }
      await new Promise((res) => setTimeout(res, speed))
    }
  }

  getSessionVars(): Map<string, string> {
    return this.sessionVars
  }

  private async executeCallFlow(
    action: Action,
    onNodeStart: NodeStartCallback,
    onNodeComplete: NodeCompleteCallback,
    speed: number,
  ): Promise<void> {
    const subFlow = await FlowStorage.load(action.subFlowId!)
    if (!subFlow) throw new Error(`子流程 "${action.subFlowId}" 不存在`)

    // Resolve sub-flow profile: mapping takes precedence over legacy subFlowProfileId
    let resolvedSubProfileId: string | null | undefined = action.subFlowProfileId ?? null
    if (action.subFlowProfileMapping && this.activeProfileId && this.activeProfileId in action.subFlowProfileMapping) {
      resolvedSubProfileId = action.subFlowProfileMapping[this.activeProfileId]
    }

    // Env-var references ({{envKey}}) only resolve when the sub-flow belongs to the active
    // project (v1 restriction: no cross-project env-var references).
    const subFlowEnvVars =
      this.activeProjectId && subFlow.projectId === this.activeProjectId ? this.envVars : {}
    const resolveVars = (vars: import('../../shared/types').ProfileVariable[]): Record<string, string> =>
      Object.fromEntries(
        vars.map((v) => {
          const raw = (this.activeEnvironmentId && v.envValues?.[this.activeEnvironmentId]) ?? v.value
          return [v.key, resolveValue(raw, undefined, subFlowEnvVars)]
        }),
      )

    let subProfileVars: Record<string, string> = {}
    if (resolvedSubProfileId) {
      const profile = subFlow.profiles?.find((p) => p.id === resolvedSubProfileId)
      if (profile) {
        subProfileVars = resolveVars(profile.vars)
      }
    } else if (!resolvedSubProfileId && subFlow.profiles && subFlow.profiles.length > 0) {
      // Fall back to first profile when mapping resolves to null
      const firstProfile = subFlow.profiles[0]
      subProfileVars = resolveVars(firstProfile.vars)
      resolvedSubProfileId = firstProfile.id
    }

    // Pass the resolved sub-flow profile ID as the nested Replayer's activeProfileId so it
    // can resolve its own sub-flow mappings — this enables correct N-level nesting
    const nested = new Replayer(this.page, subFlow.baseURL, subProfileVars, resolvedSubProfileId ?? undefined, this.activeEnvironmentId, this.envVars, this.activeProjectId, this.pages)
    await nested.replayToNode(
      subFlow.nodes,
      action.subFlowExitNodeId!,
      onNodeStart,
      onNodeComplete,
      speed,
    )

    for (const [k, v] of nested.getSessionVars()) {
      this.sessionVars.set(k, v)
    }
  }

  /** Fold the action's framePath into a scope: page → frameLocator chain.
   *  Each entry is a locator expression for an iframe element; `.contentFrame()`
   *  turns it into the scope for the next hop (never baked into locatorExpr). */
  private scopeFor(action: Action): Page | FrameLocator {
    let scope: Page | FrameLocator = this.pageFor(action)
    for (const frameExpr of action.framePath ?? []) {
      const resolved = resolveValueWithSession(frameExpr, this.sessionVars, this.profileVars)
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function('s', `return s.${resolved}`)
      scope = (fn(scope) as Locator).contentFrame()
    }
    return scope
  }

  /**
   * Resolve a Playwright Locator from an Action.
   * Prefers locatorExpr (Codegen-quality) over the fallback CSS selector.
   */
  private getLocator(action: Action): Locator {
    const scope = this.scopeFor(action)
    if (action.locatorExpr) {
      try {
        // Resolve {{...}} variables before evaluating the locator expression
        const resolved = resolveValueWithSession(action.locatorExpr, this.sessionVars, this.profileVars)
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const fn = new Function('page', `return page.${resolved}`)
        return fn(scope) as Locator
      } catch {
        // fall through to CSS selector
      }
    }
    return scope.locator(action.selector)
  }

  private substituteOrigin(url: string): string {
    const domainOverride = this.profileVars['domain']
    if (!domainOverride || !this.baseOrigin) return url
    try {
      const parsed = new URL(url)
      if (parsed.origin === this.baseOrigin) {
        return domainOverride + parsed.pathname + parsed.search + parsed.hash
      }
    } catch {
      // not a valid URL — return as-is
    }
    return url
  }

  private async executeAction(action: Action): Promise<void> {
    const val = action.value != null
      ? resolveValueWithSession(action.value, this.sessionVars, this.profileVars)
      : undefined

    // If this action opens a popup, start waiting for the page event BEFORE executing
    // (mirrors the exported waitForEvent('popup') pattern).
    const popupPromise = action.opensPage
      ? this.pageFor(action).context().waitForEvent('page', { timeout: 15_000 })
      : null

    switch (action.type) {
      case 'goto':
        await this.pageFor(action).goto(this.substituteOrigin(val!))
        break
      case 'click': {
        const opts: { button?: 'left' | 'right' | 'middle'; modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'> } = {}
        if (action.button && action.button !== 'left') opts.button = action.button
        if (action.modifiers?.length) opts.modifiers = action.modifiers as Array<'Alt' | 'Control' | 'Meta' | 'Shift'>
        if ((action.clickCount ?? 1) >= 2) await this.getLocator(action).dblclick(opts)
        else await this.getLocator(action).click(opts)
        break
      }
      case 'fill':
        await this.getLocator(action).fill(val ?? '')
        break
      case 'selectOption':
        if (action.values?.length) {
          await this.getLocator(action).selectOption(
            action.values.map((v) => resolveValueWithSession(v, this.sessionVars, this.profileVars)),
          )
        } else {
          await this.getLocator(action).selectOption(val ?? '')
        }
        break
      case 'check':
        await this.getLocator(action).check()
        break
      case 'uncheck':
        await this.getLocator(action).uncheck()
        break
      case 'press':
        // press can be a keyboard shortcut (no locator) or locator.press()
        if (action.locatorExpr) {
          await this.getLocator(action).press(val ?? '')
        } else {
          await this.pageFor(action).keyboard.press(val ?? '')
        }
        break
      case 'upload': {
        // value holds comma-separated file paths (recorded as names; user edits to real paths)
        const files = (val ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        await this.getLocator(action).setInputFiles(files)
        break
      }
      case 'wait':
        await this.getLocator(action).waitFor({ state: 'visible' })
        break
      case 'callFlow':
        break
    }

    if (popupPromise && action.opensPage) {
      const newPage = await popupPromise
      await newPage.waitForLoadState('domcontentloaded').catch(() => {})
      this.pages.set(action.opensPage, newPage)
    }

    if (action.captureAs && val != null) {
      this.sessionVars.set(action.captureAs, val)
    }
  }

  private async executeAssertion(action: Action): Promise<void> {
    const assertion = action.assertion
    if (!assertion) return
    const TIMEOUT = 10_000
    const page = this.pageFor(action)
    // Element assertions resolve inside the action's frame scope; URL stays page-level.
    const scope = this.scopeFor(action)

    switch (assertion.type) {
      case 'text': {
        await scope.locator(assertion.target!).waitFor({ state: 'visible', timeout: TIMEOUT })
        const text = await scope.locator(assertion.target!).textContent({ timeout: TIMEOUT })
        if (!text?.includes(assertion.expected)) {
          throw new Error(
            `Assertion failed: expected text "${assertion.expected}" in "${assertion.target}", got "${text}"`,
          )
        }
        break
      }
      case 'visible': {
        const visible = await scope
          .locator(assertion.target!)
          .isVisible()
        if (!visible) {
          throw new Error(`Assertion failed: "${assertion.target}" is not visible`)
        }
        break
      }
      case 'url': {
        await page.waitForURL(new RegExp(assertion.expected), { timeout: TIMEOUT })
        break
      }
      case 'count': {
        const expected = parseInt(assertion.expected, 10)
        if (action.framePath?.length) {
          // FrameLocator has no waitForFunction — poll count() until match or timeout
          const deadline = Date.now() + TIMEOUT
          for (;;) {
            const count = await scope.locator(assertion.target!).count()
            if (count === expected) break
            if (Date.now() > deadline) {
              throw new Error(`Assertion failed: expected ${expected} of "${assertion.target}", got ${count}`)
            }
            await new Promise((res) => setTimeout(res, 200))
          }
          break
        }
        await page.waitForFunction(
          ({ sel, cnt }: { sel: string; cnt: number }) =>
            document.querySelectorAll(sel).length === cnt,
          { sel: assertion.target!, cnt: expected },
          { timeout: TIMEOUT },
        )
        break
      }
    }
  }

  private findPath(nodes: FlowNode[], targetId: string): FlowNode[] {
    // Build map — if duplicate IDs exist, last one wins (defensive)
    const nodeMap = new Map(nodes.map((n) => [n.id, n]))
    const path: FlowNode[] = []
    const visited = new Set<string>() // cycle detection

    let current = nodeMap.get(targetId)
    while (current && !visited.has(current.id)) {
      visited.add(current.id)
      path.unshift(current)
      current = current.parentId ? nodeMap.get(current.parentId) : undefined
    }

    if (path.length === 0) {
      throw new Error(`Node "${targetId}" not found or graph is empty`)
    }

    return path
  }
}
