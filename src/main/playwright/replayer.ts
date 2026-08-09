import { Page, Locator, FrameLocator } from 'playwright-core'
import { createRequire } from 'module'
import { existsSync } from 'fs'
import type { Action, FlowNode, ResolutionContext } from '../../shared/types'
import { isCallFlowAction, DOMAIN_ENV_KEY } from '../../shared/types'
import { resolveValueWithSession, resolveValue, pickProfile, resolveProfileVars } from '../../shared/variableResolver'
import { resolveProjectId } from '../../shared/projectResolution'
import { getCursorHighlightScript } from './captureShared'
import { FlowStorage } from '../storage/flowStorage'
import { ProjectStorage } from '../storage/projectStorage'
import { FixtureStorage } from '../storage/fixtureStorage'
import { decryptIfNeeded } from '../security/vault'

// Async function constructor — used to run a code node's body with (page, expect, vars) in scope.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...callArgs: unknown[]) => Promise<void>

// Lazily resolve @playwright/test's `expect` at runtime (it's not bundled into the main
// process). Same createRequire pattern captureShared uses for playwright-core.
let _expectFn: unknown = null
function getExpect(): unknown {
  if (_expectFn !== null) return _expectFn
  try {
    const req = createRequire(import.meta.url)
    _expectFn = req('@playwright/test').expect
  } catch {
    _expectFn = undefined
  }
  return _expectFn
}

/** How long an assertion waits for the page to settle before failing. */
const ASSERT_TIMEOUT_MS = 10_000

/** Playwright's `expect`, narrowed to the locator matchers the assert action types need.
 *  Kept in sync with ScriptExporter.actionToCode so replay and the exported spec agree. */
type LocatorExpect = (locator: Locator) => {
  toBeVisible(options?: { timeout?: number }): Promise<void>
  toContainText(expected: string, options?: { timeout?: number }): Promise<void>
  toHaveValue(expected: string, options?: { timeout?: number }): Promise<void>
}

/** getExpect() returns undefined when @playwright/test can't be resolved. Assertions are the
 *  only replay path that hard-depends on it, so fail loudly rather than as a TypeError. */
function requireExpect(): LocatorExpect {
  const fn = getExpect()
  if (typeof fn !== 'function') {
    throw new Error('無法載入 @playwright/test 的 expect，斷言節點無法執行')
  }
  return fn as LocatorExpect
}

type NodeStartCallback = (nodeId: string) => void
type NodeCompleteCallback = (nodeId: string, success: boolean, error?: string) => void

/** No-op 'filechooser' listener. Merely having one makes Chromium intercept the chooser
 *  instead of opening the OS dialog, which would otherwise sit on top of the browser and
 *  stall the replay — a recorded flow can still contain a click that opens one. The files
 *  themselves come from the upload action's setInputFiles.
 *
 *  Interception lasts as long as the listener, so it MUST be released when the replay
 *  ends: branch recording silently replays on the very page it then records on, and a
 *  leftover listener would swallow the user's own file chooser. */
const swallowFileChooser = () => {}

export class Replayer {
  private page: Page
  private sessionVars = new Map<string, string>()
  private baseOrigin: string
  /** The resolution context this replay runs under, already decrypted by the IPC boundary.
   *  `profileVars` / `envVars` are normalized to non-undefined by the constructor. */
  private ctx: ResolutionContext & {
    profileVars: Record<string, string>
    envVars: Record<string, string>
  }
  /** pageAlias → Page for popups opened during replay (shared with nested Replayers). */
  private pages: Map<string, Page>
  /** Pages this replay muted the file chooser on, released when the replay ends. */
  private suppressedPages = new Set<Page>()
  /** Known project IDs, fetched at the top of replayToNode — lets executeCallFlow fold a
   *  sub-flow's projectId into the default project when it points at a deleted one, same as
   *  everywhere else (resolveProjectId). Each nested Replayer re-fetches its own on entry. */
  private knownProjectIds = new Set<string>()

