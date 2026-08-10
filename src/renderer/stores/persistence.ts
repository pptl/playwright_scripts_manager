import type { Flow, Project } from '@shared/types'

/**
 * Single point of ownership for writing renderer state to disk. Every store action and every
 * cross-domain action in `hooks/useFlowManager.ts` goes through these, so callers never have
 * to remember to save — and a failed write is always logged instead of vanishing.
 *
 * A leaf module: it imports no store, which is what lets both `flowStore` and `projectStore`
 * use it while staying free of any import cycle between them.
 *
 * Fire-and-forget from the caller's perspective: `persistFlow` is never awaited inside
 * `runWithoutHistory` / `runAsOneHistoryStep` callbacks, which must stay synchronous.
 */

export async function persistFlow(flow: Flow, touch = true): Promise<void> {
  try {
    await window.electronAPI.saveFlow(flow, touch)
  } catch (err) {
    console.error('[persistence] Failed to save flow', flow.id, err)
  }
}

/** Mirror of `persistFlow` for projects. Deliberately does NOT bump `updatedAt` — that is
 *  the caller's decision, and changing it here would alter which disk copies the focus
 *  reload considers newer. */
export async function persistProject(project: Project): Promise<void> {
  try {
    await window.electronAPI.saveProject(project)
  } catch (err) {
    console.error('[persistence] Failed to save project', project.id, err)
  }
}
