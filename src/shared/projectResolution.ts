import { DEFAULT_PROJECT_ID } from './types'

/**
 * Resolve which project a flow belongs to. A bare `?? DEFAULT_PROJECT_ID` only catches
 * `null`/`undefined` — it doesn't handle a `projectId` that points at a project which no
 * longer exists (e.g. a deleted project's flow that failed to cascade-delete, or a workspace
 * copied from elsewhere). Both cases fold into the reserved default project.
 */
export function resolveProjectId(
  flow: { projectId?: string },
  knownProjectIds: Set<string>,
): string {
  return flow.projectId && knownProjectIds.has(flow.projectId) ? flow.projectId : DEFAULT_PROJECT_ID
}
