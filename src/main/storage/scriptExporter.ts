import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { Flow, FlowNode, ExportConfig, TestPath } from '../../shared/types'
import { isCallFlowAction, DEFAULT_PROJECT_ID, DOMAIN_ENV_KEY } from '../../shared/types'
import { FlowStorage } from './flowStorage'
import {
  hasVariables,
  valueToCodeExpr,
  sessionAwareValueToCodeExpr,
  locatorExprToCode,
  emitProfileVarDecls,
  VARIABLE_HELPERS_CODE,
  resolveValue,
} from '../../shared/variableResolver'

function exportsDir(): string {
  return app.isPackaged
    ? join(app.getPath('userData'), 'exports')
    : join(process.cwd(), 'exports')
}

/** One inlined step in a generated test path, carrying the flow-level context needed to emit it. */
type ExpandedStep = {
  node: FlowNode
  profileVars: Record<string, string>
  baseOrigin: string
  inlineVars: boolean
  /** The `domain` env-var value (trailing-slash stripped) for the flow this node came from,
   *  or '' when the flow isn't in the active project. Drives goto-URL origin substitution. */
  domain: string
}

/** Resolve a flow's `domain` env-var value, gated so it only applies when the flow belongs to
 *  the active project (v1: no cross-project env-var references). Trailing slash stripped. */
function resolveFlowDomain(
  flow: Flow,
  envVars: Record<string, string> | undefined,
  activeProjectId: string | undefined,
): string {
  const gated =
    activeProjectId && (flow.projectId ?? DEFAULT_PROJECT_ID) === activeProjectId ? (envVars ?? {}) : {}
  return (gated[DOMAIN_ENV_KEY] ?? '').replace(/\/+$/, '')
}

export class ScriptExporter {
  static async export(flow: Flow, config: ExportConfig): Promise<string> {
    const outputDir = config.outputDir || exportsDir()
    await fs.mkdir(outputDir, { recursive: true })

    const subFlowMap = await ScriptExporter.resolveSubFlows(flow)
    const paths = ScriptExporter.computePaths(flow)
    const nodeMap = new Map(flow.nodes.map((n) => [n.id, n]))

    let helperImport = ''
    let helperCode = ''

    if (config.helperFunctions) {
      const result = ScriptExporter.extractHelpers(paths, nodeMap, flow)
      helperCode = result.helperCode
      helperImport = result.helperImport
      if (helperCode) {
        const helpersDir = join(outputDir, 'helpers')
        await fs.mkdir(helpersDir, { recursive: true })
        await fs.writeFile(join(helpersDir, `${flow.id}-helpers.ts`), helperCode, 'utf-8')
      }
    }

    const specContent = ScriptExporter.generateSpec(flow, paths, nodeMap, config, helperImport, subFlowMap, config.activeProfileId)
    const specPath = join(outputDir, `${flow.id}.spec.ts`)
    await fs.writeFile(specPath, specContent, 'utf-8')

    return specPath
  }

  private static async resolveSubFlows(flow: Flow, visited = new Set<string>()): Promise<Map<string, Flow>> {
    const result = new Map<string, Flow>()
    for (const node of flow.nodes) {
      if (isCallFlowAction(node.action) && !visited.has(node.action.subFlowId)) {
        visited.add(node.action.subFlowId)
        const sub = await FlowStorage.load(node.action.subFlowId)
        if (sub) {
          result.set(sub.id, sub)
          const nested = await ScriptExporter.resolveSubFlows(sub, visited)
          for (const [k, v] of nested) result.set(k, v)
        }
      }
    }
    return result
  }

