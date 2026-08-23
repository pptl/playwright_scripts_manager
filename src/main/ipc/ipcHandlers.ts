import { BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { basename, dirname, join } from 'path'
import { IPC_CHANNELS, SECRETS_FILE } from '../../shared/types'
import type {
  ReplayToNodePayload,
  ExportScriptsPayload,
  FlowSavePayload,
  FlowLoadPayload,
  RecordingStartPayload,
  RecordingStartResult,
  ProjectSavePayload,
  ProjectLoadPayload,
  ResolutionContext,
  WorkspaceInfo,
} from '../../shared/types'
import { isCallFlowAction } from '../../shared/types'
import { BrowserController } from '../playwright/browserController'
import { Recorder } from '../playwright/recorder'
import { Replayer, newReplaySession, isReplayCancelled } from '../playwright/replayer'
import type { CancelSignal } from '../playwright/replayer'
import { FlowStorage } from '../storage/flowStorage'
import { FixtureStorage } from '../storage/fixtureStorage'
import { ProjectStorage } from '../storage/projectStorage'
import { ScriptExporter } from '../storage/scriptExporter'
import {
  getWorkspaceRoot,
  hasWorkspace,
  getRecentWorkspaces,
  setWorkspaceRoot,
  removeRecentWorkspace,
  configPath,
  warnAbout,
} from '../storage/workspace'
import * as vault from '../security/vault'
import { recryptWorkspace } from '../security/recrypt'
import { setErrorSink, drainBufferedErrors } from '../errorChannel'
import { hasChromium, isMissingBrowserError } from '../playwright/browserCheck'
import {
  resolvePlaywrightCli,
  runPlaywright,
  MISSING_CLI_MESSAGE,
  HTML_REPORT_DIR,
} from '../playwright/runner'

let browserController: BrowserController | null = null
let recorder: Recorder | null = null
/** Stop switch for the in-flight replay — the signal only, never the Replayer: holding the
 *  Replayer module-level would retain the finished run's Page and session vars (see the
 *  handler-local note in REPLAY_TO_NODE). Nulled in that handler's finally. */
let activeReplaySignal: CancelSignal | null = null
/** The in-flight child-process run — RUN_TESTS or BROWSER_INSTALL, since both stream into
 *  the same TestOutputModal. `cancelled` is set even before a child exists, so a ⏹ during
 *  the export phase still aborts. Nulled in a finally. */
let activeRun: { cancelled: boolean; kill: () => void } | null = null
/** The in-flight RECORDING_START — the switch only, shaped like `activeRun` rather than like
 *  `activeReplaySignal`, because what has to be interruptible is not one await but a whole
 *  sequence (browser launch → branch-recording silent replay → recorder start). A signal
 *  alone would only cover the replay; the `cancelled` flag covers every gap around it.
 *  Nulled in that handler's finally. */
let activeRecordingStart: { cancelled: boolean; cancel: () => void } | null = null

export function registerIpcHandlers(win: BrowserWindow): void {
  // Give the error channel its window. Reports raised before the renderer drains (every
  // startup failure, since loadSettings runs before this window even exists) stay buffered.
  setErrorSink(win)
  ipcMain.handle(IPC_CHANNELS.APP_ERRORS_DRAIN, () => drainBufferedErrors())

  /** Copy files into fixtures/, returning the data-root-relative paths stored on Actions. */
  const importFiles = async (absPaths: string[]): Promise<string[]> =>
    (await Promise.all(absPaths.map((p) => FixtureStorage.importFile(p)))).map((i) => i.stored)

  // Manual picker for the PropertyPanel (drag & drop uploads and older nodes).
  // Recording never comes through here — the browser shows its own dialog.
  ipcMain.handle(IPC_CHANNELS.PICK_FILES, async (_e, { multiple }: { multiple?: boolean } = {}) => {
    const result = await dialog.showOpenDialog(win, {
      title: '選擇要上傳的檔案',
      properties: (multiple ?? true) ? ['openFile', 'multiSelections'] : ['openFile'],
    })
    if (result.canceled || !result.filePaths.length) return []
    return await importFiles(result.filePaths)
  })

  // Hand-typed paths bypass the picker, so they arrive absolute and would pin the
  // flow to one machine. Rewrite them relative to the workspace (or copy them in).
  ipcMain.handle(IPC_CHANNELS.NORMALIZE_PATHS, async (_e, paths: string[]) =>
    await Promise.all(paths.map((p) => FixtureStorage.normalizeStoredPath(p))),
  )

  // ── Recording ────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.RECORDING_START,
    async (_e, payload: RecordingStartPayload): Promise<RecordingStartResult> => {
      // Branch recording silently replays first, which may type private values.
      if (payload.branchFromNodeId) assertUnlocked()

      const session = newReplaySession()
      const start = {
        cancelled: false,
        cancel: () => {
          start.cancelled = true
          // Interrupts the silent replay mid-action; a no-op once it has finished.
          session.signal.cancel()
        },
      }
      activeRecordingStart = start
      // Called at every gap between the awaits below — a ⏹ can land in any of them, and a
      // cancel that is only honoured in some is indistinguishable from the bug this fixes.
      const cancelled = () => start.cancelled

      try {
        // Always relaunch browser — _enableRecorder can only be called once per context.
        // Drop the previous recorder with it: its context is gone, so stopping it later
        // would only throw.
        if (browserController) {
          await browserController.close().catch(() => {})
        }
        recorder = null
        browserController = new BrowserController()
        await browserController.launch({ maximized: true })
        if (cancelled()) return { started: false }
        const page = browserController.getPage()

        // Branch recording: silently replay to the branch point first. It runs on `session`,
        // so RECORDING_STOP can interrupt it (see A2 in the cleanup backlog) — the browser is
        // left open, exactly as a cancelled REPLAY_TO_NODE leaves it.
        if (payload.branchFromNodeId && payload.branchNodes?.length) {
          const silentReplayer = new Replayer(
            page,
            payload.baseURL,
            decryptContext(payload.ctx),
            session,
          )
          try {
            await silentReplayer.replayToNode(
              payload.branchNodes,
              payload.branchFromNodeId,
              () => {},  // no UI feedback during silent replay
              () => {},
              payload.replaySpeed ?? 200,
            )
          } catch (err) {
            // A cancel is the user pressing ⏹, not a failure: reporting it would put
            // "靜默重播失敗" on screen for a deliberate action.
            if (!isReplayCancelled(err)) {
              win.webContents.send(IPC_CHANNELS.REPLAY_ERROR, `靜默重播失敗: ${String(err)}`)
            }
            return { started: false }
          }
          if (cancelled()) return { started: false }
        }

        // The locator picker (Cell vs Row) is now handled in-browser by CodegenCapture,
        // so every action arrives here finalised and is forwarded straight to the renderer.
        // Built into a local and published to `recorder` only once it is actually recording:
        // otherwise a ⏹ landing inside start() would call stop() on a half-started recorder.
        const started = new Recorder(
          page,
          (action) => {
            win.webContents.send(IPC_CHANNELS.ACTION_CAPTURED, action)
          },
          (payload) => {
            // Late popup attribution: patch the already-captured action in the renderer
            win.webContents.send(IPC_CHANNELS.ACTION_UPDATED, payload)
          },
          // Uploads: the real paths CDP read out of the browser, copied into fixtures/
          importFiles,
          (actionId) => {
            // Un-record the click that opened the file chooser
            win.webContents.send(IPC_CHANNELS.ACTION_REMOVED, actionId)
          },
        )
        // For branch recording, don't navigate (we're already at the right page)
        await started.start(payload.branchFromNodeId ? undefined : payload.baseURL)
        if (cancelled()) {
          await started.stop().catch(() => {})
          return { started: false }
        }
        recorder = started
        return { started: true }
      } finally {
        // Only if it is still ours: a cancelled start unwinds asynchronously, so the user can
        // press ▶ again and have a second start install its own switch before this one gets
        // here. A bare `= null` would disarm that second start's ⏹.
        if (activeRecordingStart === start) activeRecordingStart = null
      }
    },
  )

  ipcMain.handle(IPC_CHANNELS.RECORDING_STOP, async () => {
    // Cancel FIRST. While a branch recording is still silently replaying, `recorder` is null
    // and the stop below is a no-op — yet the renderer has already cleared recordingHeadId,
    // so the start would go on to record actions that then append as floating roots with no
    // recording UI on screen (A2 in the cleanup backlog).
    activeRecordingStart?.cancel()
    await recorder?.stop()
    recorder = null
  })

  // ── Replay ───────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.REPLAY_TO_NODE, async (_e, payload: ReplayToNodePayload) => {
    const session = newReplaySession()
    activeReplaySignal = session.signal
    try {
      assertUnlocked()
      if (!browserController || !browserController.isRunning()) {
        browserController = new BrowserController()
        await browserController.launch({ maximized: true })
      }
      const page = browserController.getPage()
      // Handler-local: nothing outside this call needs it, and holding it module-level
      // would retain the finished replay's Page and session vars until the next run.
      const replayer = new Replayer(page, payload.baseURL, decryptContext(payload.ctx), session)

      await replayer.replayToNode(
        payload.nodes,
        payload.targetNodeId,
        (nodeId) => win.webContents.send(IPC_CHANNELS.REPLAY_NODE_START, nodeId),
        (nodeId, success, error) =>
          win.webContents.send(IPC_CHANNELS.REPLAY_NODE_COMPLETE, { nodeId, success, error }),
        payload.speed,
      )
      win.webContents.send(IPC_CHANNELS.REPLAY_FINISHED)
    } catch (err) {
      if (isReplayCancelled(err)) win.webContents.send(IPC_CHANNELS.REPLAY_CANCELLED)
      else win.webContents.send(IPC_CHANNELS.REPLAY_ERROR, String(err))
    } finally {
      activeReplaySignal = null
    }
  })

  // The browser is deliberately left OPEN. Stopping mid-flow is nearly always so the user
  // can inspect the page they got stuck on; closing the context would also be the only
  // thing that could settle the orphaned Playwright calls race() abandons, and their late
  // "Target closed" rejections are not worth the lost page state.
  ipcMain.handle(IPC_CHANNELS.REPLAY_CANCEL, async () => {
    // A no-op when nothing is running or ⏹ was already pressed (CancelSignal.cancel is
    // itself idempotent). REPLAY_CANCELLED is sent by the handler above, never here —
    // otherwise a late second press could clear a freshly started run's canvas state.
    activeReplaySignal?.cancel()
  })


  // ── Storage ──────────────────────────────────────────────
  // Resolves with the `updatedAt` that landed on disk — see FlowStorage.save.
  ipcMain.handle(IPC_CHANNELS.FLOW_SAVE, async (_e, payload: FlowSavePayload) => {
    return await FlowStorage.save(payload.flow, { touch: payload.touch })
  })

  ipcMain.handle(IPC_CHANNELS.FLOW_LOAD, async (_e, payload: FlowLoadPayload) => {
    return await FlowStorage.load(payload.flowId)
  })

  ipcMain.handle(IPC_CHANNELS.FLOW_LIST, async () => {
    return await FlowStorage.list()
  })

  ipcMain.handle(IPC_CHANNELS.FLOW_DELETE, async (_e, flowId: string) => {
    await FlowStorage.delete(flowId)
  })

  ipcMain.handle(IPC_CHANNELS.FLOW_GET, async (_e, { flowId }: { flowId: string }) => {
    return await FlowStorage.load(flowId)
  })

  // ── Projects ─────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.PROJECT_SAVE, async (_e, payload: ProjectSavePayload) => {
    await ProjectStorage.save(payload.project)
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_LOAD, async (_e, payload: ProjectLoadPayload) => {
    return await ProjectStorage.load(payload.projectId)
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_LIST, async () => {
    return await ProjectStorage.list()
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_DELETE, async (_e, projectId: string) => {
    await ProjectStorage.delete(projectId)
  })

  ipcMain.handle(
    IPC_CHANNELS.FLOW_CHECK_CYCLE,
    async (_e, { currentFlowId, candidateSubFlowId }: { currentFlowId: string; candidateSubFlowId: string }) => {
      return await hasCallFlowCycle(currentFlowId, candidateSubFlowId)
    },
  )

  // ── Export ───────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.EXPORT_SCRIPTS, async (_e, payload: ExportScriptsPayload) => {
    assertUnlocked()
    return await ScriptExporter.export(payload.flow, decryptContext(payload.ctx))
  })

  // ── Run Tests ────────────────────────────────────────────
  const out = (text: string): void => win.webContents.send(IPC_CHANNELS.TEST_OUTPUT, text)

  ipcMain.handle(IPC_CHANNELS.RUN_TESTS, async (_e, payload: ExportScriptsPayload) => {
    const finish = (exitCode: number, cancelled = false): void => {
      // A killed run is never a pass, whatever exit code the OS happened to report.
      win.webContents.send(IPC_CHANNELS.TEST_FINISHED, {
        exitCode,
        passed: exitCode === 0 && !cancelled,
        cancelled,
      })
    }

    // Registered before the export phase so a ⏹ landing there is still honoured —
    // ScriptExporter.export cannot itself be interrupted, but it takes milliseconds and we
    // check the flag the moment it returns, before anything is spawned.
    const run = { cancelled: false, kill: () => {} }
    activeRun = run

    try {
      const cli = resolvePlaywrightCli()
      if (!cli) {
        out(MISSING_CLI_MESSAGE)
        return finish(1)
      }

      // 1. Export script
      let specPath: string
      let secretEnv: Record<string, string> = {}
      const config = decryptContext(payload.ctx)
      try {
        assertUnlocked()
        specPath = await ScriptExporter.export(payload.flow, config)
        // Private values are emitted as process.env lookups, never literals. Handing them
        // to the child process means an in-app run leaves no plaintext on disk at all.
        secretEnv = await ScriptExporter.collectSecretEnv(payload.flow, config)
        out(`✓ 腳本已匯出: ${specPath}\n`)
        if (Object.keys(secretEnv).length) {
          out(`✓ 已注入 ${Object.keys(secretEnv).length} 個私密變數 (僅存在於記憶體)\n`)
        }
      } catch (err) {
        out(`✗ 匯出失敗: ${String(err)}\n`)
        return finish(1)
      }

      if (run.cancelled) {
        out('\n⏹ 已中止 (尚未開始執行)\n')
        return finish(1, true)
      }

      // 2. Run the bundled CLI. Only the filename is passed: the generated config
      //    sets testDir to './exports', and Playwright treats a path argument as a
      //    regex against paths relative to testDir, so 'exports/x.spec.ts' matches
      //    nothing. --config is explicit so a config higher up the user's tree
      //    cannot take over the run.
      const specFilename = basename(specPath)
      const cwd = getWorkspaceRoot()
      const args = ['test', specFilename, '--config', configPath(), '--reporter=list,html']

      out(`✓ 執行器: ${cli.path} (v${cli.version})\n`)
      out(`▶ playwright ${args.join(' ')}\n\n`)

      const handle = runPlaywright(cli, args, cwd, out, secretEnv)
      run.kill = handle.cancel
      // ⏹ can land in the gap between the spawn above and the assignment.
      if (run.cancelled) handle.cancel()

      const { exitCode, output, cancelled } = await handle.promise

      if (cancelled) {
        out('\n⏹ 測試已中止\n')
        return finish(exitCode, true)
      }
      if (exitCode !== 0 && isMissingBrowserError(output)) {
        out('\n⚠ 缺少 Chromium 瀏覽器 — 請點擊「安裝瀏覽器」後重試。\n')
      }
      finish(exitCode)
    } finally {
      activeRun = null
    }
  })

  ipcMain.handle(IPC_CHANNELS.TEST_CANCEL, async () => {
    if (!activeRun || activeRun.cancelled) return
    activeRun.cancelled = true
    out('\n⏹ 已要求中止…\n')
    // A no-op if the child has not spawned yet — the flag above is what covers that window.
    activeRun.kill()
  })

  ipcMain.handle(IPC_CHANNELS.SHOW_REPORT, async () => {
    const cli = resolvePlaywrightCli()
    if (!cli) return out(MISSING_CLI_MESSAGE)

    await killProcessOnPort(9323)
    // Detached: the report server outlives this handler until the user closes it.
    spawn(process.execPath, [cli.path, 'show-report', HTML_REPORT_DIR], {
      cwd: getWorkspaceRoot(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: cli.nodePath },
      detached: true,
      stdio: 'ignore',
    }).unref()
  })

  // ── Browsers ─────────────────────────────────────────────
  // No separate "is Chromium installed?" channel — WORKSPACE_GET already reports it.
  ipcMain.handle(IPC_CHANNELS.BROWSER_INSTALL, async () => {
    const cli = resolvePlaywrightCli()
    if (!cli) {
      out(MISSING_CLI_MESSAGE)
      return false
    }
    out('▶ 正在下載 Chromium…\n\n')
    // Shares activeRun with RUN_TESTS: both stream into the same TestOutputModal, so its
    // ⏹ has to reach whichever one is running. Aborting a 150 MB download on a bad
    // connection is arguably the more valuable of the two.
    const run = { cancelled: false, kill: () => {} }
    activeRun = run
    try {
      const handle = runPlaywright(cli, ['install', 'chromium'], getWorkspaceRoot(), out)
      run.kill = handle.cancel
      if (run.cancelled) handle.cancel()

      const { exitCode, cancelled } = await handle.promise
      out(cancelled
        ? '\n⏹ 安裝已中止\n'
        : exitCode === 0 ? '\n✓ 瀏覽器安裝完成\n' : `\n✗ 安裝失敗 (exit ${exitCode})\n`)
      win.webContents.send(IPC_CHANNELS.TEST_FINISHED, {
        exitCode,
        passed: exitCode === 0 && !cancelled,
        cancelled,
      })
      return exitCode === 0 && !cancelled
    } finally {
      activeRun = null
    }
  })

  // ── Workspace ────────────────────────────────────────────
  const workspaceInfo = async (): Promise<WorkspaceInfo> => ({
    root: hasWorkspace() ? getWorkspaceRoot() : null,
    recent: await Promise.all(
      getRecentWorkspaces().map(async (p) => ({
        path: p,
        name: basename(p) || p,
        exists: await pathExists(p),
      })),
    ),
    hasChromium: await hasChromium(),
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_GET, workspaceInfo)

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_PICK, async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '選擇工作區資料夾',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths.length) return null

    const dir = result.filePaths[0]
    const warning = warnAbout(dir)
    if (warning) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['取消', '仍要使用'],
        defaultId: 0,
        cancelId: 0,
        message: warning,
        detail: dir,
      })
      if (response === 0) return null
    }

    await openWorkspace(dir)
    return await workspaceInfo()
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_SET, async (_e, dir: string) => {
    await openWorkspace(dir)
    return await workspaceInfo()
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_FORGET, async (_e, dir: string) => {
    await removeRecentWorkspace(dir)
    return await workspaceInfo()
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_REVEAL, async () => {
    if (hasWorkspace()) await shell.openPath(getWorkspaceRoot())
  })

  // ── Private data (vault) ─────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.VAULT_STATUS, async () => {
    await vault.load()
    return vault.status()
  })

  ipcMain.handle(IPC_CHANNELS.VAULT_SETUP, async (_e, passphrase: string) => {
    await vault.setup(passphrase)
    return vault.status()
  })

  ipcMain.handle(IPC_CHANNELS.VAULT_UNLOCK, async (_e, passphrase: string) => {
    const ok = await vault.unlock(passphrase)
    return { ok, status: vault.status() }
  })

  ipcMain.handle(IPC_CHANNELS.VAULT_LOCK, async () => {
    vault.lock()
    return vault.status()
  })

  ipcMain.handle(
    IPC_CHANNELS.VAULT_CHANGE_PASSPHRASE,
    async (_e, { oldPassphrase, newPassphrase }: { oldPassphrase: string; newPassphrase: string }) => {
      // Every stored ciphertext is rewritten under the new key before the new metadata is
      // committed, and `recryptWorkspace` is all-or-nothing about that rewrite (staged
      // writes + a backup it restores from), so a failure anywhere leaves the whole
      // workspace on the old passphrase — files included, not just the metadata.
      const ok = await vault.changePassphrase(oldPassphrase, newPassphrase, async (recrypt) => {
        await recryptWorkspace(recrypt)
      })

      // A16: every stored secret on disk is now under the new key, but the renderer is still
      // holding the OLD ciphertext for whatever flow is open — and its next autosave would
      // write that straight back over what we just rewrote. Focus reload is the existing
      // reconciliation path, and the window never lost focus here, so trigger it directly.
      // Only on success: a rejected old passphrase never ran the rewrite at all.
      if (ok) win.webContents.send(IPC_CHANNELS.WORKSPACE_RELOAD)
      return { ok, status: vault.status() }
    },
  )

  // Encrypt on the renderer's behalf — the key never crosses the bridge.
  ipcMain.handle(IPC_CHANNELS.SECRET_ENCRYPT, async (_e, plain: string) => vault.encrypt(plain))

  // Single-value reveal behind the 👁 button.
  ipcMain.handle(IPC_CHANNELS.SECRET_REVEAL, async (_e, envelope: string) =>
    vault.decryptIfNeeded(envelope),
  )

  // Write the gitignored env file an external `npx playwright test` reads.
  ipcMain.handle(IPC_CHANNELS.SECRETS_FILE_WRITE, async (_e, payload: ExportScriptsPayload) => {
    const env = await ScriptExporter.collectSecretEnv(payload.flow, decryptContext(payload.ctx))
    const path = join(getWorkspaceRoot(), SECRETS_FILE)
    const body = Object.entries(env)
      .map(([k, v]) => `${k}=${v.replace(/\r?\n/g, '\\n')}`)
      .join('\n')
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, body + (body ? '\n' : ''), 'utf-8')
    return { path, count: Object.keys(env).length }
  })
}

