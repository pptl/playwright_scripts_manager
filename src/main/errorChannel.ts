import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS, type AppErrorPayload } from '../shared/types'

/**
 * Main's half of the user-visible error channel (A3 in the cleanup backlog).
 *
 * Storage and the recorder have no `BrowserWindow` — threading one through every
 * `FlowStorage` call is not an option — so the window lives here instead. This is a
 * **leaf module** for exactly the reason `stores/errorStore.ts` is one on the renderer
 * side: it is reached for from modules that are themselves reached for from everywhere,
 * so it must import nothing that could close a cycle. It knows electron's type and the
 * shared channel constants, and nothing else.
 *
 * Everything raised here becomes a toast. Main never raises a modal: none of these are
 * questions the user can answer in a dialog, and a toast never expires on its own.
 */

/** Buffered reports are unbounded otherwise — a workspace that fails to scaffold could
 *  in principle report on a loop before anyone is listening. */
const MAX_BUFFERED = 20

let sink: BrowserWindow | null = null
let buffered: AppErrorPayload[] = []
/**
 * The gate is "has the renderer collected the backlog yet", NOT "is the sink set yet".
 *
 * `setErrorSink` runs inside `registerIpcHandlers`, which is well before the renderer has
 * mounted and subscribed — anything sent live in that window would still be dropped, which
 * is the very failure mode this channel exists to remove. Buffering until the explicit
 * drain closes that gap: earlier reports are in the buffer, later ones go live, and the
 * renderer's subscribe-then-drain order means nothing can fall between the two.
 */
let drained = false

export function setErrorSink(win: BrowserWindow): void {
  sink = win
}

/** Hand the renderer everything reported before it was listening, and switch to live sends. */
export function drainBufferedErrors(): AppErrorPayload[] {
  drained = true
  const queued = buffered
  buffered = []
  return queued
}

/**
 * Report a failure to the user.
 *
 * Always logs as well, so the console keeps everything it had before — it just stops
 * being the only place a failure exists.
 */
export function reportToUser(
  title: string,
  detail?: string,
  tone: AppErrorPayload['tone'] = 'error',
): void {
  console.error(`[FlowTest] ${title}`, detail ?? '')

  const payload: AppErrorPayload = { title, detail, tone }

  if (!drained) {
    buffered.push(payload)
    if (buffered.length > MAX_BUFFERED) buffered.shift()
    return
  }
  // The window can be gone (quitting, or a reload in dev) — sending to destroyed
  // webContents throws, and a failure to report a failure helps nobody.
  if (sink && !sink.isDestroyed()) {
    sink.webContents.send(IPC_CHANNELS.APP_ERROR, payload)
  }
}

/** `catch` bodies get an `unknown`; this is the one shape they all turn it into. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** True when a filesystem error is just "it isn't there" — legitimate for load and delete. */
export function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
}