  private static resolveProfileVars(
    flow: Flow,
    profileId: string | null | undefined,
    activeEnvironmentId?: string,
    envVars?: Record<string, string>,
    activeProjectId?: string,
  ): Record<string, string> {
    const profile = profileId
      ? (flow.profiles ?? []).find((p) => p.id === profileId)
      : (flow.profiles ?? [])[0]
    if (!profile) return {}
    // Env-var references ({{envKey}}) only resolve when this flow belongs to the active
    // project (v1 restriction: no cross-project env-var references).
    const flowEnvVars =
      activeProjectId && (flow.projectId ?? DEFAULT_PROJECT_ID) === activeProjectId ? (envVars ?? {}) : {}
    return Object.fromEntries(
      profile.vars.map((v) => {
        const raw = (activeEnvironmentId && v.envValues?.[activeEnvironmentId]) ?? v.value
        return [v.key, resolveValue(raw, undefined, flowEnvVars)]
      }),
    )
  }

  /** Resolve which sub-flow profile ID to use given the parent's active profile.
   *  subFlowProfileMapping takes precedence; falls back to legacy subFlowProfileId. */
  private static resolveSubFlowProfileId(
    action: { subFlowProfileId?: string; subFlowProfileMapping?: Record<string, string | null> },
    parentActiveProfileId: string | undefined,
  ): string | null | undefined {
    if (action.subFlowProfileMapping && parentActiveProfileId && parentActiveProfileId in action.subFlowProfileMapping) {
      return action.subFlowProfileMapping[parentActiveProfileId]
    }
    return action.subFlowProfileId ?? null
  }

