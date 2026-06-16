import { BrowserWindow, ipcMain, app } from 'electron'
import { spawn } from 'child_process'
import { join, relative } from 'path'
import { IPC_CHANNELS } from '../../shared/types'
import type {
  ReplayToNodePayload,
  ExportScriptsPayload,
  FlowSavePayload,
  FlowLoadPayload,
  RecordingStartPayload,
} from '../../shared/types'
import { BrowserController } from '../playwright/browserController'
import { Recorder } from '../playwright/recorder'
import { Replayer } from '../playwright/replayer'
import { FlowStorage } from '../storage/flowStorage'
import { ScriptExporter } from '../storage/scriptExporter'

let browserController: BrowserController | null = null
let recorder: Recorder | null = null
let replayer: Replayer | null = null

export function registerIpcHandlers(win: BrowserWindow): void {
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
    await browserController.launch()
    const page = browserController.getPage()

    // Branch recording: silently replay to the branch point first
    if (payload.branchFromNodeId && payload.branchNodes?.length) {
      const silentReplayer = new Replayer(page)
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

    recorder = new Recorder(page, (action) => {
      win.webContents.send(IPC_CHANNELS.ACTION_CAPTURED, action)
    })
    // For branch recording, don't navigate (we're already at the right page)
    await recorder.start(payload.branchFromNodeId ? undefined : payload.baseURL)
  })

  ipcMain.handle(IPC_CHANNELS.RECORDING_STOP, async () => {
    await recorder?.stop()
    recorder = null
  })

  // ── Replay ───────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.REPLAY_TO_NODE, async (_e, payload: ReplayToNodePayload) => {
    try {
      if (!browserController || !browserController.isRunning()) {
        browserController = new BrowserController()
        await browserController.launch()
      }
      const page = browserController.getPage()
      replayer = new Replayer(page)

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
    await FlowStorage.save(payload.flow)
  })

  ipcMain.handle(IPC_CHANNELS.FLOW_LOAD, async (_e, payload: FlowLoadPayload) => {
    return await FlowStorage.load(payload.flowId)
  })

  ipcMain.handle(IPC_CHANNELS.FLOW_LIST, async () => {
    return await FlowStorage.list()
  })

  // ── Export ───────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.EXPORT_SCRIPTS, async (_e, payload: ExportScriptsPayload) => {
    return await ScriptExporter.export(payload.flow, payload.config)
  })

  // ── Run Tests ────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.RUN_TESTS, async (_e, payload: ExportScriptsPayload) => {
    const cwd = app.isPackaged ? join(app.getPath('userData')) : process.cwd()

    // 1. Export script
    let specPath: string
    try {
      specPath = await ScriptExporter.export(payload.flow, payload.config)
      win.webContents.send(IPC_CHANNELS.TEST_OUTPUT, `✓ 腳本已匯出: ${specPath}\n\n`)
    } catch (err) {
      win.webContents.send(IPC_CHANNELS.TEST_OUTPUT, `✗ 匯出失敗: ${String(err)}\n`)
      win.webContents.send(IPC_CHANNELS.TEST_FINISHED, { exitCode: 1, passed: false })
      return
    }

    // 2. Run playwright test (use relative path with forward slashes — absolute Windows
    //    paths with backslashes are treated as broken regex by Playwright's test filter)
    const relSpecPath = relative(cwd, specPath).replace(/\\/g, '/')
    win.webContents.send(IPC_CHANNELS.TEST_OUTPUT, `▶ npx playwright test ${relSpecPath}\n\n`)
    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn('npx', ['playwright', 'test', relSpecPath, '--reporter=list'], {
        cwd,
        shell: true,
      })
      child.stdout.on('data', (d: Buffer) =>
        win.webContents.send(IPC_CHANNELS.TEST_OUTPUT, d.toString()),
      )
      child.stderr.on('data', (d: Buffer) =>
        win.webContents.send(IPC_CHANNELS.TEST_OUTPUT, d.toString()),
      )
      child.on('close', (code) => resolve(code ?? 1))
    })

    win.webContents.send(IPC_CHANNELS.TEST_FINISHED, { exitCode, passed: exitCode === 0 })

    // 3. Show HTML report
    spawn('npx', ['playwright', 'show-report'], { cwd, shell: true, detached: true })
  })
}
