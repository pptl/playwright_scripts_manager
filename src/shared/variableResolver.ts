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

/** Resolve all {{...}} placeholders in a value string at runtime (used by Replayer). */
export function resolveValue(value: string): string {
  return value
    .replace(/\{\{randomText\}\}/g, () => generateRandomText())
    .replace(/\{\{randomNumber\}\}/g, () => generateRandomNumber())
    .replace(/\{\{timestamp\}\}/g, () => generateTimestamp())
}

/**
 * Like resolveValue but also checks session variables first.
 * Session variable names take precedence over built-in names.
 */
export function resolveValueWithSession(value: string, sessionVars: Map<string, string>): string {
  return value.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    if (sessionVars.has(name)) return sessionVars.get(name)!
    if (name === 'randomText') return generateRandomText()
    if (name === 'randomNumber') return generateRandomNumber()
    if (name === 'timestamp') return generateTimestamp()
    return match
  })
}

/** True if the value string contains any variable placeholder. */
export function hasVariables(value: string): boolean {
  return /\{\{.+?\}\}/.test(value)
}

/**
 * Convert a value string into a TypeScript code expression.
 * Plain strings become single-quoted literals; strings with variables become template literals.
 * e.g. "test-{{randomText}}" → "`test-${_ftRandomText()}`"
 */
export function valueToCodeExpr(value: string): string {
  if (!hasVariables(value)) {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  }
  const inner = value
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
    .replace(/\{\{randomText\}\}/g, '${_ftRandomText()}')
    .replace(/\{\{randomNumber\}\}/g, '${_ftRandomNumber()}')
    .replace(/\{\{timestamp\}\}/g, '${_ftTimestamp()}')
  return '`' + inner + '`'
}

/**
 * Like valueToCodeExpr but treats names in sessionVarNames as JS variable references.
 * e.g. "{{sign_title}}" + sessionVarNames={"sign_title"} → `sign_title` (bare identifier)
 * e.g. "prefix_{{sign_title}}" → "`prefix_${sign_title}`"
 * Built-in placeholders still expand to _ft...() calls.
 */
export function sessionAwareValueToCodeExpr(value: string, sessionVarNames: Set<string>): string {
  if (!hasVariables(value)) {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  }
  // If the entire value is a single session variable reference, emit a bare JS identifier
  const singleVar = value.match(/^\{\{(\w+)\}\}$/)
  if (singleVar && sessionVarNames.has(singleVar[1])) {
    return singleVar[1]
  }
  const inner = value
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
    .replace(/\{\{(\w+)\}\}/g, (_, name) => {
      if (sessionVarNames.has(name)) return `\${${name}}`
      if (name === 'randomText') return '${_ftRandomText()}'
      if (name === 'randomNumber') return '${_ftRandomNumber()}'
      if (name === 'timestamp') return '${_ftTimestamp()}'
      return `{{${name}}}`
    })
  return '`' + inner + '`'
}

/** Helper functions block to inject into generated spec files when variables are present. */
export const VARIABLE_HELPERS_CODE = `
function _ftRandomText(len = 8) {
  return Math.random().toString(36).substring(2, 2 + len).padEnd(len, '0');
}
function _ftRandomNumber(len = 8) {
  const min = Math.pow(10, len - 1);
  return String(Math.floor(Math.random() * (Math.pow(10, len) - min)) + min);
}
function _ftTimestamp() {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return \`\${d.getFullYear()}\${p(d.getMonth() + 1)}\${p(d.getDate())}\${p(d.getHours())}\${p(d.getMinutes())}\${p(d.getSeconds())}\${p(d.getMilliseconds(), 3)}\`;
}
`