  private static getSubFlowPath(
    subFlow: Flow,
    exitNodeId: string,
    subFlowMap: Map<string, Flow>,
    subProfileVars: Record<string, string>,
    subBaseOrigin: string,
    subDomain: string,
    activeProfileId?: string,
    activeEnvironmentId?: string,
    envVars?: Record<string, string>,
    activeProjectId?: string,
  ): ExpandedStep[] {
    const nodeMap = new Map(subFlow.nodes.map((n) => [n.id, n]))
    const path: ExpandedStep[] = []
    const visited = new Set<string>()
    let cur = nodeMap.get(exitNodeId)
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id)
      if (isCallFlowAction(cur.action)) {
        const nested = subFlowMap.get(cur.action.subFlowId)
        if (nested) {
          const nestedProfileId = ScriptExporter.resolveSubFlowProfileId(cur.action, activeProfileId)
          const nestedProfileVars = ScriptExporter.resolveProfileVars(nested, nestedProfileId, activeEnvironmentId, envVars, activeProjectId)
          const nestedBaseOrigin = (() => { try { return new URL(nested.baseURL).origin } catch { return '' } })()
          const nestedDomain = resolveFlowDomain(nested, envVars, activeProjectId)
          path.unshift(...ScriptExporter.getSubFlowPath(nested, cur.action.subFlowExitNodeId, subFlowMap, nestedProfileVars, nestedBaseOrigin, nestedDomain, nestedProfileId ?? undefined, activeEnvironmentId, envVars, activeProjectId))
        }
      } else {
        path.unshift({ node: cur, profileVars: subProfileVars, baseOrigin: subBaseOrigin, inlineVars: true, domain: subDomain })
      }
      cur = cur.parentId ? nodeMap.get(cur.parentId) : undefined
    }
    return path
  }

  private static buildStepSequence(
    nodeIds: string[],
    nodeMap: Map<string, FlowNode>,
    subFlowMap: Map<string, Flow>,
    defaultProfileVars: Record<string, string> = {},
    defaultBaseOrigin: string = '',
    defaultDomain: string = '',
    activeProfileId?: string,
    activeEnvironmentId?: string,
    envVars?: Record<string, string>,
    activeProjectId?: string,
  ): ExpandedStep[] {
    const result: ExpandedStep[] = []
    for (const id of nodeIds) {
      const node = nodeMap.get(id)
      if (!node) continue
      if (isCallFlowAction(node.action)) {
        const subFlow = subFlowMap.get(node.action.subFlowId)
        if (subFlow) {
          const subProfileId = ScriptExporter.resolveSubFlowProfileId(node.action, activeProfileId)
          const subProfileVars = ScriptExporter.resolveProfileVars(subFlow, subProfileId, activeEnvironmentId, envVars, activeProjectId)
          const subBaseOrigin = (() => { try { return new URL(subFlow.baseURL).origin } catch { return '' } })()
          const subDomain = resolveFlowDomain(subFlow, envVars, activeProjectId)
          result.push(...ScriptExporter.getSubFlowPath(subFlow, node.action.subFlowExitNodeId, subFlowMap, subProfileVars, subBaseOrigin, subDomain, subProfileId ?? undefined, activeEnvironmentId, envVars, activeProjectId))
        }
      } else {
        result.push({ node, profileVars: defaultProfileVars, baseOrigin: defaultBaseOrigin, inlineVars: false, domain: defaultDomain })
      }
    }
    return result
  }

  // Compute all root-to-leaf paths
  static computePaths(flow: Flow): TestPath[] {
    const nodeMap = new Map(flow.nodes.map((n) => [n.id, n]))
    const paths: TestPath[] = []

    const walk = (node: FlowNode, currentPath: string[], pathName: string[]) => {
      const newPath = [...currentPath, node.id]
      const newName = [...pathName, node.action.description]

      if (node.childIds.length === 0) {
        paths.push({
          id: `path-${paths.length + 1}`,
          name: newName.filter((_, i) => i === 0 || i === newName.length - 1).join(' → '),
          nodeIds: newPath,
        })
        return
      }

      for (const childId of node.childIds) {
        const child = nodeMap.get(childId)
        if (child) walk(child, newPath, newName)
      }
    }

    const root = nodeMap.get(flow.rootNodeId) ?? flow.nodes.find((n) => n.parentId === null)
    if (root) walk(root, [], [])

    return paths
  }

  private static generateSpec(
    flow: Flow,
    paths: TestPath[],
    nodeMap: Map<string, FlowNode>,
    config: ExportConfig,
    helperImport: string,
    subFlowMap: Map<string, Flow> = new Map(),
    activeProfileId?: string,
  ): string {
    const profileVars = config.profileVars ?? {}
    const profileVarKeys = new Set(Object.keys(profileVars))
    const hasProfileVars = profileVarKeys.size > 0

    const baseOrigin = (() => {
      try { return new URL(flow.baseURL).origin } catch { return '' }
    })()
    const flowDomain = resolveFlowDomain(flow, config.envVars, config.activeProjectId)

    const usesVariables = flow.nodes.some((n) =>
      (n.action.value && hasVariables(n.action.value)) ||
      (n.action.locatorExpr && hasVariables(n.action.locatorExpr)) ||
      // code nodes emit `const vars = { randomText: _ftRandomText, … }`, so the helpers are needed
      n.action.type === 'code'
    )

    let usesPopupHoist = false

    const tests = paths
      .map((path, idx) => {
        const testName = path.name || `測試路徑 ${idx + 1}`
        const steps = ScriptExporter.buildStepSequence(path.nodeIds, nodeMap, subFlowMap, profileVars, baseOrigin, flowDomain, activeProfileId, config.activeEnvironmentId, config.envVars, config.activeProjectId)
        const sessionVarsDefined = new Set<string>()

        // When useTestStep, each step is wrapped in its own async closure.
        // captureAs variables declared with `const` inside one closure are invisible to
        // subsequent steps. Hoist them as `let` at the test function scope instead.
        const hoistedVars: Set<string> = config.useTestStep
          ? new Set(steps.map(({ node }) => node.action.captureAs).filter((v): v is string => !!v))
          : new Set()
        // Popup page aliases need the same hoisting: `const page1` inside a step closure
        // would be invisible to later steps that act on page1.
        const hoistedPages: Set<string> = config.useTestStep
          ? new Set(steps.map(({ node }) => node.action.opensPage).filter((v): v is string => !!v))
          : new Set()
        if (hoistedPages.size > 0) usesPopupHoist = true
        const hoistDecls =
          (hoistedVars.size > 0 ? [...hoistedVars].map((v) => `    let ${v} = ''`).join('\n') + '\n' : '') +
          (hoistedPages.size > 0 ? [...hoistedPages].map((p) => `    let ${p}: Page`).join('\n') + '\n' : '')

        const stepCode = steps
          .map(({ node, profileVars: stepProfileVars, baseOrigin: stepBaseOrigin, inlineVars, domain: stepDomain }) => {
            let rawAction = ScriptExporter.actionToCode(node, sessionVarsDefined, stepBaseOrigin, stepProfileVars, inlineVars, hoistedVars, stepDomain, config.envVars ?? {})
            // Popup-opening action: wrap in the official waitForEvent('popup') pattern
            if (node.action.opensPage) {
              const alias = node.action.opensPage
              const pageRef = node.action.pageAlias || 'page'
              const assign = hoistedPages.has(alias)
                ? `${alias} = await ${alias}Promise;`
                : `const ${alias} = await ${alias}Promise;`
              rawAction = `const ${alias}Promise = ${pageRef}.waitForEvent('popup');\n${rawAction}\n${assign}`
            }
            const assertCode = node.action.assertion
              ? ScriptExporter.assertionToCode(node.action)
              : ''
            if (config.useTestStep) {
              const action = rawAction.replace(/\n/g, '\n      ')
              return `    await test.step('${node.action.description}', async () => {\n      ${action}${assertCode ? '\n      ' + assertCode : ''}\n    });`
            }
            const action = rawAction.replace(/\n/g, '\n    ')
            return `    // ${node.action.description}\n    ${action}${assertCode ? '\n    ' + assertCode : ''}`
          })
          .join('\n\n')

        return `  test('${testName}', async ({ page }) => {\n${hoistDecls}${stepCode}\n  });`
      })
      .join('\n\n')

    return [
      `import { test, expect${usesPopupHoist ? ', Page' : ''} } from '@playwright/test';`,
      helperImport,
      usesVariables ? VARIABLE_HELPERS_CODE : '',
      hasProfileVars ? `\n${emitProfileVarDecls(profileVars)}` : '',
      '',
      `test.describe('${flow.name}', () => {`,
      '',
      tests,
      '',
      '});',
    ]
      .filter((line) => line !== undefined)
      .join('\n')
  }

  private static actionToCode(
    node: FlowNode,
    sessionVarsDefined: Set<string>,
    baseOrigin = '',
    profileVars: Record<string, string> = {},
    inlineVars = false,
    hoistedVars: Set<string> = new Set(),
    domainOverride = '',
    envVars: Record<string, string> = {},
  ): string {
    const { action } = node
    // Popup actions target their page alias ('page1', 'page2'…); absent = the initial 'page'.
    const pageRef = action.pageAlias || 'page'
    // Actions inside iframes scope their locators through a .contentFrame() chain.
    // goto / keyboard / waitForEvent stay on the page itself.
    const frameChain = (action.framePath ?? []).map((f) => `.${f}.contentFrame()`).join('')
    const scopeRef = `${pageRef}${frameChain}`
    // For sub-flow nodes (inlineVars=true), profile vars are baked into actual values at code-gen
    // time so we don't emit _ftProf_* references (which would resolve to the parent flow's values).
    const profileVarKeys = inlineVars ? new Set<string>() : new Set(Object.keys(profileVars))

    // Locator priority:
    // 1. If selector has [name="..."] (form inputs), always use it — it's already
    //    the most specific unique CSS selector and avoids strict-mode violations
    //    caused by getByPlaceholder matching multiple elements on the same page.
    // 2. If locatorExpr uses getByText, try to upgrade to getByRole with exact:true.
    //    This handles the case where the click landed on a <span> inside a <button>
    //    before the bubble-up fix was applied.
    // 3. Otherwise use locatorExpr, falling back to CSS selector.
    let loc: string
    const { selector } = action
    // For inlineVars: resolve profile var placeholders in locatorExpr to actual values first
    const locatorExpr = action.locatorExpr && inlineVars
      ? action.locatorExpr.replace(/\{\{(\w+)\}\}/g, (m, k) => k in profileVars ? profileVars[k] : m)
      : action.locatorExpr

    if (selector && /^\[name=/.test(selector)) {
      // Form input with a name attribute — always the most reliable locator
      loc = `${scopeRef}.locator('${selector}')`
    } else if (selector && /^\[data-id=/.test(selector)) {
      // Unique data-id attribute (e.g. MUI nav buttons that share the same aria-label)
      loc = `${scopeRef}.locator('${selector}')`
    } else if (selector && /^\[aria-label=/.test(selector) && locatorExpr && /^getByText\(/.test(locatorExpr)) {
      // Element has a unique aria-label: prefer it over getByText which can time out
      // on buttons whose textContent doesn't perfectly match (e.g. icon + text).
      loc = `${scopeRef}.locator('${selector}')`
    } else if (locatorExpr && /^getByText\(/.test(locatorExpr)) {
      // Attempt to upgrade getByText("X") → getByRole("tag", { name: "X", exact: true })
      // when the selector tells us the actual HTML element type.
      // Note: stored locatorExpr may already contain { exact: true } so match just the text portion.
      const textMatch = locatorExpr.match(/^getByText\("([^"]+)"/)
      if (textMatch && selector && /^button/.test(selector)) {
        loc = `${scopeRef}.getByRole("button", { name: "${textMatch[1]}", exact: true })`
      } else if (textMatch && selector && /^a[\s\[]/.test(selector)) {
        loc = `${scopeRef}.getByRole("link", { name: "${textMatch[1]}", exact: true })`
      } else if (textMatch) {
        // No role info — at least add exact:true to limit partial matches
        loc = `${scopeRef}.getByText("${textMatch[1]}", { exact: true })`
      } else {
        loc = `${scopeRef}.${locatorExpr}`
      }
    } else if (locatorExpr) {
      loc = `${scopeRef}.${locatorExpr}`
    } else {
      loc = `${scopeRef}.locator('${selector}')`
    }

    // Transform any {{...}} variable placeholders remaining in loc into JS code expressions
    if (hasVariables(loc)) {
      loc = locatorExprToCode(loc, profileVarKeys, sessionVarsDefined)
    }

    // For sub-flow nodes: pre-resolve profile var placeholders to actual values.
    // Built-in vars ({{randomText}} etc.) are NOT resolved here — they remain runtime calls.
    const resolveProfilePlaceholders = (v: string) =>
      inlineVars ? v.replace(/\{\{(\w+)\}\}/g, (m, k) => k in profileVars ? profileVars[k] : m) : v

    // If this action defines a session variable, emit a declaration before the action.
    // When the variable is hoisted (useTestStep mode), emit assignment only — the `let`
    // declaration lives at the test function scope so sibling step closures can read it.
    const captureAs = action.captureAs
    let captureDecl = ''
    if (captureAs) {
      const expr = valueToCodeExpr(resolveProfilePlaceholders(action.value ?? ''), profileVarKeys)
      captureDecl = hoistedVars.has(captureAs)
        ? `${captureAs} = ${expr};\n`
        : `const ${captureAs} = ${expr};\n`
      sessionVarsDefined.add(captureAs)
    }

    // Value argument: use captureAs var name when this node defines it,
    // otherwise use session-aware expression so {{varName}} resolves to the right reference.
    const va = (v: string) => captureAs ? captureAs : sessionAwareValueToCodeExpr(resolveProfilePlaceholders(v), sessionVarsDefined, profileVarKeys)

    switch (action.type) {
      case 'goto': {
        let gotoVal = action.value ?? ''
        // domainOverride is the flow's `domain` env-var value (trailing-slash stripped) for the
        // active environment. When the recorded goto's origin matches the recording origin, swap
        // it for the active environment's domain, baked as a literal (export is env-specific).
        if (domainOverride && baseOrigin) {
          try {
            const parsed = new URL(gotoVal)
            if (parsed.origin === baseOrigin) {
              const rest = parsed.pathname + parsed.search + parsed.hash
              return `${captureDecl}await ${pageRef}.goto('${domainOverride}${rest}');`
            }
          } catch { /* not a URL, fall through */ }
        }
        if (inlineVars) {
          // Resolve any remaining {{key}} placeholders with actual profile var values
          gotoVal = resolveValue(gotoVal, profileVars)
        }
        return `${captureDecl}await ${pageRef}.goto(${va(gotoVal)});`
      }
      case 'click': {
        const clickOpts: string[] = []
        if (action.button && action.button !== 'left') clickOpts.push(`button: '${action.button}'`)
        if (action.modifiers?.length) clickOpts.push(`modifiers: [${action.modifiers.map((m) => `'${m}'`).join(', ')}]`)
        const optStr = clickOpts.length ? `{ ${clickOpts.join(', ')} }` : ''
        const method = (action.clickCount ?? 1) >= 2 ? 'dblclick' : 'click'
        return `await ${loc}.${method}(${optStr});`
      }
      case 'fill':
        return `${captureDecl}await ${loc}.fill(${va(action.value ?? '')});`
      case 'selectOption':
        if (action.values?.length) {
          return `${captureDecl}await ${loc}.selectOption([${action.values.map((v) => va(v)).join(', ')}]);`
        }
        return `${captureDecl}await ${loc}.selectOption(${va(action.value ?? '')});`
      case 'check':
        return `await ${loc}.check();`
      case 'uncheck':
        return `await ${loc}.uncheck();`
      case 'press':
        // keyboard.press has no locator
        return action.locatorExpr
          ? `${captureDecl}await ${loc}.press(${va(action.value ?? '')});`
          : `${captureDecl}await ${pageRef}.keyboard.press(${va(action.value ?? '')});`
      case 'upload': {
        // value holds comma-separated file paths
        const files = (action.value ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        const arg = files.length === 1 ? va(files[0]) : `[${files.map((f) => va(f)).join(', ')}]`
        return `${captureDecl}await ${loc}.setInputFiles(${arg});`
      }
      case 'code': {
        // Emit `const vars = { … }` then inline the user's code verbatim.
        // Parity with Replayer.buildCodeVars: env < profile < session (session wins),
        // built-ins exposed as functions. Profile vars reference _ftProf_* (or literals
        // when inlineVars), env/session use literals/identifiers.
        const used = new Set<string>()
        const entries: string[] = []
        for (const key of Object.keys(profileVars)) {
          if (used.has(key)) continue
          used.add(key)
          entries.push(`${JSON.stringify(key)}: ${inlineVars ? JSON.stringify(profileVars[key]) : `_ftProf_${key}`}`)
        }
        for (const [key, v] of Object.entries(envVars)) {
          if (used.has(key)) continue
          used.add(key)
          entries.push(`${JSON.stringify(key)}: ${JSON.stringify(v)}`)
        }
        for (const name of sessionVarsDefined) {
          if (used.has(name)) continue
          used.add(name)
          entries.push(`${JSON.stringify(name)}: ${name}`)
        }
        const builtins: Array<[string, string]> = [
          ['randomText', '_ftRandomText'],
          ['randomNumber', '_ftRandomNumber'],
          ['randomOneText', '_ftRandomOneLetter'],
          ['randomOneNumber', '_ftRandomOneDigit'],
          ['timestamp', '_ftTimestamp'],
        ]
        for (const [name, fn] of builtins) {
          if (used.has(name)) continue
          entries.push(`${name}: ${fn}`)
        }
        const varsDecl = `const vars = { ${entries.join(', ')} };`
        return `${varsDecl}\n${action.code ?? ''}`
      }
      case 'wait':
        return `await ${loc}.waitFor({ state: 'visible' });`
      case 'assertVisible':
        return `await expect(${loc}).toBeVisible();`
      case 'assertText': {
        const valueExpr = va(action.value ?? '')
        // When the value is a session variable (e.g. {{sign_off_title}}), the locatorExpr
        // still contains the hardcoded text captured at recording time and will find a stale
        // element. Replace the locator with a CSS selector + filter so it tracks the
        // runtime value instead.
        const isSessionVar = !!action.value && /^\{\{(\w+)\}\}$/.test(action.value)
          && sessionVarsDefined.has(action.value.slice(2, -2))
        const assertLoc = isSessionVar && action.selector
          ? `${scopeRef}.locator('${action.selector}').filter({ hasText: ${valueExpr} })`
          : loc
        return `${captureDecl}await expect(${assertLoc}).toContainText(${valueExpr});`
      }
      case 'assertValue':
        return `${captureDecl}await expect(${loc}).toHaveValue(${va(action.value ?? '')});`
      case 'callFlow':
        return '// [callFlow — should have been expanded by buildStepSequence]'
      default:
        return `// TODO: ${action.type}`
    }
  }

  private static assertionToCode(action: { assertion?: Flow['nodes'][0]['action']['assertion']; pageAlias?: string; framePath?: string[] }): string {
    const a = action.assertion
    if (!a) return ''
    const pageRef = action.pageAlias || 'page'
    const scopeRef = `${pageRef}${(action.framePath ?? []).map((f) => `.${f}.contentFrame()`).join('')}`
    switch (a.type) {
      case 'text':
        return `await expect(${scopeRef}.locator('${a.target}')).toContainText('${a.expected}');`
      case 'visible':
        return `await expect(${scopeRef}.locator('${a.target}')).toBeVisible();`
      case 'url':
        return `await expect(${pageRef}).toHaveURL(/${a.expected}/);`
      case 'count':
        return `await expect(${scopeRef}.locator('${a.target}')).toHaveCount(${a.expected});`
      default:
        return ''
    }
  }

  private static extractHelpers(
    paths: TestPath[],
    nodeMap: Map<string, FlowNode>,
    flow: Flow,
  ): { helperCode: string; helperImport: string } {
    if (paths.length < 2) return { helperCode: '', helperImport: '' }

    // Find the longest common prefix across all paths
    const pathArrays = paths.map((p) => p.nodeIds)
    let prefixLen = 0
    outer: for (let i = 0; i < pathArrays[0].length; i++) {
      const id = pathArrays[0][i]
      for (let j = 1; j < pathArrays.length; j++) {
        if (pathArrays[j][i] !== id) break outer
      }
      prefixLen++
    }

    if (prefixLen < 3) return { helperCode: '', helperImport: '' }

    const prefixNodes = pathArrays[0].slice(0, prefixLen).map((id) => nodeMap.get(id)!)

    // Popup pages opened inside the helper wouldn't be visible to the test body
    // (and vice versa) — skip helper extraction when the prefix touches popups.
    if (prefixNodes.some((n) => n.action.pageAlias || n.action.opensPage)) {
      return { helperCode: '', helperImport: '' }
    }
    const fnName = `setup_${flow.id.replace(/-/g, '_')}`
    const helperSessionVars = new Set<string>()
    const body = prefixNodes
      .map((node) => {
        const rawAction = ScriptExporter.actionToCode(node, helperSessionVars)
        const action = rawAction.replace(/\n/g, '\n  ')
        const assertCode = node.action.assertion ? ScriptExporter.assertionToCode(node.action) : ''
        return `  // ${node.action.description}\n  ${action}${assertCode ? '\n  ' + assertCode : ''}`
      })
      .join('\n\n')

    const helperCode = `import { Page, expect } from '@playwright/test';\n\nexport async function ${fnName}(page: Page): Promise<void> {\n${body}\n}\n`
    const helperImport = `import { ${fnName} } from './helpers/${flow.id}-helpers';`

    return { helperCode, helperImport }
  }
}
