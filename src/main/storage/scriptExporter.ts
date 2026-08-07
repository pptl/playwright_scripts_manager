import { promises as fs } from 'fs'
import { join } from 'path'
import type { Flow, FlowNode, ExportConfig, TestPath } from '../../shared/types'
import {
  isCallFlowAction,
  DOMAIN_ENV_KEY,
  SECRET_ENV_PREFIX,
} from '../../shared/types'
import { FlowStorage } from './flowStorage'
import { ProjectStorage } from './projectStorage'
import { getWorkspaceRoot } from './workspace'
import { decryptIfNeeded } from '../security/vault'
import { resolveProjectId } from '../../shared/projectResolution'
import type { CodegenVarScope } from '../../shared/variableResolver'
import {
  hasVariables,
  valueToCodeExpr,
  sessionAwareValueToCodeExpr,
  locatorExprToCode,
  emitProfileVarDecls,
  emitEnvVarDecls,
  VARIABLE_HELPERS_CODE,
  SECRET_HELPER_CODE,
  SECRET_VAR_PREFIX,
  resolveValue,
  toSingleQuoted,
} from '../../shared/variableResolver'

function exportsDir(): string {
  return join(getWorkspaceRoot(), 'exports')
}

/**
 * Every private value referenced by one generated spec, mapped to the identifier that
 * stands in for it. The plaintext is handed to the test runner through the environment
 * (or the gitignored secrets file), never written into the spec.
 *
 * Deduping on key+value means a secret shared by a parent flow and its sub-flows
 * collapses to one declaration, while two flows that happen to use the same key name
 * for different values still get separate ones.
 */
class SecretRegistry {
  private bySource = new Map<string, string>()
  private values = new Map<string, string>()

  /** Returns the identifier to emit in place of the value. */
  ref(key: string, plaintext: string): string {
    const source = `${key}\u0000${plaintext}`
    const seen = this.bySource.get(source)
    if (seen) return SECRET_VAR_PREFIX + seen

    // Placeholder names only ever match \w+, but node-level secrets build their own key.
    const base = /^\w+$/.test(key) ? key : 'value'
    let name = base
    for (let n = 2; this.values.has(name); n++) name = `${base}_${n}`

    this.bySource.set(source, name)
    this.values.set(name, plaintext)
    return SECRET_VAR_PREFIX + name
  }

  get size(): number {
    return this.values.size
  }

  decls(): string {
    return [...this.values.keys()]
      .map((n) => `const ${SECRET_VAR_PREFIX}${n} = _ftSecret('${SECRET_ENV_PREFIX}${n}');`)
      .join('\n')
  }

  /** FT_SECRET_* → plaintext, for the child process env / the secrets file. */
  env(): Record<string, string> {
    return Object.fromEntries([...this.values].map(([n, v]) => [SECRET_ENV_PREFIX + n, v]))
  }
}

/** One inlined step in a generated test path, carrying the flow-level context needed to emit it. */
type ExpandedStep = {
  node: FlowNode
  profileVars: Record<string, string>
  /** Project env vars visible to this node, already gated by active project (see gateEnvVars). */
  envVars: Record<string, string>
  baseOrigin: string
  inlineVars: boolean
  /** The `domain` env-var value (trailing-slash stripped) for the flow this node came from,
   *  or '' when the flow isn't in the active project. Drives goto-URL origin substitution. */
  domain: string
  /** Which of this step's profileVars keys are private. Read off the step's own Flow, so a
   *  sub-flow's secrecy is independent of the parent's. */
  secretProfileKeys: Set<string>
}

/** Known project IDs for the export currently in progress — populated once by
 *  `ScriptExporter.build()` before the (synchronous) generateSpec/gateEnvVars recursion runs.
 *  A module-level cache instead of a threaded parameter: `activeProjectId` alone already
 *  runs through 6 nested function signatures (generateSpec → buildStepSequence →
 *  getSubFlowPath → resolveProfile), and adding another positional parameter there is exactly
 *  the C1 problem tracked separately — not something to grow while fixing this. */
let currentKnownProjectIds: Set<string> = new Set()

/** Project env vars are only visible to flows belonging to the active project
 *  (v1: no cross-project env-var references). A flow's `projectId` pointing at a project
 *  that no longer exists folds into the reserved default project, same as everywhere else. */
