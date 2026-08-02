import type { FlowProfile, Project } from '@shared/types'
import { flattenProjectEnvVars, resolveValue } from '@shared/variableResolver'

/**
 * The flat variable maps the renderer hands to the main process for replay, recording,
 * export and test runs. Previously duplicated in usePlaywright and Toolbar.
 *
 * Private values stay as ciphertext here — the renderer has no key. The main process
 * unwraps them at the IPC boundary (see decryptConfig in ipcHandlers).
 */

/** Active project's environment variables, flattened for the active environment. */
export function getEnvVars(
  project: Project | null | undefined,
  activeEnvironmentId: string | null | undefined,
): Record<string, string> {
  return flattenProjectEnvVars(project?.envVars, activeEnvironmentId)
}

/** Which project env-var keys hold private values. */
export function getSecretEnvKeys(project: Project | null | undefined): string[] {
  return (project?.envVars ?? []).filter((v) => v.secret).map((v) => v.key)
}

/**
 * Build profileVars with env-aware resolution: `envValues[activeEnvId] ?? value`, then
 * resolve any `{{envKey}}` references against the active project's env vars.
 *
 * References to *private* env vars are deliberately left unresolved. Substituting them
 * here would splice ciphertext into the middle of a larger string, which no later
 * decrypt could recover; leaving the placeholder lets the main process resolve it after
 * decryption instead (Replayer.resolveValueWithSession / ScriptExporter.resolveProfile
 * both do a multi-pass resolve over already-decrypted maps).
 */
export function buildProfileVars(
  profile: FlowProfile | null | undefined,
  activeEnvironmentId: string | null | undefined,
  envVars: Record<string, string>,
  secretEnvKeys: string[] = [],
): Record<string, string> | undefined {
  if (!profile) return undefined
  const secret = new Set(secretEnvKeys)
  const resolvable = Object.fromEntries(
    Object.entries(envVars).filter(([k]) => !secret.has(k)),
  )
  return Object.fromEntries(
    profile.vars.map((v) => {
      const raw = (activeEnvironmentId && v.envValues?.[activeEnvironmentId]) ?? v.value
      return [v.key, resolveValue(raw, undefined, resolvable)]
    }),
  )
}
