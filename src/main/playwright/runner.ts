import { spawn } from 'child_process'
import { createRequire } from 'module'
import { delimiter, resolve, sep } from 'path'

/**
 * Running the generated specs used to mean `npx playwright test` with the cwd
 * set to wherever the data happened to live. That only ever worked by accident:
 * Playwright walks *up* from the cwd looking for a config, and in dev that
 * happened to land on this repo's own playwright.config.ts and node_modules.
 *
 * Once the data root is an arbitrary folder inside the user's project, both
 * assumptions break — their repo may carry its own playwright.config.ts (which
 * would silently hijack the run) and almost certainly has no @playwright/test,
 * leaving npx to download an arbitrary version, or fail with no network.
 *
 * So: run the CLI we ship, with Electron's own Node, against a config we
 * generated and name explicitly. The user's machine needs no Node at all.
 */

const _req = createRequire(import.meta.url)

/** asar is a read-only archive — spawn cannot execute out of it, so the
 *  Playwright packages are unpacked next to it (see build.asarUnpack). */
function unpacked(p: string): string {
  return p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
}

export interface PlaywrightCli {
  path: string
  version: string
  /** Our node_modules, handed to the child as NODE_PATH — see below. */
  nodePath: string
}

let cached: PlaywrightCli | null | undefined

/** The bundled Playwright CLI, or null when it is missing from the build. */
export function resolvePlaywrightCli(): PlaywrightCli | null {
  if (cached !== undefined) return cached

  try {
    const path = unpacked(_req.resolve('@playwright/test/cli'))
    const version = (_req('@playwright/test/package.json') as { version: string }).version
    // .../node_modules/@playwright/test/cli.js → .../node_modules
    cached = { path, version, nodePath: resolve(path, '..', '..', '..') }
  } catch {
    cached = null
  }
  return cached
}

/**
 * Where the HTML report goes, relative to the workspace. Forced through the env
 * var rather than left to the config file: an adopted folder may already carry a
 * playwright.config.ts pointing somewhere else, and SHOW_REPORT has to be able
 * to find the report without parsing it. This env var beats the config.
 */
export const HTML_REPORT_DIR = '.flowtest/playwright-report'

export interface SpawnResult {
  exitCode: number
  /** Everything the process wrote, so callers can inspect it after the fact. */
  output: string
  /** True only when cancel() killed this child. NOT inferred from exitCode: on win32
   *  taskkill /F yields exit 1, indistinguishable from a real test failure (POSIX is the
   *  one that gives code === null). The killer is the only reliable witness. */
  cancelled: boolean
}

export interface RunHandle {
  /** Resolves when the child exits — including when cancel() killed it. */
  promise: Promise<SpawnResult>
  /** Kill the child and everything it spawned. Idempotent; a no-op after exit. */
  cancel: () => void
}

/**
 * Kill a child and everything it spawned.
 *
 * child.kill() is not enough on win32. We spawn our own binary as a plain Node interpreter
 * (ELECTRON_RUN_AS_NODE); that wrapper spawns the Playwright runner, which spawns worker
 * processes and the browser. Windows has no process groups, so the signal reaches the
 * wrapper only and the workers keep running — still writing into .flowtest/ and still
 * holding the report directory. taskkill /F /T walks the tree. Same platform split, and the
 * same best-effort spirit, as killProcessOnPort in ipcHandlers.ts.
 *
 * POSIX is genuinely weaker here: without spawning detached there is no process group to
 * signal, so we kill the wrapper's direct children and then the wrapper. A grandchild that
 * reparented can survive. Accepted — detached would change stdio and Ctrl-C semantics for
 * every run, to fix a case this app's primary target does not hit.
 */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { shell: false, stdio: 'ignore' })
      .on('error', () => {})
  } else {
    spawn('pkill', ['-9', '-P', String(pid)], { stdio: 'ignore' }).on('error', () => {})
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
}

/** Kill any process listening on the given port, then wait briefly for the OS to free it.
 *  Same platform split and best-effort spirit as killTree above, but by port rather than by
 *  PID — SHOW_REPORT knows nothing about the report server's PID, only that something may
 *  still be squatting on 9323 from a previous run. */
