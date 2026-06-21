import { BrowserWindow, ipcMain, app } from 'electron'
import { spawn } from 'child_process'
import { join, basename } from 'path'
import { IPC_CHANNELS } from '../../shared/types'
import type {
  ReplayToNodePayload,
  ExportScriptsPayload,
  FlowSavePayload,
  FlowLoadPayload,
  RecordingStartPayload,
  ActionType,
} from '../../shared/types'
import { isCallFlowAction } from '../../shared/types'
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
      const silentReplayer = new Replayer(page, payload.baseURL, payload.profileVars, payload.activeProfileId)
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

  ipcMain.handle(IPC_CHANNELS.START_ASSERTION_PICK, async (_e, assertionType: ActionType) => {
    if (!recorder) return
    await recorder.startAssertionPick(
      assertionType as 'assertVisible' | 'assertText' | 'assertValue',
      () => win.webContents.send(IPC_CHANNELS.ASSERTION_PICK_CANCELLED),
    )
  })

  // ── Replay ───────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.REPLAY_TO_NODE, async (_e, payload: ReplayToNodePayload) => {
    try {
      if (!browserController || !browserController.isRunning()) {
        browserController = new BrowserController()
        await browserController.launch()
      }
      const page = browserController.getPage()
      replayer = new Replayer(page, payload.baseURL, payload.profileVars, payload.activeProfileId)

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

  ipcMain.handle(IPC_CHANNELS.FLOW_DELETE, async (_e, flowId: string) => {
    await FlowStorage.delete(flowId)
  })

  ipcMain.handle(IPC_CHANNELS.FLOW_GET, async (_e, { flowId }: { flowId: string }) => {
    return await FlowStorage.load(flowId)
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

    // 2. Run playwright test — pass only the filename because playwright.config.ts
    //    sets testDir to './exports', so Playwright already scopes its search there.
    //    Passing the full relative path (exports/uuid.spec.ts) makes Playwright treat
    //    it as a regex filter against paths relative to testDir, which never matches.
    const specFilename = basename(specPath)
    win.webContents.send(IPC_CHANNELS.TEST_OUTPUT, `▶ npx playwright test ${specFilename}\n\n`)
    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn('npx', ['playwright', 'test', specFilename, '--reporter=list,html'], {
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
  })

  ipcMain.handle(IPC_CHANNELS.SHOW_REPORT, async () => {
    const cwd = app.isPackaged ? join(app.getPath('userData')) : process.cwd()
    await killProcessOnPort(9323)
    spawn('npx', ['playwright', 'show-report'], { cwd, shell: true, detached: true })
  })
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
