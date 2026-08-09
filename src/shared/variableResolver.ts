import type { FlowProfile, ProfileVariable } from './types'

export interface VariableDefinition {
  name: string
  placeholder: string
  description: string
  example: string
  /** Runtime value, fresh on every call. Used by replay and by the renderer's previews. */
  generate: () => string
  /** The identifier this variable is emitted as in a generated spec, e.g. `_ftRandomText`.
   *  Referenced *called* by `varToCodeRef` and *uncalled* by a code node's `vars` literal. */
  helperFn: string
  /**
   * Source of `helperFn`, injected into any spec that uses built-ins. Must be self-contained
   * (no cross-helper references) since the block is assembled by joining these.
   *
   * Deliberately hand-written rather than derived from `generate.toString()`: the bundler
   * rewrites function bodies, and the emitted source is TypeScript (see `_ftTimestamp`'s
   * typed inner `p`). Keeping both spellings in one entry is what makes a drift between
   * them visible — it is the only guarantee this registry can offer.
   */
  helperSource: string
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

function generateRandomText(len = 8): string {
  return Math.random().toString(36).substring(2, 2 + len).padEnd(len, '0')
}

function generateRandomNumber(len = 8): string {
  const min = Math.pow(10, len - 1)
  const max = Math.pow(10, len) - 1
  return String(Math.floor(Math.random() * (max - min + 1)) + min)
}

function generateRandomOneLetter(): string {
  return String.fromCharCode(65 + Math.floor(Math.random() * 26))
}

function generateRandomOneDigit(): string {
  return String(Math.floor(Math.random() * 10))
}

function generateTimestamp(): string {
  const d = new Date()
  return (
    `${d.getFullYear()}` +
    `${pad(d.getMonth() + 1)}` +
    `${pad(d.getDate())}` +
    `${pad(d.getHours())}` +
    `${pad(d.getMinutes())}` +
    `${pad(d.getSeconds())}` +
    `${pad(d.getMilliseconds(), 3)}`
  )
}

/**
 * The built-in variables, defined once.
 *
 * Every consumer — runtime resolution, codegen references, the emitted helper block, the
 * `vars` object of a code node, and the renderer's sidebar — reads this table, so adding a
 * built-in is a single entry rather than the seven hand-aligned sites it used to be.
 */
const BUILT_INS: Array<Omit<VariableDefinition, 'placeholder'>> = [
  {
    name: 'randomText',
    description: '隨機 8 個字元字串',
    example: 'wpmeorrt',
    generate: generateRandomText,
    helperFn: '_ftRandomText',
    helperSource: `function _ftRandomText(len = 8) {
  return Math.random().toString(36).substring(2, 2 + len).padEnd(len, '0');
}`,
  },
  {
    name: 'randomNumber',
    description: '隨機 8 位數字',
    example: '47291836',
    generate: generateRandomNumber,
    helperFn: '_ftRandomNumber',
    helperSource: `function _ftRandomNumber(len = 8) {
  const min = Math.pow(10, len - 1);
  const max = Math.pow(10, len) - 1;
  return String(Math.floor(Math.random() * (max - min + 1)) + min);
}`,
  },
  {
    name: 'randomOneText',
    description: '一個 A~Z 的隨機字母',
    example: 'G',
    generate: generateRandomOneLetter,
    helperFn: '_ftRandomOneLetter',
    helperSource: `function _ftRandomOneLetter() {
  return String.fromCharCode(65 + Math.floor(Math.random() * 26));
}`,
  },
  {
    name: 'randomOneNumber',
    description: '一個 0~9 的隨機數字',
    example: '4',
    generate: generateRandomOneDigit,
    helperFn: '_ftRandomOneDigit',
    helperSource: `function _ftRandomOneDigit() {
  return String(Math.floor(Math.random() * 10));
}`,
  },
  {
    name: 'timestamp',
    description: '目前時間戳記 (yyyyMMddHHmmssSSS)',
    example: '20260616143022123',
    generate: generateTimestamp,
    helperFn: '_ftTimestamp',
    helperSource: `function _ftTimestamp() {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return \`\${d.getFullYear()}\${p(d.getMonth() + 1)}\${p(d.getDate())}\${p(d.getHours())}\${p(d.getMinutes())}\${p(d.getSeconds())}\${p(d.getMilliseconds(), 3)}\`;
}`,
  },
]

/** `placeholder` is derived from `name` so the two can never drift apart. */
export const BUILT_IN_VARIABLES: VariableDefinition[] = BUILT_INS.map((v) => ({
  ...v,
  placeholder: `{{${v.name}}}`,
}))

const BUILT_IN_BY_NAME = new Map(BUILT_IN_VARIABLES.map((v) => [v.name, v]))

/** Max passes when resolving nested placeholders (e.g. a profile value that references
 *  an environment variable). Also guards against circular references. */
const MAX_RESOLVE_PASSES = 10

/** Flatten a project's environment variables for the active environment into a key->value map.
 *  Resolution: values[activeEnvironmentId] ?? '' */
export function flattenProjectEnvVars(
  envVars: Array<{ key: string; values: Record<string, string> }> | undefined,
  activeEnvironmentId: string | null | undefined,
): Record<string, string> {
  if (!envVars || !activeEnvironmentId) return {}
  return Object.fromEntries(
    envVars.map((v) => [v.key, v.values[activeEnvironmentId] ?? '']),
  )
}

/**
 * Pick a flow's profile: the one with `profileId` if it exists, otherwise the first.
 *
 * The four call sites (renderer varMaps, ScriptExporter.resolveProfile,
 * Replayer.executeCallFlow, and by extension Toolbar) share one fallback rule from here —
 * previously usePlaywright resolved by exact id with no fallback, so a stale profile id made
 * replay run with no variables while export happily used the first profile.
 */
export function pickProfile(
  profiles: FlowProfile[] | undefined,
  profileId: string | null | undefined,
): FlowProfile | undefined {
  const list = profiles ?? []
  return (profileId ? list.find((p) => p.id === profileId) : undefined) ?? list[0]
}

/**
 * Resolve a profile's variables into a flat map: `envValues[activeEnvId] ?? value`, decrypted,
 * then with `{{...}}` placeholders resolved against `envVars`.
 *
 * `decrypt` is injected rather than imported because `src/main/security/vault.ts` pulls in
 * electron's `safeStorage` and cannot live in `src/shared/`. The renderer passes nothing (it
 * has no key, so ciphertext travels on as an opaque string); the main process passes
 * `vault.decryptIfNeeded`.
 *
 * The order matters and must not be swapped: resolving first would splice ciphertext into a
 * larger string, which no later decrypt could ever unwrap.
 */
export function resolveProfileVars(
  vars: ProfileVariable[],
  activeEnvironmentId: string | null | undefined,
  envVars: Record<string, string>,
  decrypt: (value: string) => string = (v) => v,
): Record<string, string> {
  return Object.fromEntries(
    vars.map((v) => {
      const raw = (activeEnvironmentId && v.envValues?.[activeEnvironmentId]) ?? v.value
      return [v.key, resolveValue(decrypt(raw), { envVars })]
    }),
  )
}

/** The variable tiers a value is resolved against. Every field is optional — an absent tier
 *  is simply skipped, so `resolveValue(v)` resolves built-ins only. */
export interface RuntimeVarScope {
  sessionVars?: Map<string, string>
  profileVars?: Record<string, string>
  envVars?: Record<string, string>
}

/**
 * Resolve all {{...}} placeholders in a value string at runtime (used by Replayer).
 * Iterates so that a profile value expanding into {{envKey}} gets fully resolved.
 * Priority per pass: session vars > profile vars > env vars > built-ins.
 *
 * The tiers arrive as one object rather than as positional parameters: session vars rank
 * highest but would have to sit last, and most call sites want neither the first nor the
 * second tier. Same reasoning as `ResolutionContext`.
 */
export function resolveValue(value: string, vars: RuntimeVarScope = {}): string {
  const { sessionVars, profileVars, envVars } = vars
  let out = value
  for (let i = 0; i < MAX_RESOLVE_PASSES && /\{\{\w+\}\}/.test(out); i++) {
    const prev = out
    out = out.replace(/\{\{(\w+)\}\}/g, (match, name) => {
      if (sessionVars?.has(name)) return sessionVars.get(name)!
      if (profileVars && name in profileVars) return profileVars[name]
      if (envVars && name in envVars) return envVars[name]
      return BUILT_IN_BY_NAME.get(name)?.generate() ?? match
    })
    if (out === prev) break
  }
  return out
}

/** True if the value string contains any variable placeholder. */
export function hasVariables(value: string): boolean {
  return /\{\{.+?\}\}/.test(value)
}

/** Identifier prefixes for the const declarations emitted at the top of a generated spec. */
export const PROFILE_VAR_PREFIX = '_ftProf_'
export const ENV_VAR_PREFIX = '_ftEnv_'

/**
 * Which variable names are in scope during code generation, by tier.
 * Mirrors the runtime priority of resolveValue:
 * session > profile > project env > built-in.
 */
export interface CodegenVarScope {
  /** captureAs names already declared — emitted as bare identifiers. */
  sessionVars?: Set<string>
  /** Active profile's keys — emitted as `_ftProf_<key>`. */
  profileVars?: Set<string>
  /** Active project env-var keys — emitted as `_ftEnv_<key>`. */
  envVars?: Set<string>
  /**
   * Resolves a private key to the identifier declared for it at file scope (`_ftSec_<n>`),
   * which reads from process.env rather than holding a literal. Returns undefined for
   * keys that are not private.
   *
   * Consulted ahead of every other tier, so a private value can never be baked into the
   * spec as a string — including on the sub-flow `inlineVars` path, which otherwise
   * bypasses the `_ftProf_*` declarations entirely.
   *
   * A function rather than a map because the exporter registers on lookup: only the
   * secrets a spec actually references get declared in it.
   */
  secretVars?: (name: string) => string | undefined
}

/** Map a placeholder name to the JS expression producing its value, or null if unknown. */
function varToCodeRef(name: string, scope: CodegenVarScope): string | null {
  const secret = scope.secretVars?.(name)
  if (secret) return secret
  if (scope.sessionVars?.has(name)) return name
  if (scope.profileVars?.has(name)) return `${PROFILE_VAR_PREFIX}${name}`
  if (scope.envVars?.has(name)) return `${ENV_VAR_PREFIX}${name}`
  const builtIn = BUILT_IN_BY_NAME.get(name)
  // Called here — the placeholder stands for a value. A code node's `vars` literal
  // references the same helper *uncalled*, so each `vars.x()` yields a fresh value.
  if (builtIn) return `${builtIn.helperFn}()`
  return null
}

/** Escape a raw string for embedding inside a single-quoted JS literal.
 *  Returns the full quoted literal (including the surrounding `'...'`). */
export function toSingleQuoted(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** Escape a raw string for embedding inside a template literal body. */
function escapeTemplateBody(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}

/**
 * Convert a value string into a TypeScript code expression.
 * Plain strings become single-quoted literals; strings with variables become template literals.
 * Known variables emit as `${_ftProf_key}` / `${_ftEnv_key}` / `${_ftRandomText()}` …;
 * unknown names are left as literal `{{name}}` text.
 * e.g. "test-{{randomText}}" → "`test-${_ftRandomText()}`"
 * e.g. "{{admin_name}}" (profile var) → "`${_ftProf_admin_name}`"
 */
export function valueToCodeExpr(value: string, scope: CodegenVarScope = {}): string {
  if (!hasVariables(value)) return toSingleQuoted(value)
  // A value that is exactly one private placeholder becomes a bare reference rather than
  // a one-slot template literal — `fill(_ftSec_pw)` reads better than `fill(`${_ftSec_pw}`)`.
  const onlyVar = value.match(/^\{\{(\w+)\}\}$/)
  if (onlyVar) {
    const secret = scope.secretVars?.(onlyVar[1])
    if (secret) return secret
  }
  const inner = escapeTemplateBody(value).replace(/\{\{(\w+)\}\}/g, (m, name) => {
    const ref = varToCodeRef(name, scope)
    return ref ? `\${${ref}}` : m
  })
  return '`' + inner + '`'
}

/**
 * Like valueToCodeExpr, but a value that is exactly one session variable collapses to a
 * bare identifier rather than a one-slot template literal.
 * e.g. "{{sign_title}}" + sessionVars={"sign_title"} → `sign_title`
 */
export function sessionAwareValueToCodeExpr(
  value: string,
  sessionVars: Set<string>,
  scope: CodegenVarScope = {},
): string {
  const fullScope: CodegenVarScope = { ...scope, sessionVars }
  if (!hasVariables(value)) return toSingleQuoted(value)
  const singleVar = value.match(/^\{\{(\w+)\}\}$/)
  // A private key outranks a same-named session var — it must never become a literal.
  if (singleVar && !scope.secretVars?.(singleVar[1]) && sessionVars.has(singleVar[1])) {
    return singleVar[1]
  }
  return valueToCodeExpr(value, fullScope)
}

/**
 * Transform variable placeholders inside a locatorExpr string for code generation.
 *
 * Quoted string arguments containing {{...}} are rewritten to JS expressions:
 *   '{{sessionVar}}' → bare identifier  sessionVar
 *   '{{profileVar}}' → _ftProf_profileVar
 *   '{{envVar}}'     → _ftEnv_envVar
 *   '{{randomText}}' → _ftRandomText()
 *   Mixed content ('prefix_{{var}}') → template literal `prefix_${_ftProf_var}`
 *
 * Bare (unquoted) placeholders are handled too — users copy `{{key}}` from the variable
 * sidebar and paste it over a quoted argument, producing `{ name: {{key}} }`. A known name
 * becomes its identifier; an unknown one is quoted into a string literal so the emitted
 * spec still parses (the test then fails on a missing element, not a SyntaxError).
 */
export function locatorExprToCode(expr: string, scope: CodegenVarScope = {}): string {
  const rewriteQuoted = expr.replace(
    /'([^']*\{\{[^}]+\}\}[^']*)'|"([^"]*\{\{[^}]+\}\}[^"]*)"/g,
    (match, sq, dq) => {
      const inner = sq ?? dq
      const singleVar = inner.match(/^\{\{(\w+)\}\}$/)
      if (singleVar) return varToCodeRef(singleVar[1], scope) ?? match
      const templateInner = escapeTemplateBody(inner).replace(/\{\{(\w+)\}\}/g, (m, name) => {
        const ref = varToCodeRef(name, scope)
        return ref ? `\${${ref}}` : m
      })
      return '`' + templateInner + '`'
    },
  )

