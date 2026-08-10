import { create } from 'zustand'

/**
 * App-styled replacement for `window.confirm`.
 *
 * `window.confirm` is synchronous and blocking; a React modal is not. To keep call sites
 * looking the same (`if (!(await confirm({...}))) return`) without prop-drilling a dialog
 * through every component, requests go into this store and are rendered by the single
 * <ConfirmHost /> mounted in App.tsx.
 */

export interface ConfirmAction {
  id: string
  label: string
  tone?: 'primary' | 'danger' | 'ghost'
}

export interface ConfirmRequest {
  title: string
  /** Main body line. */
  message?: string
  /** Secondary line, e.g. 「此專案中的所有流程也將一併刪除，且無法復原。」 */
  detail?: string
  /** Defaults to 取消(ghost) + 確認(primary). */
  actions?: ConfirmAction[]
  /** Which action Enter triggers. Danger dialogs should leave this on 取消. */
  defaultActionId?: string
}

interface PendingConfirm extends ConfirmRequest {
  id: number
  resolve: (actionId: string | null) => void
}

interface ConfirmStore {
  queue: PendingConfirm[]
  /** Resolves with the chosen action id, or null when dismissed (Escape / backdrop). */
  ask: (req: ConfirmRequest) => Promise<string | null>
  /** Answer the front-most request. */
  answer: (actionId: string | null) => void
}

let nextId = 1

export const useConfirmStore = create<ConfirmStore>((set, get) => ({
  queue: [],

  ask: (req) =>
    new Promise<string | null>((resolve) => {
      set((s) => ({ queue: [...s.queue, { ...req, id: nextId++, resolve }] }))
    }),

  answer: (actionId) => {
    const [front, ...rest] = get().queue
    if (!front) return
    set({ queue: rest })
    front.resolve(actionId)
  },
}))

export const CONFIRM_CANCEL = 'cancel'
export const CONFIRM_OK = 'ok'

/**
 * `window.alert` replacement — one OK button, resolves when dismissed.
 *
 * The native dialog was unstyled, blocked the whole renderer, and could not be
 * raised from inside a modal without looking broken. Callers that only want to
 * tell the user something should await this rather than branching on a result.
 */
export async function notify(opts: {
  title: string
  message?: string
  detail?: string
  okLabel?: string
}): Promise<void> {
  await useConfirmStore.getState().ask({
    title: opts.title,
    message: opts.message,
    detail: opts.detail,
    actions: [{ id: CONFIRM_OK, label: opts.okLabel ?? '確定', tone: 'primary' }],
    defaultActionId: CONFIRM_OK,
  })
}

/** Yes/no sugar. Danger dialogs default Enter to 取消 so a stray Enter can't delete anything. */
export async function confirm(opts: {
  title: string
  message?: string
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}): Promise<boolean> {
  const answer = await useConfirmStore.getState().ask({
    title: opts.title,
    message: opts.message,
    detail: opts.detail,
    actions: [
      { id: CONFIRM_CANCEL, label: opts.cancelLabel ?? '取消', tone: 'ghost' },
      { id: CONFIRM_OK, label: opts.confirmLabel ?? '確認', tone: opts.danger ? 'danger' : 'primary' },
    ],
    defaultActionId: opts.danger ? CONFIRM_CANCEL : CONFIRM_OK,
  })
  return answer === CONFIRM_OK
}
