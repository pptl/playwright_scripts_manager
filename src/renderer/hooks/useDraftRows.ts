import React, { useEffect, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { SECRET_ENVELOPE_PREFIX } from '@shared/types'

/**
 * The draft state machine behind both variable tables (ProfileEditorModal's 配置變數
 * and ProjectEnvVarModal's 專案環境變數).
 *
 * Per CLAUDE.md's editing model these tables edit component-local state and reach the
 * store only when 儲存 is pressed — one save = one store write = one disk write. That
 * machine was written twice, near-verbatim, including the private-value round trip.
 * It lives here once now.
 *
 * What deliberately stays with the caller: `toEditRows` (each table's row shape),
 * the `commitXxx` call, the post-save reload, and every `confirm()` copy.
 *
 * There is NO dirty tracking and no unsaved-changes prompt — reloading silently drops
 * whatever was typed. That is the documented design; do not reintroduce a guard.
 */

const isCiphertext = (v: string): boolean => v.startsWith(SECRET_ENVELOPE_PREFIX)

/** The fields every draft row carries, whichever table it belongs to. */
export interface DraftRowBase {
  key: string
  value: string
  /** Private: the stored value is ciphertext and the UI masks it. */
  secret: boolean
  /** Stable client id — React key, and the key of ProfileVarTable's caret map. */
  _rid: string
  /** What is on disk (ciphertext for private rows); `value` only carries plaintext. */
  _storedValue: string
  _dirty: boolean
}

/** Mint the id for a row added in this draft. Loaded rows use `src:<index>`. */
export const newRowId = (): string => `new:${uuidv4()}`

/** Enter saves the whole table; spread onto the cell inputs. */
export const submitOnEnter = (save: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    save()
  }
}

interface UseDraftRowsOptions<R extends DraftRowBase> {
  /** Rows rebuilt from the store. Its identity changes on every store write, which is
   *  exactly why it is not a dependency of the reload effect — `reloadKey` is. */
  source: R[]
  /** Reloading the table is keyed on this. Empty string = nothing to edit. */
  reloadKey: string
  /** A fresh blank row, with the caller's table-specific fields filled in. */
  blankRow: () => R
  /** Vault gate — `useVault().ensureUsable`. */
  ensureUsable: () => boolean
  /** Rows whose private flag is locked (ProjectEnvVarModal's reserved `domain`). */
  canToggleSecret?: (row: R) => boolean
}

export function useDraftRows<R extends DraftRowBase>({
  source,
  reloadKey,
  blankRow,
  ensureUsable,
  canToggleSecret,
}: UseDraftRowsOptions<R>) {
  const [rows, setRows] = useState<R[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setRows(source)
    setError(null)
    // source is intentionally out of the deps: it changes identity on every store write,
    // and re-running then would wipe rows the user is still editing.
  }, [reloadKey])

  const setCell = <K extends keyof R>(rid: string, key: K, v: R[K]) => {
    setRows((prev) =>
      prev.map((r) => (r._rid === rid ? { ...r, [key]: v, _dirty: key === 'value' ? true : r._dirty } : r)),
    )
  }

  const addRow = () => setRows((prev) => [...prev, blankRow()])

  /** Local removal only — it reaches the store on 儲存, like every other edit here. */
  const removeRow = (rid: string) => setRows((prev) => prev.filter((r) => r._rid !== rid))

  /** Flip a row's private flag. Turning it ON needs a usable vault to encrypt with;
   *  turning it OFF needs one to recover the plaintext being un-encrypted. */
  const toggleSecret = async (rid: string) => {
    const row = rows.find((r) => r._rid === rid)
    if (!row) return
    if (canToggleSecret && !canToggleSecret(row)) return
    if (!ensureUsable()) return

    if (!row.secret) {
      setRows((prev) => prev.map((r) => (r._rid === rid ? { ...r, secret: true, _dirty: true } : r)))
      return
    }
    // Un-marking: pull the plaintext back into the field so the user can see what they
    // are about to store in the clear.
    let plain = row.value
    if (!row._dirty && isCiphertext(row._storedValue)) {
      try {
        plain = await window.electronAPI.revealSecret(row._storedValue)
      } catch {
        return setError('無法解密此變數，請先解鎖保險庫')
      }
    }
    setRows((prev) =>
      prev.map((r) => (r._rid === rid ? { ...r, secret: false, value: plain, _dirty: true } : r)),
    )
  }

  /** What actually gets written for a row: ciphertext for private values, and the
   *  untouched stored ciphertext when the user never revealed or edited it. */
  const storedValueFor = async (r: R): Promise<string> => {
    if (r.secret) {
      return !r._dirty && isCiphertext(r._storedValue)
        ? r._storedValue
        : await window.electronAPI.encryptSecret(r.value)
    }
    if (!r._dirty && isCiphertext(r._storedValue)) {
      return await window.electronAPI.revealSecret(r._storedValue)
    }
    return r.value
  }

  /**
   * The half of 儲存 that both tables share: validate the keys, gate the vault, then
   * resolve every row's on-disk value. Returns the values array (index-aligned with
   * `rows`) or `null` when it has already set `error` and the caller must abort.
   *
   * `extraCheck` is where a table adds its own rule — ProjectEnvVarModal uses it for
   * "`domain` must survive". Returning a string reports it as the error.
   */
  const prepareValues = async (
    extraCheck?: (keys: string[]) => string | null,
  ): Promise<string[] | null> => {
    const keys = rows.map((r) => r.key.trim())
    if (keys.some((k) => !k)) {
      setError('變數名稱不可為空')
      return null
    }
    const dup = keys.find((k, i) => keys.indexOf(k) !== i)
    if (dup) {
      setError(`變數名稱重複：${dup}`)
      return null
    }
    const extra = extraCheck?.(keys)
    if (extra) {
      setError(extra)
      return null
    }
    if (rows.some((r) => r.secret) && !ensureUsable()) return null
    setError(null)

    try {
      return await Promise.all(rows.map(storedValueFor))
    } catch (err) {
      setError(`加密失敗：${String(err instanceof Error ? err.message : err)}`)
      return null
    }
  }

  return { rows, setRows, error, setError, setCell, addRow, removeRow, toggleSecret, prepareValues }
}