/**
 * Guard for operations that would otherwise push ciphertext into a real browser or a
 * generated spec. Deliberately blanket rather than "only when a secret is involved":
 * failing loudly beats silently typing `enc:v1:…` into a login form.
 */
function assertUnlocked(): void {
  if (vault.hasVault() && !vault.isUnlocked()) {
    throw new Error('[FlowTest] 保險庫已鎖定 — 請先輸入通行碼解鎖後再執行。')
  }
}

/**
 * Decrypt the flat variable maps the renderer assembled.
 *
 * The renderer cannot decrypt, so ciphertext travels through the existing plumbing as an
 * opaque string and is unwrapped here, at the boundary — and always BEFORE resolveValue
 * runs, since resolution would splice ciphertext into a larger string irrecoverably.
 */
function decryptContext(ctx: ResolutionContext = {}): ResolutionContext {
  return {
    ...ctx,
    profileVars: vault.decryptMap(ctx.profileVars),
    envVars: vault.decryptMap(ctx.envVars),
  }
}

/**
 * Switch workspaces. The old workspace's key must be dropped before the new root is set —
 * a key left in memory would decrypt nothing here and would only be a liability.
 */
async function openWorkspace(dir: string): Promise<void> {
  vault.lock()
  await setWorkspaceRoot(dir)
  await vault.load()
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function hasCallFlowCycle(
  startFlowId: string,
  candidateSubFlowId: string,
  visited = new Set<string>(),
): Promise<boolean> {
  if (candidateSubFlowId === startFlowId) return true
  if (visited.has(candidateSubFlowId)) return false
  visited.add(candidateSubFlowId)

  const subFlow = await FlowStorage.load(candidateSubFlowId)
  if (!subFlow) return false

  const nestedCallIds = subFlow.nodes
    .filter((n) => isCallFlowAction(n.action))
    .map((n) => n.action.subFlowId!)

  for (const nestedId of nestedCallIds) {
    if (await hasCallFlowCycle(startFlowId, nestedId, visited)) return true
  }
  return false
}

/** Kill any process listening on the given port, then wait briefly for the OS to free it. */
function killProcessOnPort(port: number): Promise<void> {
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
