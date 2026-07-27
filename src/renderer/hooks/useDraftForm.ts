import { useState, useRef, useEffect, useCallback } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { confirmDiscard } from '../stores/confirmStore'

/**
 * Draft-then-commit editing.
 *
 * Every text/form field in the app edits a LOCAL draft and only reaches the store on an
 * explicit commit (儲存 / 確認). One commit = one store write = one disk write = one undo entry.
 * Single-gesture controls (dropdowns, drag, toggles) deliberately stay instant and do not use this.
 */

export interface UseDraftFormOptions<T extends object> {
  /** Canonical value from the store. */
  source: T
  /**
   * Identity of the edited entity. The draft re-baselines ONLY when this changes — never when
   * the `source` object identity changes. That is what keeps typing alive while the recorder
   * or a node drag replaces the underlying object.
   */
  resetKey: string | null
  /** Persist. Awaited; dirty clears on resolve. Throwing keeps the draft dirty. */
  onCommit: (values: T) => void | Promise<void>
  /** Return an error message to block the commit. */
  validate?: (values: T) => string | null
  /** Defaults to shallow Object.is over the union of both objects' own keys. */
  equals?: (a: T, b: T) => boolean
  /** Label for the unsaved-changes guard, e.g. '節點屬性'. Omit to opt out of the guard. */
  guardLabel?: string
}

export interface DraftForm<T extends object> {
  values: T
  setField: <K extends keyof T>(key: K, v: T[K]) => void
  patch: (p: Partial<T>) => void
  isDirty: boolean
  /** The store value moved underneath a dirty draft. */
  isStale: boolean
  error: string | null
  /** Returns true when the commit went through (or there was nothing to commit). */
  commit: () => Promise<boolean>
  /** Discard the draft and snap back to the store value. */
  reset: () => void
  /** Spread onto single-line inputs: Enter commits, Escape resets. */
  fieldKeyDown: (e: React.KeyboardEvent) => void
  /** Run `proceed` only after the unsaved-changes guard is satisfied. */
  guardedRun: (proceed: () => void | Promise<void>) => Promise<void>
}

function shallowEq<T extends object>(a: T, b: T): boolean {
  if (a === b) return true
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Unsaved-changes guard registry
// ---------------------------------------------------------------------------

interface DraftGuardEntry {
  label: string
  isDirty: () => boolean
  commit: () => Promise<boolean>
  reset: () => void
}

const guards = new Map<string, DraftGuardEntry>()

/** Registers a draft with the global guard. Returns the unregister function. */
export function registerDraftGuard(id: string, entry: DraftGuardEntry): () => void {
  guards.set(id, entry)
  return () => {
    guards.delete(id)
  }
}

/**
 * Call before any gesture that would discard an in-progress draft (switching node, switching
 * flow/profile/environment, closing a modal). Resolves true when it is safe to proceed.
 */
export async function ensureNoUnsavedDrafts(): Promise<boolean> {
  const dirty = [...guards.values()].filter((g) => g.isDirty())
  if (dirty.length === 0) return true

  const label = dirty.length === 1 ? dirty[0].label : `${dirty.length} 個編輯區塊`
  const choice = await confirmDiscard(label)
  if (choice === 'cancel') return false
  if (choice === 'discard') {
    dirty.forEach((g) => g.reset())
    return true
  }
  for (const g of dirty) {
    // A failed validation blocks the whole navigation so the user can fix it.
    if (!(await g.commit())) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// useDraftForm
// ---------------------------------------------------------------------------

export function useDraftForm<T extends object>(opts: UseDraftFormOptions<T>): DraftForm<T> {
  const { source, resetKey, onCommit, validate, equals, guardLabel } = opts
  const eq = equals ?? shallowEq

  const [values, setValues] = useState<T>(source)
  const [error, setError] = useState<string | null>(null)
  const baseline = useRef<T>(source)
  const prevKey = useRef<string | null>(resetKey)

  const isDirty = !eq(values, baseline.current)

  // Re-baseline during render (React's documented derive-state-from-props pattern) rather than
  // in an effect keyed on `source`. Keyed on `resetKey` only, so a new `source` OBJECT for the
  // same entity (node drag, ACTION_UPDATED) never clobbers in-progress typing.
  if (prevKey.current !== resetKey || (!isDirty && !eq(source, baseline.current))) {
    prevKey.current = resetKey
    baseline.current = source
    setValues(source)
    if (error) setError(null)
  }

  const isStale = isDirty && !eq(source, baseline.current)

  const setField = useCallback(<K extends keyof T>(key: K, v: T[K]) => {
    setValues((prev) => ({ ...prev, [key]: v }))
  }, [])

  const patch = useCallback((p: Partial<T>) => {
    setValues((prev) => ({ ...prev, ...p }))
  }, [])

  const reset = useCallback(() => {
    setValues(baseline.current)
    setError(null)
  }, [])

  // Kept in a ref so `commit` stays stable while always seeing the latest draft.
  const latest = useRef({ values, isDirty, onCommit, validate })
  latest.current = { values, isDirty, onCommit, validate }

  const commit = useCallback(async (): Promise<boolean> => {
    const { values: v, isDirty: dirty, onCommit: doCommit, validate: doValidate } = latest.current
    if (!dirty) return true
    const err = doValidate?.(v) ?? null
    if (err) {
      setError(err)
      return false
    }
    try {
      await doCommit(v)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    }
    baseline.current = v
    setValues(v)
    setError(null)
    return true
  }, [])

  const guardedRun = useCallback(
    async (proceed: () => void | Promise<void>) => {
      if (!latest.current.isDirty) {
        await proceed()
        return
      }
      const choice = await confirmDiscard(guardLabel ?? '目前的編輯')
      if (choice === 'cancel') return
      if (choice === 'save' && !(await commit())) return
      if (choice === 'discard') reset()
      await proceed()
    },
    [commit, reset, guardLabel],
  )

  const fieldKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void commit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        reset()
      }
    },
    [commit, reset],
  )

  // Register with the global guard so navigation elsewhere in the app can prompt.
  const guardId = useRef<string>()
  if (!guardId.current) guardId.current = uuidv4()
  const guardState = useRef({ isDirty, commit, reset })
  guardState.current = { isDirty, commit, reset }

  useEffect(() => {
    if (!guardLabel) return
    return registerDraftGuard(guardId.current!, {
      label: guardLabel,
      isDirty: () => guardState.current.isDirty,
      commit: () => guardState.current.commit(),
      reset: () => guardState.current.reset(),
    })
  }, [guardLabel])

  return { values, setField, patch, isDirty, isStale, error, commit, reset, fieldKeyDown, guardedRun }
}

