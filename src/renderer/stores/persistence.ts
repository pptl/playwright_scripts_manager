import type { Flow, Project } from '@shared/types'
import { reportError } from './errorStore'

/**
 * Single point of ownership for writing renderer state to disk. Every store action and every
 * cross-domain action in `hooks/useFlowManager.ts` goes through these, so callers never have
 * to remember to save — and a failed write is always reported instead of vanishing.
 *
 * A leaf module: it imports no store other than `errorStore` (itself a leaf, chosen that way
 * for exactly this reason), which is what lets both `flowStore` and `projectStore` use it
 * while staying free of any import cycle between them.
 *
 * Fire-and-forget from the caller's perspective: `persistFlow` is never awaited inside
 * `runWithoutHistory` / `runAsOneHistoryStep` callbacks, which must stay synchronous.
 * That is also why a failure here has to raise a toast: nobody is awaiting it, so there is
 * no call site left that could surface it, and a lost write is lost user data.
 */

/**
 * The `updatedAt` main stamped on the last write we issued, per flow id — "what this
 * renderer put on disk". `usePlaywrightEvents` compares the disk copy against it to decide
 * whether a focus event found an EXTERNAL change.
 *
 * It lives here, not on the in-memory `Flow`, for two reasons. This module is a leaf by
 * design (see above), so writing the value back into the store would mean importing
 * `flowStore` — a `flowStore → persistence → flowStore` cycle, which is exactly what the
 * store split was for. And nothing else reads a flow's in-memory `updatedAt`: the flow list
 * renders the disk copy's, so the value has no reason to be on the object at all.
 *
 * The gate used to be `onDisk.updatedAt > open.updatedAt`, which was true after every local
 * edit: the renderer stamps its copy, `FlowStorage.save` then stamps its own a few ms later,
 * and that later one never travelled back. So every focus event reloaded the open flow and
 * `setCurrentFlow` wiped the undo history, the selection and the active profile with it.
 *
 * Known limitation, unchanged by this: an external write that leaves `updatedAt` untouched
 * (a hand edit, a checkout to a branch whose copy carries the same stamp) is still invisible.
 * Only a content signature could see that; a flow, unlike a project, has legitimately unsaved
 * in-memory state, so "differs from disk" cannot tell our own pending write from someone
 * else's edit. That is why this records a stamp rather than a signature.
 */
const lastWritten = new Map<string, string>()

/** The stamp main wrote for this flow, or undefined if this renderer never wrote it. */
export function lastWrittenStamp(flowId: string): string | undefined {
  return lastWritten.get(flowId)
}

export async function persistFlow(
  flow: Flow,
  opts?: { touch?: boolean; label?: string },
): Promise<void> {
  try {
    const stamp = await window.electronAPI.saveFlow(flow, opts?.touch)
    // Keep the greatest, not the last to arrive: concurrent invokes have no ordering
    // guarantee, and an older response landing last would leave the ledger describing a
    // write that has already been superseded — which reads as an external change next focus.
    const prev = lastWritten.get(flow.id)
    if (!prev || stamp > prev) lastWritten.set(flow.id, stamp)
  } catch (err) {
    reportError(opts?.label ?? `自動存檔失敗：${flow.name}`, err)
  }
}

/** Mirror of `persistFlow` for projects. Deliberately does NOT bump `updatedAt` — that is
 *  the caller's decision, and changing it here would alter which disk copies the focus
 *  reload considers newer. */
export async function persistProject(project: Project): Promise<void> {
  try {
    await window.electronAPI.saveProject(project)
  } catch (err) {
    reportError(`專案存檔失敗：${project.name}`, err)
  }
}