  constructor(page: Page, baseURL = '', ctx: ResolutionContext = {}, sharedPages?: Map<string, Page>) {
    this.page = page
    this.ctx = { ...ctx, profileVars: ctx.profileVars ?? {}, envVars: ctx.envVars ?? {} }
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
    this.knownProjectIds = new Set((await ProjectStorage.list()).map((p) => p.id))
    const cursorScript = getCursorHighlightScript()
    await this.page.addInitScript(cursorScript)
    await this.page.evaluate(cursorScript).catch(() => {})
    this.suppressFileChooser(this.page)
    const path = this.findPath(nodes, targetNodeId)

    try {
      for (const node of path) {
        onNodeStart(node.id)
        try {
          if (isCallFlowAction(node.action)) {
            await this.executeCallFlow(node.action, onNodeStart, onNodeComplete, speed)
          } else {
            await this.executeAction(node.action)
          }
          onNodeComplete(node.id, true)
        } catch (err) {
          onNodeComplete(node.id, false, String(err))
          throw err
        }
        await new Promise((res) => setTimeout(res, speed))
      }
    } finally {
      this.releaseFileChooserSuppression()
    }
  }

  /** Swallow file choosers for the duration of this replay. Only ever removes its own
   *  listener, so a nested call-flow replayer can't lift the outer replay's suppression. */
  private suppressFileChooser(page: Page): void {
    if (this.suppressedPages.has(page)) return
    this.suppressedPages.add(page)
    page.on('filechooser', swallowFileChooser)
  }