  return rewriteQuoted.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    return varToCodeRef(name, scope) ?? toSingleQuoted(match)
  })
}

/** Emit `const <prefix><key> = '<value>';` lines for a flat variable map.
 *  Keys that aren't plain word characters are skipped — they'd produce an invalid
 *  identifier and break the whole spec, and `{{...}}` placeholders only ever match
 *  \w+ so such a key could never be referenced anyway. */
function emitVarDecls(
  vars: Record<string, string>,
  prefix: string,
  skip: Set<string> = new Set(),
): string {
  return Object.entries(vars)
    .filter(([key]) => /^\w+$/.test(key) && !skip.has(key))
    .map(([key, value]) => `const ${prefix}${key} = ${JSON.stringify(value)};`)
    .join('\n')
}

/**
 * Emit top-level const declarations for profile variables.
 * e.g. { admin_name: 'admin', region: 'apac' }
 *   → "const _ftProf_admin_name = 'admin';\nconst _ftProf_region = 'apac';"
 *
 * `secretKeys` are omitted — they get a `_ftSec_*` declaration instead, so their values
 * never appear as literals in the generated file.
 */
export function emitProfileVarDecls(
  profileVars: Record<string, string>,
  secretKeys?: Set<string>,
): string {
  return emitVarDecls(profileVars, PROFILE_VAR_PREFIX, secretKeys)
}

