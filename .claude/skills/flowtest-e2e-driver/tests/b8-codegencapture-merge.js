'use strict'
// B8 (workDoc/CLEAN_UP_TODO.md): Recorder was merged into CodegenCapture — CodegenCapture.start()
// now takes an optional baseURL and does its own reentrancy guard, and ipcHandlers.ts constructs
// CodegenCapture directly instead of wrapping it in a Recorder. This is a structural refactor,
// not a bug fix, but the TODO explicitly calls for an actual recording run (not just `tsc`) before
// calling it done — this script does that against a real recorded browser (headed, launched by
// BrowserController; not the Electron app window, so no CDP hook to interact with it — same
// limitation noted in a12/c12).
//
// Verifies, against the real built app:
//   1. Normal recording start still navigates the recorded browser to baseURL and the resulting
//      goto is captured over ACTION_CAPTURED (proves start()'s binding/init-script wiring still
//      runs before the now-inline goto, and that `new CodegenCapture(page.context(), ...)` in
//      ipcHandlers.ts is wired correctly end-to-end).
//   2. Branch recording (branchFromNodeId set) still skips the goto — ipcHandlers.ts passes
//      `undefined` as baseURL in that case — so no extra action is captured beyond the silent
//      replay itself.
'use strict'
const path = require('path')
const os = require('os')
const driver = require('../lib/driver')

const SCRATCH = path.join(os.tmpdir(), 'flowtest-b8-codegencapture-merge')
const DATA_URL = 'data:text/html,<html><body><h1>b8-recording-target</h1></body></html>'

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`)
}

async function waitFor(fn, { timeout = 8000, interval = 200 } = {}) {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeout) return null
    await new Promise((r) => setTimeout(r, interval))
  }
}

;(async () => {
  const before = driver.readRealSettings()
  const workspaceRoot = path.join(SCRATCH, 'ws')
  const userDataDir = path.join(SCRATCH, 'ud')
  driver.rmrf(workspaceRoot)
  driver.rmrf(userDataDir)

  const { app, page } = await driver.launchApp({ workspaceRoot, userDataDir })
  try {
    await driver.openWorkspace(page, workspaceRoot)

    // ── 1. Normal recording: expect a goto action captured after start() navigates ──
    await page.evaluate(() => {
      window.__b8Captured = []
      window.__b8Unsub = window.electronAPI.onActionCaptured((action) => {
        window.__b8Captured.push(action)
      })
    })

    const startResult = await page.evaluate(
      (url) => window.electronAPI.startRecording({ baseURL: url }),
      DATA_URL,
    )
    check('startRecording (normal) resolves started:true', startResult && startResult.started === true, JSON.stringify(startResult))

    const goto = await waitFor(() =>
      page.evaluate(() => window.__b8Captured.find((a) => a.type === 'goto') || null),
    )
    check('normal recording captured a goto action', !!goto, goto ? goto.url : 'none captured within timeout')
    check(
      'captured goto navigated to the requested baseURL',
      !!goto && goto.url === DATA_URL,
      goto ? goto.url : undefined,
    )

    await page.evaluate(() => window.electronAPI.stopRecording())
    check('stopRecording (normal) resolves without throwing', true)

    // ── 2. Branch recording: baseURL is passed as undefined, so no extra goto should fire ──
    const flow = driver.buildFlow({
      name: 'b8-branch-source',
      nodes: [{ action: { type: 'goto', url: DATA_URL, isPageNavigation: true } }],
    })
    await driver.saveFlow(page, flow)
    const rootId = flow.nodes[0].id

    await page.evaluate(() => {
      window.__b8Captured = []
    })

    const branchResult = await page.evaluate(
      ({ url, nodes, targetId }) =>
        window.electronAPI.startRecording({
          baseURL: url,
          branchFromNodeId: targetId,
          branchNodes: nodes,
          ctx: {},
        }),
      { url: DATA_URL, nodes: flow.nodes, targetId: rootId },
    )
    check('startRecording (branch) resolves started:true', branchResult && branchResult.started === true, JSON.stringify(branchResult))

    // Give it the same window we'd have waited for a goto in scenario 1 — if the refactor
    // regressed the `payload.branchFromNodeId ? undefined : payload.baseURL` conditional and
    // re-navigated, this is where it would show up as a captured goto.
    await new Promise((r) => setTimeout(r, 3000))
    const capturedDuringBranch = await page.evaluate(() => window.__b8Captured.slice())
    check(
      'branch recording captured no goto (start() correctly skipped navigation)',
      capturedDuringBranch.filter((a) => a.type === 'goto').length === 0,
      JSON.stringify(capturedDuringBranch),
    )

    await page.evaluate(() => window.electronAPI.stopRecording())
    check('stopRecording (branch) resolves without throwing', true)
  } finally {
    await app.close()
  }

  driver.assertRealSettingsUntouched(before)

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`)
  if (failed.length) process.exit(1)
})().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
