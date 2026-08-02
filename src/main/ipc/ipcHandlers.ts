import { BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { basename } from 'path'
import { IPC_CHANNELS } from '../../shared/types'
import type {
  ReplayToNodePayload,
  ExportScriptsPayload,
  FlowSavePayload,
  FlowLoadPayload,
  RecordingStartPayload,
  ActionType,
  ProjectSavePayload,
  ProjectLoadPayload,
  WorkspaceInfo,
} from '../../shared/types'
import { isCallFlowAction } from '../../shared/types'
import { BrowserController } from '../playwright/browserController'
import { Recorder } from '../playwright/recorder'
import { Replayer } from '../playwright/replayer'
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
import { hasChromium, isMissingBrowserError } from '../playwright/browserCheck'
import {
  resolvePlaywrightCli,
  runPlaywright,
  MISSING_CLI_MESSAGE,
  HTML_REPORT_DIR,
} from '../playwright/runner'

let browserController: BrowserController | null = null
let recorder: Recorder | null = null
let replayer: Replayer | null = null

export function registerIpcHandlers(win: BrowserWindow): void {
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

  // ── Browser ──────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.BROWSER_LAUNCH, async () => {
    browserController = new BrowserController()
    await browserController.launch()
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_CLOSE, async () => {
    await browserController?.close()
    browserController = null
    recorder = null
    replayer = null
  })

  // ── Recording ────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.RECORDING_START, async (_e, payload: RecordingStartPayload) => {
    // Always relaunch browser — _enableRecorder can only be called once per context
    if (browserController) {
      await browserController.close().catch(() => {})
    }
    browserController = new BrowserController()
    await browserController.launch({ maximized: true })
    const page = browserController.getPage()

    // Branch recording: silently replay to the branch point first
    if (payload.branchFromNodeId && payload.branchNodes?.length) {
      const silentReplayer = new Replayer(page, payload.baseURL, payload.profileVars, payload.activeProfileId, payload.activeEnvironmentId, payload.envVars, payload.activeProjectId)
      try {
        await silentReplayer.replayToNode(
          payload.branchNodes,
          payload.branchFromNodeId,
          () => {},  // no UI feedback during silent replay
          () => {},
          payload.replaySpeed ?? 200,
        )
      } catch (err) {
        // If silent replay fails, abort and report
        win.webContents.send(IPC_CHANNELS.REPLAY_ERROR, `靜默重播失敗: ${String(err)}`)
        return
      }
    }

    // The locator picker (Cell vs Row) is now handled in-browser by CodegenCapture,
    // so every action arrives here finalised and is forwarded straight to the renderer.
    recorder = new Recorder(
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
    await recorder.start(payload.branchFromNodeId ? undefined : payload.baseURL)
  })

  ipcMain.handle(IPC_CHANNELS.RECORDING_STOP, async () => {
    await recorder?.stop()
    recorder = null
  })

  ipcMain.handle(IPC_CHANNELS.START_ASSERTION_PICK, async (_e, assertionType: ActionType) => {
    if (!recorder) return
    await recorder.startAssertionPick(
      assertionType as 'assertVisible' | 'assertText' | 'assertValue',
      () => win.webContents.send(IPC_CHANNELS.ASSERTION_PICK_CANCELLED),
    )
  })

  ipcMain.handle(IPC_CHANNELS.LOCATOR_PICK_RESOLVED, () => {
    recorder?.resume()
  })

  // ── Replay ───────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.REPLAY_TO_NODE, async (_e, payload: ReplayToNodePayload) => {
    try {
      if (!browserController || !browserController.isRunning()) {
        browserController = new BrowserController()
        await browserController.launch({ maximized: true })
      }
      const page = browserController.getPage()
      replayer = new Replayer(page, payload.baseURL, payload.profileVars, payload.activeProfileId, payload.activeEnvironmentId, payload.envVars, payload.activeProjectId)

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
      win.webContents.send(IPC_CHANNELS.REPLAY_ERROR, String(err))
    }
  })

  ipcMain.handle(IPC_CHANNELS.REPLAY_STOP, async () => {
    replayer = null
  })

  // ── Storage ──────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.FLOW_SAVE, async (_e, payload: FlowSavePayload) => {
    await FlowStorage.save(payload.flow, { touch: payload.touch })
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
    return await ScriptExporter.export(payload.flow, payload.config)
  })

  // ── Run Tests ────────────────────────────────────────────
  const out = (text: string): void => win.webContents.send(IPC_CHANNELS.TEST_OUTPUT, text)

  ipcMain.handle(IPC_CHANNELS.RUN_TESTS, async (_e, payload: ExportScriptsPayload) => {
    const finish = (exitCode: number): void => {
      win.webContents.send(IPC_CHANNELS.TEST_FINISHED, { exitCode, passed: exitCode === 0 })
    }

    const cli = resolvePlaywrightCli()
    if (!cli) {
      out(MISSING_CLI_MESSAGE)
      return finish(1)
    }

    // 1. Export script
    let specPath: string
    try {
      specPath = await ScriptExporter.export(payload.flow, payload.config)
      out(`✓ 腳本已匯出: ${specPath}\n`)
    } catch (err) {
      out(`✗ 匯出失敗: ${String(err)}\n`)
      return finish(1)
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

    const { exitCode, output } = await runPlaywright(cli, args, cwd, out)

    if (exitCode !== 0 && isMissingBrowserError(output)) {
      out('\n⚠ 缺少 Chromium 瀏覽器 — 請點擊「安裝瀏覽器」後重試。\n')
    }
    finish(exitCode)
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
  ipcMain.handle(IPC_CHANNELS.BROWSER_CHECK, async () => await hasChromium())

  ipcMain.handle(IPC_CHANNELS.BROWSER_INSTALL, async () => {
    const cli = resolvePlaywrightCli()
    if (!cli) {
      out(MISSING_CLI_MESSAGE)
      return false
    }
    out('▶ 正在下載 Chromium…\n\n')
    const { exitCode } = await runPlaywright(cli, ['install', 'chromium'], getWorkspaceRoot(), out)
    out(exitCode === 0 ? '\n✓ 瀏覽器安裝完成\n' : `\n✗ 安裝失敗 (exit ${exitCode})\n`)
    win.webContents.send(IPC_CHANNELS.TEST_FINISHED, { exitCode, passed: exitCode === 0 })
    return exitCode === 0
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

    await setWorkspaceRoot(dir)
    return await workspaceInfo()
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_SET, async (_e, dir: string) => {
    await setWorkspaceRoot(dir)
    return await workspaceInfo()
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_FORGET, async (_e, dir: string) => {
    await removeRecentWorkspace(dir)
    return await workspaceInfo()
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_REVEAL, async () => {
    if (hasWorkspace()) await shell.openPath(getWorkspaceRoot())
  })
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
