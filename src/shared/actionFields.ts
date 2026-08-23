// src/shared/actionFields.ts — single source of truth for which ActionType has which
// UI-relevant field. Consolidates three previously independent, drifting definitions
// (canvas color/icon lookups, PropertyPanel's value-field and secret-toggle gates,
// FlowCanvas's context-menu "capture as variable" gate).
import type { ActionType } from './types'

/** Record<ActionType, ...> rather than Record<string, ...> so a typo'd key is a
 *  compile error instead of silently falling through to a default. */
export const TYPE_COLORS: Record<ActionType, string> = {
  goto: '#3b82f6',
  click: '#6b7280',
  fill: '#8b5cf6',
  selectOption: '#8b5cf6',
  check: '#10b981',
  uncheck: '#f59e0b',
  press: '#ec4899',
  upload: '#06b6d4',
  wait: '#f97316',
  assertVisible: '#22c55e',
  assertText: '#22c55e',
  assertValue: '#22c55e',
  callFlow: '#f59e0b',
  code: '#64748b',
}

export const TYPE_ICONS: Record<ActionType, string> = {
  goto: '🌐',
  click: '👆',
  fill: '✏️',
  selectOption: '📋',
  check: '✅',
  uncheck: '☐',
  press: '⌨️',
  upload: '📁',
  wait: '⏳',
  assertVisible: '👁',
  assertText: '📝',
  assertValue: '🔢',
  callFlow: '⛓',
  code: '</>',
}

/** Types whose Action carries a user-meaningful `value` — shown as the Value field in
 *  PropertyPanel, and eligible for "capture as session variable" in the canvas context menu. */
const VALUE_BEARING_TYPES: ReadonlySet<ActionType> = new Set([
  'fill', 'selectOption', 'goto', 'press', 'upload', 'assertText', 'assertValue',
])

export function hasValueField(type: ActionType): boolean {
  return VALUE_BEARING_TYPES.has(type)
}

/** Types whose value can be marked private (secret). `goto` is excluded — its URL is
 *  rewritten by domain substitution, which bypasses secret handling entirely, so a
 *  "secret" goto would give a false sense of protection. `upload` is excluded — its
 *  codegen collapses every file in a multi-file upload to the same single secret
 *  reference, so marking it secret would silently corrupt multi-file uploads. */
const SECRETABLE_TYPES: ReadonlySet<ActionType> = new Set([
  'fill', 'press', 'selectOption', 'assertText', 'assertValue',
])

export function isSecretable(action: { type: ActionType; values?: string[] }): boolean {
  if (!SECRETABLE_TYPES.has(action.type)) return false
  // A multi-select's values[] takes precedence over `value` at replay/export, but only
  // `value` can be encrypted — marking it secret would leave the real selections in
  // plaintext while giving a false sense of protection. Same reasoning as the `upload`
  // exclusion above.
  if (action.type === 'selectOption' && (action.values?.length ?? 0) > 1) return false
  return true
}