/**
 * Emit top-level const declarations for the active project's environment variables.
 * e.g. { domain: 'https://x.test' } → "const _ftEnv_domain = 'https://x.test';"
 */
export function emitEnvVarDecls(
  envVars: Record<string, string>,
  secretKeys?: Set<string>,
): string {
  return emitVarDecls(envVars, ENV_VAR_PREFIX, secretKeys)
}

/** Identifier prefix for private values resolved from the environment at run time. */
export const SECRET_VAR_PREFIX = '_ftSec_'

/**
 * Runtime lookup for private values, injected into any spec that references one.
 *
 * Playwright has no secrets mechanism of its own — the official pattern is `process.env`
 * fed from a gitignored file (https://playwright.dev/docs/test-parameterize#env-files).
 * An in-app run gets the values injected straight into the child process env; the file
 * fallback is what makes an exported spec runnable with plain `npx playwright test`.
 *
 * Reading the file here rather than from playwright.config.ts keeps the spec
 * self-sufficient, so no generated config has to be regenerated for existing workspaces.
 */
export const SECRET_HELPER_CODE = `
function _ftSecret(name: string): string {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined) return fromEnv;
  try {
    const text = _ftFs.readFileSync(process.env.FT_SECRETS_FILE ?? '.flowtest/secrets.env', 'utf-8');
    for (const line of text.split(/\\r?\\n/)) {
      const eq = line.indexOf('=');
      if (eq > 0 && line.slice(0, eq).trim() === name) {
        return line.slice(eq + 1).replace(/\\\\n/g, '\\n');
      }
    }
  } catch {
    // No secrets file — fall through to the error below.
  }
  throw new Error(
    \`[FlowTest] 缺少私密變數 \${name}。請在 FlowTest 中按「匯出密鑰檔」，或自行設定同名環境變數。\`
  );
}
`

/**
 * Helper functions block to inject into generated spec files when built-in variables are used.
 *
 * Always emitted whole rather than per-used-variable: a `code` node's `vars` literal
 * references every helper by identifier, so a selective block would compile fine here and
 * die with a ReferenceError inside the generated spec.
 */
export const VARIABLE_HELPERS_CODE = `\n${BUILT_IN_VARIABLES.map((v) => v.helperSource).join('\n')}\n`