function gateEnvVars(
  flow: Flow,
  envVars: Record<string, string> | undefined,
  activeProjectId: string | undefined,
): Record<string, string> {
  return activeProjectId && resolveProjectId(flow, currentKnownProjectIds) === activeProjectId
    ? (envVars ?? {})
    : {}
}

/** Resolve a flow's `domain` env-var value, gated to the active project. Trailing slash stripped. */
function resolveFlowDomain(
  flow: Flow,
  envVars: Record<string, string> | undefined,
  activeProjectId: string | undefined,
): string {
  return (gateEnvVars(flow, envVars, activeProjectId)[DOMAIN_ENV_KEY] ?? '').replace(/\/+$/, '')
}

export class ScriptExporter {
  static async export(flow: Flow, config: ExportConfig): Promise<string> {
    const outputDir = exportsDir()
    await fs.mkdir(outputDir, { recursive: true })

    const { specContent } = await ScriptExporter.build(flow, config)

    const specPath = join(outputDir, `${flow.id}.spec.ts`)
    await fs.writeFile(specPath, specContent, 'utf-8')

    return specPath
  }

  /**
   * The private values the spec for this flow will look up, as FT_SECRET_* → plaintext.
   *
   * Produced by running the same code generation and reading the registry, so the names
   * are guaranteed to line up with whatever the spec actually references.
   */
  static async collectSecretEnv(flow: Flow, config: ExportConfig): Promise<Record<string, string>> {
    return (await ScriptExporter.build(flow, config)).secretEnv
  }

