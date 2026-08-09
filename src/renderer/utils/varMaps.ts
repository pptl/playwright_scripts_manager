import type { Flow, Project, ResolutionContext } from '@shared/types'
import {
  flattenProjectEnvVars,
  pickProfile,
  resolveProfileVars,
} from '@shared/variableResolver'

/**
 * The flat variable maps the renderer hands to the main process for replay, recording,
 * export and test runs. Previously duplicated in usePlaywright and Toolbar.
 *
 * Private values stay as ciphertext here — the renderer has no key. The main process
 * unwraps them at the IPC boundary (see decryptContext in ipcHandlers).
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
 * Build one flow's profileVars.
 *
 * References to *private* env vars are deliberately left unresolved. Substituting them
 * here would splice ciphertext into the middle of a larger string, which no later
 * decrypt could recover; leaving the placeholder lets the main process resolve it after
 * decryption instead (Replayer.resolveValueWithSession / ScriptExporter.resolveProfile
 * both do a multi-pass resolve over already-decrypted maps).
 */
function buildProfileVars(
  flow: Flow | null | undefined,
  activeProfileId: string | null | undefined,
  activeEnvironmentId: string | null | undefined,
  envVars: Record<string, string>,
  secretEnvKeys: string[] = [],
): Record<string, string> | undefined {
  const profile = pickProfile(flow?.profiles, activeProfileId)
  if (!profile) return undefined
  const secret = new Set(secretEnvKeys)
  const resolvable = Object.fromEntries(
    Object.entries(envVars).filter(([k]) => !secret.has(k)),
  )
  return resolveProfileVars(profile.vars, activeEnvironmentId, resolvable)
}

/**
 * Everything replay / branch recording / export / run-tests needs, assembled the same way
 * each time. This is the renderer's single construction site for the 5 resolution fields.
 *
 * `activeProfileId` is returned as given, even when `pickProfile` fell back to the first
 * profile: it is what `subFlowProfileMapping` is keyed on, and remapping it here would
 * silently change which sub-flow profile a callFlow node resolves to.
 */
export function buildResolutionContext(
  flow: Flow | null | undefined,
  activeProfileId: string | null | undefined,
  activeEnvironmentId: string | null | undefined,
  project: Project | null | undefined,
): ResolutionContext {
  const envVars = getEnvVars(project, activeEnvironmentId)
  const secretEnvKeys = getSecretEnvKeys(project)
  return {
    profileVars: buildProfileVars(flow, activeProfileId, activeEnvironmentId, envVars, secretEnvKeys),
    activeProfileId: activeProfileId ?? undefined,
    activeEnvironmentId: activeEnvironmentId ?? undefined,
    envVars,
    activeProjectId: project?.id,
    secretEnvKeys,
  }
}
