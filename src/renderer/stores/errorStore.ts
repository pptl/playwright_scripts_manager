import { create } from 'zustand'

/**
 * The non-blocking half of the app's error channel (A3 in the cleanup backlog).
 *
 * `confirmStore.notify()` covers failures the user is standing there waiting for.
 * This covers the other kind — a failed autosave, a replay that died three nodes in,
 * a gesture the store refused — where a modal would interrupt whatever the user is
 * doing at the moment the failure happens to land.
 *
 * A leaf module: it imports no other store, exactly as `stores/persistence.ts` does
 * and for the same reason — `persistFlow` has to be able to report, and persistence
 * is used by both `flowStore` and `projectStore`, so anything it reaches for must be
 * incapable of closing an import cycle.
 */

export type ToastTone = 'error' | 'warning'

export interface Toast {
  id: number
  tone: ToastTone
  title: string
  detail?: string
  /** How many times this same failure has been reported. Rendered as ×N. */
  count: number
}

interface ErrorStore {
  toasts: Toast[]
  dismiss: (id: number) => void
  clearAll: () => void
}

/** Beyond this the stack stops being readable; the oldest is evicted. */
const MAX_TOASTS = 4

let nextId = 1

export const useErrorStore = create<ErrorStore>((set) => ({
  toasts: [],
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clearAll: () => set({ toasts: [] }),
}))

/** The one shape every call site should turn an unknown thrown value into. */
export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Report a background failure.
 *
 * Deduped on title + detail, because the failures that most need reporting are the
 * ones that repeat: a workspace that has become unwritable fails on every autosave,
 * and twenty separate toasts (or, worse, twenty modals) would be its own outage.
 * A repeat bumps `count` and moves the entry back to the front instead.
 *
 * Toasts never expire on their own. A3's symptom is "a failure the user never sees";
 * something that slides away after four seconds does not fix that.
 */
export function reportError(
  title: string,
  err?: unknown,
  opts?: { detail?: string; tone?: ToastTone },
): void {
  const detail = opts?.detail ?? (err === undefined ? undefined : formatError(err))
  const tone = opts?.tone ?? 'error'

  // Still logged: the console stays useful for anyone with DevTools open, it just
  // stops being the only place a failure exists.
  console.error(`[FlowTest] ${title}`, detail ?? '', err ?? '')

  useErrorStore.setState((s) => {
    const existing = s.toasts.find((t) => t.title === title && t.detail === detail)
    if (existing) {
      const bumped: Toast = { ...existing, count: existing.count + 1 }
      return { toasts: [bumped, ...s.toasts.filter((t) => t.id !== existing.id)] }
    }
    const added: Toast = { id: nextId++, tone, title, detail, count: 1 }
    return { toasts: [added, ...s.toasts].slice(0, MAX_TOASTS) }
  })
}