export function killProcessOnPort(port: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const finder = spawn('cmd', ['/c', `netstat -ano | findstr :${port}`], { shell: false })
      let output = ''
      finder.stdout.on('data', (d: Buffer) => { output += d.toString() })
      finder.on('close', () => {
        const pids = new Set<string>()
        for (const line of output.split('\n')) {
          // Match only lines where port is the LOCAL address and state is LISTENING
          if (/LISTENING/i.test(line)) {
            const localAddr = line.trim().split(/\s+/)[1] ?? ''
            if (localAddr.endsWith(`:${port}`)) {
              const pid = line.trim().split(/\s+/).at(-1) ?? ''
              if (/^\d+$/.test(pid)) pids.add(pid)
            }
          }
        }
        if (pids.size === 0) return resolve()
        let remaining = pids.size
        const done = () => { if (--remaining === 0) setTimeout(resolve, 300) }
        for (const pid of pids) {
          const killer = spawn('taskkill', ['/F', '/PID', pid], { shell: true })
          killer.on('close', done)
          killer.on('error', done)
        }
      })
      finder.on('error', () => resolve())
    } else {
      const finder = spawn('sh', ['-c', `lsof -ti :${port}`], { shell: false })
      let output = ''
      finder.stdout.on('data', (d: Buffer) => { output += d.toString() })
      finder.on('close', () => {
        const pids = output.trim().split('\n').filter((p) => /^\d+$/.test(p))
        if (pids.length === 0) return resolve()
        let remaining = pids.length
        const done = () => { if (--remaining === 0) setTimeout(resolve, 300) }
        for (const pid of pids) {
          const killer = spawn('kill', ['-9', pid], { shell: false })
          killer.on('close', done)
          killer.on('error', done)
        }
      })
      finder.on('error', () => resolve())
    }
  })
}

/**
 * Run the bundled Playwright CLI, streaming its output as it arrives.
 *
 * Two env vars carry the whole "works in any folder" promise:
 *
 * - ELECTRON_RUN_AS_NODE turns our own binary into a plain Node interpreter, so
 *   the user's machine needs no Node installation.
 * - NODE_PATH points at our node_modules. Shipping the CLI is not enough on its
 *   own: both the generated config and every generated spec do
 *   `import ... from '@playwright/test'`, and Node resolves that by walking up
 *   from *the importing file*, i.e. the user's workspace — which has no
 *   node_modules and would fail with MODULE_NOT_FOUND. NODE_PATH is the
 *   fallback Node consults after that walk comes up empty.
 *
 * Returns a handle rather than a bare promise so the child cannot be spawned without also
 * handing back a way to kill it — the spawn used to be local to the promise executor, which
 * is precisely why runs were uncancellable.
 */
export function runPlaywright(
  cli: PlaywrightCli,
  args: string[],
  cwd: string,
  onOutput: (chunk: string) => void,
  /** Private values, as FT_SECRET_* names. Generated specs read them via process.env,
   *  so an in-app run never writes a plaintext credential to disk. */
  extraEnv: Record<string, string> = {},
): RunHandle {
  const child = spawn(process.execPath, [cli.path, ...args], {
    cwd,
    env: {
      ...process.env,
      ...extraEnv,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: process.env.NODE_PATH
        ? `${cli.nodePath}${delimiter}${process.env.NODE_PATH}`
        : cli.nodePath,
      PLAYWRIGHT_HTML_OUTPUT_DIR: HTML_REPORT_DIR,
      // The run must never block on a browser popping open by itself; the user
      // opens the report deliberately via SHOW_REPORT.
      PLAYWRIGHT_HTML_OPEN: 'never',
    },
  })

  let output = ''
  let killed = false
  let exited = false
  const pipe = (d: Buffer): void => {
    const text = d.toString()
    output += text
    onOutput(text)
  }
  child.stdout.on('data', pipe)
  child.stderr.on('data', pipe)

  const promise = new Promise<SpawnResult>((resolve) => {
    child.on('error', (err) => {
      exited = true
      const text = `\n✗ 無法啟動測試執行器: ${String(err)}\n`
      output += text
      onOutput(text)
      resolve({ exitCode: 1, output, cancelled: killed })
    })
    child.on('close', (code) => {
      exited = true
      resolve({ exitCode: code ?? 1, output, cancelled: killed })
    })
  })

  return {
    promise,
    cancel: () => {
      if (killed || exited || child.pid == null) return
      killed = true
      killTree(child.pid)
    },
  }
}

/**
 * `runPlaywright` plus the cancel-race wiring every caller needs: wire `run.kill` to the
 * handle the moment it exists, then immediately re-check `run.cancelled` — a ⏹ can land in
 * the gap between deciding to spawn and this handle existing, and that gap is real (RUN_TESTS
 * has an async export phase before it ever gets here). Shared by RUN_TESTS and
 * BROWSER_INSTALL, the only two runPlaywright call sites.
 */
export function runTracked(
  run: { cancelled: boolean; kill: () => void },
  cli: PlaywrightCli,
  args: string[],
  cwd: string,
  onOutput: (chunk: string) => void,
  extraEnv?: Record<string, string>,
): Promise<SpawnResult> {
  const handle = runPlaywright(cli, args, cwd, onOutput, extraEnv)
  run.kill = handle.cancel
  if (run.cancelled) handle.cancel()
  return handle.promise
}

export const MISSING_CLI_MESSAGE =
  '✗ 找不到內建的測試執行器 (@playwright/test)。\n' +
  '  這是打包問題，不是設定問題 — 請確認建置時有包含並解壓 node_modules/@playwright/test。\n'
