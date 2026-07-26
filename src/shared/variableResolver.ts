export interface VariableDefinition {
  name: string
  placeholder: string
  description: string
  example: string
}

export const BUILT_IN_VARIABLES: VariableDefinition[] = [
  {
    name: 'randomText',
    placeholder: '{{randomText}}',
    description: '隨機 8 個字元字串',
    example: 'wpmeorrt',
  },
  {
    name: 'randomNumber',
    placeholder: '{{randomNumber}}',
    description: '隨機 8 位數字',
    example: '47291836',
  },
  {
    name: 'randomOneText',
    placeholder: '{{randomOneText}}',
    description: '一個 A~Z 的隨機字母',
    example: 'G',
  },
  {
    name: 'randomOneNumber',
    placeholder: '{{randomOneNumber}}',
    description: '一個 0~9 的隨機數字',
    example: '4',
  },
  {
    name: 'timestamp',
    placeholder: '{{timestamp}}',
    description: '目前時間戳記 (yyyyMMddHHmmssSSS)',
    example: '20260616143022123',
  },
]

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

/** Resolve all {{...}} placeholders in a value string at runtime (used by Replayer).
 *  Iterates so that a profile value expanding into {{envKey}} gets fully resolved.
 *  Priority per pass: profile vars > env vars > built-ins. */
export function resolveValue(
  value: string,
  profileVars?: Record<string, string>,
  envVars?: Record<string, string>,
): string {
  let out = value
  for (let i = 0; i < MAX_RESOLVE_PASSES && /\{\{\w+\}\}/.test(out); i++) {
    const prev = out
    out = out.replace(/\{\{(\w+)\}\}/g, (match, name) => {
      if (profileVars && name in profileVars) return profileVars[name]
      if (envVars && name in envVars) return envVars[name]
      if (name === 'randomText') return generateRandomText()
      if (name === 'randomNumber') return generateRandomNumber()
      if (name === 'randomOneText') return generateRandomOneLetter()
      if (name === 'randomOneNumber') return generateRandomOneDigit()
      if (name === 'timestamp') return generateTimestamp()
      return match
    })
    if (out === prev) break
  }
  return out
}

/**
 * Like resolveValue but also checks session variables first.
 * Priority: session vars > profile vars > env vars > built-ins.
 */
export function resolveValueWithSession(
  value: string,
  sessionVars: Map<string, string>,
  profileVars?: Record<string, string>,
  envVars?: Record<string, string>,
): string {
  let out = value
  for (let i = 0; i < MAX_RESOLVE_PASSES && /\{\{\w+\}\}/.test(out); i++) {
    const prev = out
    out = out.replace(/\{\{(\w+)\}\}/g, (match, name) => {
      if (sessionVars.has(name)) return sessionVars.get(name)!
      if (profileVars && name in profileVars) return profileVars[name]
      if (envVars && name in envVars) return envVars[name]
      if (name === 'randomText') return generateRandomText()
      if (name === 'randomNumber') return generateRandomNumber()
      if (name === 'randomOneText') return generateRandomOneLetter()
      if (name === 'randomOneNumber') return generateRandomOneDigit()
      if (name === 'timestamp') return generateTimestamp()
      return match
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
 * Mirrors the runtime priority of resolveValueWithSession:
 * session > profile > project env > built-in.
 */
export interface CodegenVarScope {
  /** captureAs names already declared — emitted as bare identifiers. */
  sessionVars?: Set<string>
  /** Active profile's keys — emitted as `_ftProf_<key>`. */
  profileVars?: Set<string>
  /** Active project env-var keys — emitted as `_ftEnv_<key>`. */
  envVars?: Set<string>
}

/** Map a placeholder name to the JS expression producing its value, or null if unknown. */
function varToCodeRef(name: string, scope: CodegenVarScope): string | null {
  if (scope.sessionVars?.has(name)) return name
  if (scope.profileVars?.has(name)) return `${PROFILE_VAR_PREFIX}${name}`
  if (scope.envVars?.has(name)) return `${ENV_VAR_PREFIX}${name}`
  if (name === 'randomText') return '_ftRandomText()'
  if (name === 'randomNumber') return '_ftRandomNumber()'
  if (name === 'randomOneText') return '_ftRandomOneLetter()'
  if (name === 'randomOneNumber') return '_ftRandomOneDigit()'
  if (name === 'timestamp') return '_ftTimestamp()'
  return null
}

/** Escape a raw string for embedding inside a single-quoted JS literal. */
function toSingleQuoted(value: string): string {
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
  if (singleVar && sessionVars.has(singleVar[1])) return singleVar[1]
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
function emitVarDecls(vars: Record<string, string>, prefix: string): string {
  return Object.entries(vars)
    .filter(([key]) => /^\w+$/.test(key))
    .map(([key, value]) => `const ${prefix}${key} = ${JSON.stringify(value)};`)
    .join('\n')
}

/**
 * Emit top-level const declarations for profile variables.
 * e.g. { admin_name: 'admin', region: 'apac' }
 *   → "const _ftProf_admin_name = 'admin';\nconst _ftProf_region = 'apac';"
 */
export function emitProfileVarDecls(profileVars: Record<string, string>): string {
  return emitVarDecls(profileVars, PROFILE_VAR_PREFIX)
}

/**
 * Emit top-level const declarations for the active project's environment variables.
 * e.g. { domain: 'https://x.test' } → "const _ftEnv_domain = 'https://x.test';"
 */
export function emitEnvVarDecls(envVars: Record<string, string>): string {
  return emitVarDecls(envVars, ENV_VAR_PREFIX)
}

/** Helper functions block to inject into generated spec files when built-in variables are used. */
export const VARIABLE_HELPERS_CODE = `
function _ftRandomText(len = 8) {
  return Math.random().toString(36).substring(2, 2 + len).padEnd(len, '0');
}
function _ftRandomNumber(len = 8) {
  const min = Math.pow(10, len - 1);
  return String(Math.floor(Math.random() * (Math.pow(10, len) - min)) + min);
}
function _ftRandomOneLetter() {
  return String.fromCharCode(65 + Math.floor(Math.random() * 26));
}
function _ftRandomOneDigit() {
  return String(Math.floor(Math.random() * 10));
}
function _ftTimestamp() {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return \`\${d.getFullYear()}\${p(d.getMonth() + 1)}\${p(d.getDate())}\${p(d.getHours())}\${p(d.getMinutes())}\${p(d.getSeconds())}\${p(d.getMilliseconds(), 3)}\`;
}
`
