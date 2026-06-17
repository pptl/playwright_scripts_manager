import { Page, Locator } from 'playwright-core'
import type { Action, FlowNode } from '../../shared/types'
import { resolveValueWithSession } from '../../shared/variableResolver'
import { getCursorHighlightScript } from './captureShared'

type NodeStartCallback = (nodeId: string) => void
type NodeCompleteCallback = (nodeId: string, success: boolean, error?: string) => void

export class Replayer {
  private page: Page
  private sessionVars = new Map<string, string>()
  private baseOrigin: string
  private profileVars: Record<string, string>

  constructor(page: Page, baseURL = '', profileVars?: Record<string, string>) {
    this.page = page
    this.profileVars = profileVars ?? {}
    this.baseOrigin = (() => { try { return new URL(baseURL).origin } catch { return '' } })()
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
        await this.executeAction(node.action)
        if (node.action.assertion) {
          await this.executeAssertion(node.action)
        }
        onNodeComplete(node.id, true)
      } catch (err) {
        onNodeComplete(node.id, false, String(err))
        throw err
      }
      await new Promise((res) => setTimeout(res, speed))
    }
  }

  /**
   * Resolve a Playwright Locator from an Action.
   * Prefers locatorExpr (Codegen-quality) over the fallback CSS selector.
   */
  private getLocator(action: Action): Locator {
    if (action.locatorExpr) {
      try {
        // Evaluate the locator expression against the page object
        // e.g. locatorExpr = "getByRole('button', { name: 'Login' })"
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const fn = new Function('page', `return page.${action.locatorExpr}`)
        return fn(this.page) as Locator
      } catch {
        // fall through to CSS selector
      }
    }
    return this.page.locator(action.selector)
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
    switch (action.type) {
      case 'goto':
        await this.page.goto(this.substituteOrigin(val!))
        break
      case 'click':
        await this.getLocator(action).click()
        break
      case 'fill':
        await this.getLocator(action).fill(val ?? '')
        break
      case 'selectOption':
        await this.getLocator(action).selectOption(val ?? '')
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
          await this.page.keyboard.press(val ?? '')
        }
        break
      case 'wait':
        await this.getLocator(action).waitFor({ state: 'visible' })
        break
    }
    if (action.captureAs && val != null) {
      this.sessionVars.set(action.captureAs, val)
    }
  }

  private async executeAssertion(action: Action): Promise<void> {
    const assertion = action.assertion
    if (!assertion) return
    const TIMEOUT = 10_000

    switch (assertion.type) {
      case 'text': {
        await this.page.locator(assertion.target!).waitFor({ state: 'visible', timeout: TIMEOUT })
        const text = await this.page.locator(assertion.target!).textContent({ timeout: TIMEOUT })
        if (!text?.includes(assertion.expected)) {
          throw new Error(
            `Assertion failed: expected text "${assertion.expected}" in "${assertion.target}", got "${text}"`,
          )
        }
        break
      }
      case 'visible': {
        const visible = await this.page
          .locator(assertion.target!)
          .isVisible()
        if (!visible) {
          throw new Error(`Assertion failed: "${assertion.target}" is not visible`)
        }
        break
      }
      case 'url': {
        await this.page.waitForURL(new RegExp(assertion.expected), { timeout: TIMEOUT })
        break
      }
      case 'count': {
        const expected = parseInt(assertion.expected, 10)
        await this.page.waitForFunction(
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