  private releaseFileChooserSuppression(): void {
    for (const page of this.suppressedPages) {
      if (!page.isClosed()) page.off('filechooser', swallowFileChooser)
    }
    this.suppressedPages.clear()
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
    const { activeProfileId, activeEnvironmentId, activeProjectId } = this.ctx
    let mappedSubProfileId: string | null | undefined = action.subFlowProfileId ?? null
    if (action.subFlowProfileMapping && activeProfileId && activeProfileId in action.subFlowProfileMapping) {
      mappedSubProfileId = action.subFlowProfileMapping[activeProfileId]
    }

    // Env-var references ({{envKey}}) only resolve when the sub-flow belongs to the active
    // project (v1 restriction: no cross-project env-var references).
    const subFlowEnvVars =
      activeProjectId && resolveProjectId(subFlow, this.knownProjectIds) === activeProjectId
        ? this.ctx.envVars
        : {}

    // Falls back to the sub-flow's first profile when the mapping resolves to null or names a
    // profile that no longer exists — same rule as ScriptExporter and the renderer.
    const subProfile = pickProfile(subFlow.profiles, mappedSubProfileId)
    const subProfileVars = subProfile
      ? resolveProfileVars(subProfile.vars, activeEnvironmentId, subFlowEnvVars, decryptIfNeeded)
      : {}

    // Pass the resolved sub-flow profile ID as the nested Replayer's activeProfileId so it
    // can resolve its own sub-flow mappings — this enables correct N-level nesting.
    // Pass the same-project-gated env vars so the nested flow's domain substitution only
    // applies when the sub-flow belongs to the active project (v1: no cross-project domain).
    const nested = new Replayer(this.page, subFlow.baseURL, {
      ...this.ctx,
      profileVars: subProfileVars,
      activeProfileId: subProfile?.id,
      envVars: subFlowEnvVars,
    }, this.pages)
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
      const resolved = resolveValueWithSession(frameExpr, this.sessionVars, this.ctx.profileVars, this.ctx.envVars)
      // Deliberate dynamic eval: framePath entries are locator expressions, not data.
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
        const resolved = resolveValueWithSession(action.locatorExpr, this.sessionVars, this.ctx.profileVars, this.ctx.envVars)
        // Deliberate dynamic eval: locatorExpr is Playwright code, not user data.
        const fn = new Function('page', `return page.${resolved}`)
        return fn(scope) as Locator
      } catch {
        // fall through to CSS selector
      }
    }
    return scope.locator(action.selector)
  }

  /**
   * Resolve the actual <input type=file> for an upload action.
   * Recorded locators are often not usable as-is: these widgets hide the input behind a
   * styled trigger and frequently reuse one id for both, and Chromium reports the input
   * itself as role=button with the trigger's label. Narrow to the one element
   * setInputFiles can accept, rather than failing on a strict-mode violation.
   */
  private async resolveFileInput(action: Action): Promise<Locator> {
    const scope = this.scopeFor(action)
    const fileInputs = scope.locator('input[type="file"]')
    const base = this.getLocator(action)
    const candidates = [
      base.and(fileInputs),               // same element, but only if it is a file input
      base.locator('input[type="file"]'), // recorded locator was a wrapper / label
      base,                               // recorded locator is already unambiguous
      fileInputs,                         // page has exactly one file input
    ]
    for (const c of candidates) {
      if (await c.count() === 1) return c
    }
    throw new Error('找不到唯一的檔案上傳欄位 input[type=file] — 請在屬性面板修正此節點的 Locator')
  }

  private substituteOrigin(url: string): string {
    // The domain override is a project environment variable ({{domain}}) resolved for the
    // active environment. Strip any trailing slash so it concatenates cleanly with pathname.
    const domainOverride = (this.ctx.envVars[DOMAIN_ENV_KEY] ?? '').replace(/\/+$/, '')
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
    // A node marked private stores ciphertext, so unwrap it before anything else looks at it.
    const rawValue = action.value != null
      ? (action.secret ? decryptIfNeeded(action.value) : action.value)
      : undefined
    const val = rawValue != null
      ? resolveValueWithSession(rawValue, this.sessionVars, this.ctx.profileVars, this.ctx.envVars)
      : undefined

    // If this action opens a popup, start waiting for the page event BEFORE executing
    // (mirrors the exported waitForEvent('popup') pattern).
    const popupPromise = action.opensPage
      ? this.pageFor(action).context().waitForEvent('page', { timeout: 15_000 })
      : null
    // If the switch below throws before popupPromise is awaited (line ~381), a later
    // timeout rejection would otherwise be unhandled. This passive handler is a separate
    // subscription — it doesn't consume the rejection for the real `await` below.
    popupPromise?.catch(() => {})

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
            action.values.map((v) => resolveValueWithSession(v, this.sessionVars, this.ctx.profileVars, this.ctx.envVars)),
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
        // filePaths is authoritative; older nodes only have the comma-joined value.
        // Paths are relative to the data root (fixtures/…) or absolute — the main
        // process cwd isn't the data root once packaged, so resolve explicitly.
        const raw = action.filePaths?.length
          ? action.filePaths.map((p) => resolveValueWithSession(p, this.sessionVars, this.ctx.profileVars, this.ctx.envVars))
          : (val ?? '').split(',')
        const files = raw.map((s) => s.trim()).filter(Boolean).map((s) => FixtureStorage.toAbsolute(s))
        if (!files.length) throw new Error('上傳節點沒有檔案路徑 — 請在屬性面板選擇檔案')
        for (const f of files) {
          if (!existsSync(f)) throw new Error(`找不到檔案: ${f}`)
        }
        await (await this.resolveFileInput(action)).setInputFiles(files)
        break
      }
      case 'wait':
        await this.getLocator(action).waitFor({ state: 'visible' })
        break
      case 'assertVisible':
        await requireExpect()(this.getLocator(action)).toBeVisible({ timeout: ASSERT_TIMEOUT_MS })
        break
      case 'assertText':
        await requireExpect()(this.getLocator(action)).toContainText(val ?? '', { timeout: ASSERT_TIMEOUT_MS })
        break
      case 'assertValue':
        await requireExpect()(this.getLocator(action)).toHaveValue(val ?? '', { timeout: ASSERT_TIMEOUT_MS })
        break
      case 'code': {
        const fn = new AsyncFunction('page', 'expect', 'vars', action.code ?? '')
        await fn(this.pageFor(action), getExpect(), this.buildCodeVars())
        break
      }
      case 'callFlow':
        break
    }

    if (popupPromise && action.opensPage) {
      const newPage = await popupPromise
      await newPage.waitForLoadState('domcontentloaded').catch(() => {})
      this.suppressFileChooser(newPage)
      this.pages.set(action.opensPage, newPage)
    }

    if (action.captureAs && val != null) {
      this.sessionVars.set(action.captureAs, val)
    }
  }

  /** Build the `vars` object injected into a code node.
   *  Priority (highest last so it wins): env vars < profile vars < session vars.
   *  Built-in random/timestamp variables are exposed as functions (fresh value per call). */
  private buildCodeVars(): Record<string, unknown> {
    const vars: Record<string, unknown> = { ...this.ctx.envVars, ...this.ctx.profileVars }
    for (const [k, v] of this.sessionVars) vars[k] = v
    for (const name of ['randomText', 'randomNumber', 'randomOneText', 'randomOneNumber', 'timestamp']) {
      if (!(name in vars)) vars[name] = () => resolveValue(`{{${name}}}`)
    }
    return vars
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