  private static async build(
    flow: Flow,
    config: ExportConfig,
  ): Promise<{ specContent: string; secretEnv: Record<string, string> }> {
    // Populate before generateSpec's synchronous recursion runs — see gateEnvVars.
    currentKnownProjectIds = new Set((await ProjectStorage.list()).map((p) => p.id))
    const subFlowMap = await ScriptExporter.resolveSubFlows(flow)
    const paths = ScriptExporter.computePaths(flow)
    const nodeMap = new Map(flow.nodes.map((n) => [n.id, n]))

    const secrets = new SecretRegistry()
    const specContent = ScriptExporter.generateSpec(flow, paths, nodeMap, config, subFlowMap, config.activeProfileId, secrets)

    return { specContent, secretEnv: secrets.env() }
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

  /** Which keys of a flow's profile hold private values. Secrecy is a per-key attribute
   *  shared by every profile of the flow, so the first profile is representative. */
  private static secretProfileKeys(flow: Flow): Set<string> {
    return new Set(
      (flow.profiles ?? []).flatMap((p) => p.vars.filter((v) => v.secret).map((v) => v.key)),
    )
  }

  private static resolveProfile(
    flow: Flow,
    profileId: string | null | undefined,
    activeEnvironmentId?: string,
    envVars?: Record<string, string>,
    activeProjectId?: string,
  ): { vars: Record<string, string>; secretKeys: Set<string> } {
    const secretKeys = ScriptExporter.secretProfileKeys(flow)
    const profile = profileId
      ? (flow.profiles ?? []).find((p) => p.id === profileId)
      : (flow.profiles ?? [])[0]
    if (!profile) return { vars: {}, secretKeys }
    const flowEnvVars = gateEnvVars(flow, envVars, activeProjectId)
    const vars = Object.fromEntries(
      profile.vars.map((v) => {
        const raw = (activeEnvironmentId && v.envValues?.[activeEnvironmentId]) ?? v.value
        // Decrypt BEFORE resolution — resolveValue would otherwise splice ciphertext into
        // a larger string, which can never be unwrapped again.
        return [v.key, resolveValue(decryptIfNeeded(raw), undefined, flowEnvVars)]
      }),
    )
    return { vars, secretKeys }
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
    subEnvVars: Record<string, string>,
    subBaseOrigin: string,
    subDomain: string,
    activeProfileId?: string,
    activeEnvironmentId?: string,
    envVars?: Record<string, string>,
    activeProjectId?: string,
    subSecretKeys: Set<string> = new Set(),
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
          const nestedProfile = ScriptExporter.resolveProfile(nested, nestedProfileId, activeEnvironmentId, envVars, activeProjectId)
          const nestedEnvVars = gateEnvVars(nested, envVars, activeProjectId)
          const nestedBaseOrigin = (() => { try { return new URL(nested.baseURL).origin } catch { return '' } })()
          const nestedDomain = resolveFlowDomain(nested, envVars, activeProjectId)
          path.unshift(...ScriptExporter.getSubFlowPath(nested, cur.action.subFlowExitNodeId, subFlowMap, nestedProfile.vars, nestedEnvVars, nestedBaseOrigin, nestedDomain, nestedProfileId ?? undefined, activeEnvironmentId, envVars, activeProjectId, nestedProfile.secretKeys))
        }
      } else {
        path.unshift({ node: cur, profileVars: subProfileVars, envVars: subEnvVars, baseOrigin: subBaseOrigin, inlineVars: true, domain: subDomain, secretProfileKeys: subSecretKeys })
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
    defaultEnvVars: Record<string, string> = {},
    defaultBaseOrigin: string = '',
    defaultDomain: string = '',
    activeProfileId?: string,
    activeEnvironmentId?: string,
    envVars?: Record<string, string>,
    activeProjectId?: string,
    defaultSecretKeys: Set<string> = new Set(),
  ): ExpandedStep[] {
    const result: ExpandedStep[] = []
    for (const id of nodeIds) {
      const node = nodeMap.get(id)
      if (!node) continue
      if (isCallFlowAction(node.action)) {
        const subFlow = subFlowMap.get(node.action.subFlowId)
        if (subFlow) {
          const subProfileId = ScriptExporter.resolveSubFlowProfileId(node.action, activeProfileId)
          const subProfile = ScriptExporter.resolveProfile(subFlow, subProfileId, activeEnvironmentId, envVars, activeProjectId)
          const subEnvVars = gateEnvVars(subFlow, envVars, activeProjectId)
          const subBaseOrigin = (() => { try { return new URL(subFlow.baseURL).origin } catch { return '' } })()
          const subDomain = resolveFlowDomain(subFlow, envVars, activeProjectId)
          result.push(...ScriptExporter.getSubFlowPath(subFlow, node.action.subFlowExitNodeId, subFlowMap, subProfile.vars, subEnvVars, subBaseOrigin, subDomain, subProfileId ?? undefined, activeEnvironmentId, envVars, activeProjectId, subProfile.secretKeys))
        }
      } else {
        result.push({ node, profileVars: defaultProfileVars, envVars: defaultEnvVars, baseOrigin: defaultBaseOrigin, inlineVars: false, domain: defaultDomain, secretProfileKeys: defaultSecretKeys })
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

    // `rootNodeId` is a cached pointer to the graph's true root (the node with
    // parentId === null). It can go stale — e.g. connectNodes attaching a new parent
    // in front of the current root doesn't update it — so walk up the parentId chain
    // from it to the true root, mirroring Replayer.replayToNode's traversal, instead of
    // trusting the cached pointer blindly.
    let root = nodeMap.get(flow.rootNodeId)
    if (root?.parentId) {
      const seen = new Set<string>()
      while (root?.parentId && !seen.has(root.id)) {
        seen.add(root.id)
        root = nodeMap.get(root.parentId)
      }
    }
    root = root ?? flow.nodes.find((n) => n.parentId === null)
    if (root) walk(root, [], [])

    return paths
  }

  private static generateSpec(
    flow: Flow,
    paths: TestPath[],
    nodeMap: Map<string, FlowNode>,
    config: ExportConfig,
    subFlowMap: Map<string, Flow> = new Map(),
    activeProfileId?: string,
    secrets: SecretRegistry = new SecretRegistry(),
  ): string {
    const profileVars = config.profileVars ?? {}
    const profileVarKeys = new Set(Object.keys(profileVars))

    // Private values are declared as `_ftSec_*` (a process.env lookup) instead, so they
    // are excluded from the plaintext `_ftProf_*` / `_ftEnv_*` blocks.
    const secretProfileKeys = ScriptExporter.secretProfileKeys(flow)
    const secretEnvKeys = new Set(config.secretEnvKeys ?? [])
    const hasProfileVars = [...profileVarKeys].some((k) => !secretProfileKeys.has(k))

    // Project env vars are emitted once at file scope as `_ftEnv_*` consts. They are
    // project-global, so sub-flow nodes reference the same consts (no per-flow inlining).
    const allEnvVars = config.envVars ?? {}
    const hasEnvVars = Object.keys(allEnvVars).some((k) => !secretEnvKeys.has(k))

    /**
     * Resolver for one step's visible private keys. Registers with the registry on lookup,
     * so only the secrets a step actually references get a declaration — an unused private
     * env var must not turn into an `_ftSecret(...)` call the run would then demand.
     */
    const secretScopeFor = (
      stepProfileVars: Record<string, string>,
      stepSecretKeys: Set<string>,
      stepEnvVars: Record<string, string>,
    ) => {
      const isSecret = (key: string): boolean =>
        (stepSecretKeys.has(key) && key in stepProfileVars) ||
        (secretEnvKeys.has(key) && key in stepEnvVars)

      const resolve = (key: string): string | undefined => {
        // Profile vars outrank env vars at resolution time, so check them first.
        if (stepSecretKeys.has(key) && key in stepProfileVars) {
          return secrets.ref(key, stepProfileVars[key])
        }
        if (secretEnvKeys.has(key) && key in stepEnvVars) {
          return secrets.ref(key, stepEnvVars[key])
        }
        return undefined
      }
      return { isSecret, resolve }
    }

    const baseOrigin = (() => {
      try { return new URL(flow.baseURL).origin } catch { return '' }
    })()
    const flowDomain = resolveFlowDomain(flow, config.envVars, config.activeProjectId)
    const flowEnvVars = gateEnvVars(flow, config.envVars, config.activeProjectId)

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
        const steps = ScriptExporter.buildStepSequence(path.nodeIds, nodeMap, subFlowMap, profileVars, flowEnvVars, baseOrigin, flowDomain, activeProfileId, config.activeEnvironmentId, config.envVars, config.activeProjectId, secretProfileKeys)
        const sessionVarsDefined = new Set<string>()

        // Each step is wrapped in its own test.step async closure, so a
        // captureAs variable declared with `const` inside one closure is invisible to
        // subsequent steps. Hoist them as `let` at the test function scope instead.
        const hoistedVars: Set<string> = new Set(
          steps.map(({ node }) => node.action.captureAs).filter((v): v is string => !!v),
        )
        // Popup page aliases need the same hoisting: `const page1` inside a step closure
        // would be invisible to later steps that act on page1.
        const hoistedPages: Set<string> = new Set(
          steps.map(({ node }) => node.action.opensPage).filter((v): v is string => !!v),
        )
        if (hoistedPages.size > 0) usesPopupHoist = true
        // An upload's trigger click would pop the OS file dialog and stall the run.
        // Registering a filechooser listener makes Chromium intercept it instead;
        // the files still come from the upload step's setInputFiles.
        const suppressChooser = steps.some(({ node }) => node.action.type === 'upload')
          ? "    page.on('filechooser', () => {});\n"
          : ''
        const hoistDecls =
          suppressChooser +
          (hoistedVars.size > 0 ? [...hoistedVars].map((v) => `    let ${v} = ''`).join('\n') + '\n' : '') +
          (hoistedPages.size > 0 ? [...hoistedPages].map((p) => `    let ${p}: Page`).join('\n') + '\n' : '')

        const stepCode = steps
          .map(({ node, profileVars: stepProfileVars, envVars: stepEnvVars, baseOrigin: stepBaseOrigin, inlineVars, domain: stepDomain, secretProfileKeys: stepSecretKeys }) => {
            const secretScope = secretScopeFor(stepProfileVars, stepSecretKeys, stepEnvVars)
            let rawAction = ScriptExporter.actionToCode(node, sessionVarsDefined, stepBaseOrigin, stepProfileVars, inlineVars, hoistedVars, stepDomain, stepEnvVars, secretScope, secrets)

            // Popup-opening action: wrap in the official waitForEvent('popup') pattern
            if (node.action.opensPage) {
              const alias = node.action.opensPage
              const pageRef = node.action.pageAlias || 'page'
              const assign = hoistedPages.has(alias)
                ? `${alias} = await ${alias}Promise;`
                : `const ${alias} = await ${alias}Promise;`
              rawAction = `const ${alias}Promise = ${pageRef}.waitForEvent('popup');\n${rawAction}\n${assign}`
            }
            const action = rawAction.replace(/\n/g, '\n      ')
            return `    await test.step(${toSingleQuoted(node.action.description)}, async () => {\n      ${action}\n    });`
          })
          .join('\n\n')

        return `  test(${toSingleQuoted(testName)}, async ({ page }) => {\n${hoistDecls}${stepCode}\n  });`
      })
      .join('\n\n')

    // Built last: the registry only knows what it contains once every step has been emitted.
    return [
      `import { test, expect${usesPopupHoist ? ', Page' : ''} } from '@playwright/test';`,
      secrets.size > 0 ? `import * as _ftFs from 'fs';` : '',
      usesVariables ? VARIABLE_HELPERS_CODE : '',
      secrets.size > 0 ? SECRET_HELPER_CODE : '',
      hasEnvVars ? `\n${emitEnvVarDecls(allEnvVars, secretEnvKeys)}` : '',
      hasProfileVars ? `\n${emitProfileVarDecls(profileVars, secretProfileKeys)}` : '',
      secrets.size > 0 ? `\n${secrets.decls()}` : '',
      '',
      `test.describe(${toSingleQuoted(flow.name)}, () => {`,
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
    /** Private keys visible to this step: `isSecret` is a side-effect-free predicate,
     *  `resolve` registers the value and returns its `_ftSec_*` identifier. */
    secretVars: {
      isSecret: (key: string) => boolean
      resolve: (key: string) => string | undefined
    } = { isSecret: () => false, resolve: () => undefined },
    secrets: SecretRegistry = new SecretRegistry(),
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
    // Env vars are project-global, so sub-flow nodes reference the same _ftEnv_* consts —
    // no inlining, which also keeps unquoted placeholders in locators valid JS.
    // secretVars outranks both tiers in varToCodeRef, which is what keeps a private value
    // out of the spec even on the inlineVars path.
    const scope: CodegenVarScope = {
      profileVars: profileVarKeys,
      envVars: new Set(Object.keys(envVars)),
      secretVars: secretVars.resolve,
    }

    /** Private placeholders must survive every inline substitution below, so that
     *  valueToCodeExpr can turn them into `_ftSec_*` references instead of literals.
     *  Uses the predicate, not the resolver — merely deciding not to inline must not
     *  register a declaration. */
    const isSecretKey = (k: string): boolean => secretVars.isSecret(k)

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
      ? action.locatorExpr.replace(/\{\{(\w+)\}\}/g, (m, k) =>
          !isSecretKey(k) && k in profileVars ? profileVars[k] : m)
      : action.locatorExpr

    if (selector && /^\[name=/.test(selector)) {
      // Form input with a name attribute — always the most reliable locator
      loc = `${scopeRef}.locator(${toSingleQuoted(selector)})`
    } else if (selector && /^\[data-id=/.test(selector)) {
      // Unique data-id attribute (e.g. MUI nav buttons that share the same aria-label)
      loc = `${scopeRef}.locator(${toSingleQuoted(selector)})`
    } else if (selector && /^\[aria-label=/.test(selector) && locatorExpr && /^getByText\(/.test(locatorExpr)) {
      // Element has a unique aria-label: prefer it over getByText which can time out
      // on buttons whose textContent doesn't perfectly match (e.g. icon + text).
      loc = `${scopeRef}.locator(${toSingleQuoted(selector)})`
    } else if (locatorExpr && /^getByText\(/.test(locatorExpr)) {
      // Attempt to upgrade getByText("X") → getByRole("tag", { name: "X", exact: true })
      // when the selector tells us the actual HTML element type.
      // Note: stored locatorExpr may already contain { exact: true } so match just the text portion.
      const textMatch = locatorExpr.match(/^getByText\("([^"]+)"/)
      if (textMatch && selector && /^button/.test(selector)) {
        loc = `${scopeRef}.getByRole("button", { name: ${toSingleQuoted(textMatch[1])}, exact: true })`
      } else if (textMatch && selector && /^a[\s\[]/.test(selector)) {
        loc = `${scopeRef}.getByRole("link", { name: ${toSingleQuoted(textMatch[1])}, exact: true })`
      } else if (textMatch) {
        // No role info — at least add exact:true to limit partial matches
        loc = `${scopeRef}.getByText(${toSingleQuoted(textMatch[1])}, { exact: true })`
      } else {
        loc = `${scopeRef}.${locatorExpr}`
      }
    } else if (locatorExpr) {
      loc = `${scopeRef}.${locatorExpr}`
    } else {
      loc = `${scopeRef}.locator(${toSingleQuoted(selector)})`
    }

    // Transform any {{...}} variable placeholders remaining in loc into JS code expressions
    if (hasVariables(loc)) {
      loc = locatorExprToCode(loc, { ...scope, sessionVars: sessionVarsDefined })
    }

    // For sub-flow nodes: pre-resolve profile var placeholders to actual values.
    // Built-in vars ({{randomText}} etc.) are NOT resolved here — they remain runtime calls.
    const resolveProfilePlaceholders = (v: string) =>
      inlineVars
        ? v.replace(/\{\{(\w+)\}\}/g, (m, k) =>
            !isSecretKey(k) && k in profileVars ? profileVars[k] : m)
        : v

    /** A node whose own value was marked private: the stored value is ciphertext, so
     *  decrypt it and hand it to the registry rather than emitting anything inline. */
    const nodeSecretRef = action.secret && action.value
      ? secrets.ref(`node_${action.id.replace(/\W/g, '').slice(0, 8) || 'value'}`, decryptIfNeeded(action.value))
      : null

    // If this action defines a session variable, emit a declaration before the action.
    // When the variable is hoisted, emit assignment only — the `let`
    // declaration lives at the test function scope so sibling step closures can read it.
    const captureAs = action.captureAs
    let captureDecl = ''
    if (captureAs) {
      const expr = nodeSecretRef ?? valueToCodeExpr(resolveProfilePlaceholders(action.value ?? ''), scope)
      captureDecl = hoistedVars.has(captureAs)
        ? `${captureAs} = ${expr};\n`
        : `const ${captureAs} = ${expr};\n`
      sessionVarsDefined.add(captureAs)
    }

    // Value argument: use captureAs var name when this node defines it,
    // otherwise use session-aware expression so {{varName}} resolves to the right reference.
    const va = (v: string) =>
      captureAs
        ? captureAs
        : nodeSecretRef ?? sessionAwareValueToCodeExpr(resolveProfilePlaceholders(v), sessionVarsDefined, scope)

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
              return `${captureDecl}await ${pageRef}.goto(${toSingleQuoted(domainOverride + rest)});`
            }
          } catch { /* not a URL, fall through */ }
        }
        if (inlineVars) {
          // Resolve any remaining {{key}} placeholders with actual profile / env var values.
          // Private keys are held back so they stay `_ftSec_*` references.
          const visible = (vars: Record<string, string>): Record<string, string> =>
            Object.fromEntries(Object.entries(vars).filter(([k]) => !isSecretKey(k)))
          gotoVal = resolveValue(gotoVal, visible(profileVars), visible(envVars))
        }
        return `${captureDecl}await ${pageRef}.goto(${va(gotoVal)});`
      }
      case 'click': {
        const clickOpts: string[] = []
        if (action.button && action.button !== 'left') clickOpts.push(`button: ${toSingleQuoted(action.button)}`)
        if (action.modifiers?.length) clickOpts.push(`modifiers: [${action.modifiers.map((m) => toSingleQuoted(m)).join(', ')}]`)
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
        // filePaths is authoritative; older nodes only have the comma-joined value.
        // Stored `fixtures/…` paths are emitted as-is — the test runner's cwd is the
        // data root (see RUN_TESTS), so they resolve and the spec stays portable.
        const files = (action.filePaths?.length ? action.filePaths : (action.value ?? '').split(','))
          .map((s) => s.trim())
          .filter(Boolean)
        const arg = files.length === 1 ? va(files[0]) : `[${files.map((f) => va(f)).join(', ')}]`
        // Uploads recorded before locators were tag-qualified can match the styled
        // trigger as well as the hidden input (same id) — narrow to the input so the
        // spec doesn't die on a strict-mode violation.
        const uploadLoc = /\binput\b/.test(action.locatorExpr ?? action.selector ?? '')
          ? loc
          : `${loc}.and(${scopeRef}.locator('input[type="file"]'))`
        return `${captureDecl}await ${uploadLoc}.setInputFiles(${arg});`
      }
      case 'code': {
        // Emit `const vars = { … }` then inline the user's code verbatim.
        // Parity with Replayer.buildCodeVars: env < profile < session (session wins),
        // built-ins exposed as functions. Profile vars reference _ftProf_* (or literals
        // when inlineVars), env vars reference _ftEnv_*, session vars are identifiers.
        const used = new Set<string>()
        const entries: string[] = []
        for (const key of Object.keys(profileVars)) {
          if (used.has(key)) continue
          used.add(key)
          const ref = secretVars.resolve(key)
            ?? (inlineVars ? JSON.stringify(profileVars[key]) : `_ftProf_${key}`)
          entries.push(`${JSON.stringify(key)}: ${ref}`)
        }
        for (const key of Object.keys(envVars)) {
          if (used.has(key)) continue
          used.add(key)
          entries.push(`${JSON.stringify(key)}: ${secretVars.resolve(key) ?? `_ftEnv_${key}`}`)
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
          ? `${scopeRef}.locator(${toSingleQuoted(action.selector)}).filter({ hasText: ${valueExpr} })`
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
}