// ---------------------------------------------------------------------------
// useDraftRows — table editing on top of useDraftForm
// ---------------------------------------------------------------------------

export type DraftRow<R> = R & {
  /** Stable client-side identity; survives add/remove/reorder within a draft. */
  _rid: string
  /** Index in the store's array at baseline time. null = added in this draft. */
  _origIndex: number | null
}

export interface UseDraftRowsOptions<R extends object> {
  /** Canonical rows from the store, in store order. */
  source: R[]
  resetKey: string | null
  onCommit: (rows: DraftRow<R>[]) => void | Promise<void>
  validate?: (rows: DraftRow<R>[]) => string | null
  /** Per-row field comparison; defaults to shallow. */
  rowEquals?: (a: R, b: R) => boolean
  guardLabel?: string
}

export interface DraftRows<R extends object>
  extends Omit<DraftForm<{ rows: DraftRow<R>[] }>, 'values' | 'setField' | 'patch'> {
  rows: DraftRow<R>[]
  setCell: <K extends keyof R>(rid: string, key: K, v: R[K]) => void
  /** Appends a draft-only row and returns its `_rid`. */
  addRow: (init: R) => string
  removeRow: (rid: string) => void
  isRowDirty: (rid: string) => boolean
}

export function useDraftRows<R extends object>(opts: UseDraftRowsOptions<R>): DraftRows<R> {
  const { source, resetKey, onCommit, validate, rowEquals, guardLabel } = opts
  const rowEq = rowEquals ?? shallowEq

  // Rebuilt whenever the source array identity changes; the draft only re-baselines on resetKey,
  // so this is just the candidate baseline value.
  const sourceRows: DraftRow<R>[] = source.map((r, i) => ({ ...r, _rid: `src:${i}`, _origIndex: i }) as DraftRow<R>)

  const form = useDraftForm<{ rows: DraftRow<R>[] }>({
    source: { rows: sourceRows },
    resetKey,
    onCommit: (v) => onCommit(v.rows),
    validate: validate ? (v) => validate(v.rows) : undefined,
    equals: (a, b) => {
      if (a.rows.length !== b.rows.length) return false
      return a.rows.every((r, i) => {
        const o = b.rows[i]
        return r._rid === o._rid && r._origIndex === o._origIndex && rowEq(r, o)
      })
    },
    guardLabel,
  })

  const { values, patch } = form
  const rows = values.rows

  const setCell = useCallback(
    <K extends keyof R>(rid: string, key: K, v: R[K]) => {
      patch({ rows: rows.map((r) => (r._rid === rid ? { ...r, [key]: v } : r)) })
    },
    [rows, patch],
  )

  const addRow = useCallback(
    (init: R) => {
      const rid = `new:${uuidv4()}`
      patch({ rows: [...rows, { ...init, _rid: rid, _origIndex: null } as DraftRow<R>] })
      return rid
    },
    [rows, patch],
  )

  const removeRow = useCallback(
    (rid: string) => {
      patch({ rows: rows.filter((r) => r._rid !== rid) })
    },
    [rows, patch],
  )

  const isRowDirty = useCallback(
    (rid: string) => {
      const row = rows.find((r) => r._rid === rid)
      if (!row) return false
      if (row._origIndex === null) return true
      const orig = source[row._origIndex]
      return !orig || !rowEq(row as unknown as R, orig)
    },
    [rows, source, rowEq],
  )

  return {
    rows,
    setCell,
    addRow,
    removeRow,
    isRowDirty,
    isDirty: form.isDirty,
    isStale: form.isStale,
    error: form.error,
    commit: form.commit,
    reset: form.reset,
    fieldKeyDown: form.fieldKeyDown,
    guardedRun: form.guardedRun,
  }
}
