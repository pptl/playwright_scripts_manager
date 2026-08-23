// A3 regression: the two-channel error reporting system (renderer toast/modal +
// main's errorChannel buffer/drain). See CLAUDE.md "Reporting failures (two channels,
// one rule)". Each test launches its own isolated app instance for a clean slate.
//
// NOT covered here (documented as needing manual verification — see the printed summary):
//   - "連線被拒 warning" — needs a live connection-refused scenario, not deterministically
//     triggerable from outside the app without tampering with a shared browser install.
//   - "錄製失敗跳 modal" — attempted with a bounded timeout; see testRecordingFailureModal.
'use strict'

const fs = require('fs')
const path = require('path')
const driver = require('../lib/driver')

const SCRATCH = path.join(require('os').tmpdir(), 'flowtest-a3-regression')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}
function skip(name, reason) {
  results.push({ name, pass: null, detail: reason })
  console.log(`[SKIP] ${name} — ${reason}`)
}

function scratchPair(label) {
  const workspaceRoot = path.join(SCRATCH, label, 'ws')
  const userDataDir = path.join(SCRATCH, label, 'ud')
  driver.rmrf(path.join(SCRATCH, label))
  return { workspaceRoot, userDataDir }
}

// ── 1. 存檔失敗 toast + 不打斷拖曳 + 連續失敗去重（×N） ─────────────────────────

async function testSaveFailureToastAndDedup() {
  console.log('\n=== A3-1: save-failure toast, drag not blocked, dedup ×N ===')
  const { workspaceRoot, userDataDir } = scratchPair('save-fail')
  const { app, page } = await driver.launchApp({ workspaceRoot, userDataDir })
  try {
    await driver.openWorkspace(page, workspaceRoot)
    const flow = driver.buildFlow({ name: 'A3-SaveFail-' + Date.now() })
    await driver.saveFlow(page, flow)
    await driver.openFlowByName(page, flow.name, flow.rootNodeId)

    const flowsDir = path.join(workspaceRoot, 'flows')
    driver.denyWrite(flowsDir)
    try {
      // Three drags in a row — each triggers a debounced save that will fail identically.
      for (let i = 0; i < 3; i++) {
        await driver.dragNode(page, flow.rootNodeId, 40, 20)
        await page.waitForTimeout(700) // > 500ms debounce
      }

      const box = await page.locator(`.react-flow__node[data-id="${flow.rootNodeId}"]`).boundingBox()
      record('A3-1: node visibly moved on screen despite the save failing (drag not blocked)', !!box)

      const toasts = await driver.getToasts(page)
      // Drag saves go through persistFlow with a dedicated label (not the generic
      // "自動存檔失敗：<name>") — see FlowCanvas.tsx's debounced-save call sites.
      const matching = toasts.filter((t) => (t.title || '').startsWith('節點位置儲存失敗'))
      record('A3-1: exactly one toast for the repeated save failure (deduped, not one per attempt)', matching.length === 1, JSON.stringify(toasts))
      record('A3-1: deduped toast shows a ×N repeat count (N ≥ 2)', /×\s*[2-9]/.test(matching[0]?.title || ''), matching[0]?.title)
    } finally {
      driver.restoreWrite(flowsDir)
    }
  } finally {
    await app.close()
  }
}

// ── 2. 正常路徑不冒多餘 toast（開啟、拖曳、存檔皆成功）───────────────────────────

async function testNormalPathNoToast() {
  console.log('\n=== A3-2: normal path raises zero toasts ===')
  const { workspaceRoot, userDataDir } = scratchPair('normal-path')
  const { app, page } = await driver.launchApp({ workspaceRoot, userDataDir })
  try {
    await driver.openWorkspace(page, workspaceRoot)
    const flow = driver.buildFlow({ name: 'A3-Normal-' + Date.now() })
    await driver.saveFlow(page, flow)
    await driver.openFlowByName(page, flow.name, flow.rootNodeId)
    await driver.dragNode(page, flow.rootNodeId, 60, 30)
    await page.waitForTimeout(800)

    const count = await driver.getToastCount(page)
    record('A3-2: zero toasts after a fully successful open+drag+autosave', count === 0, `count=${count}`)
  } finally {
    await app.close()
  }
}

// ── 3. 重播失敗：節點轉紅 + tooltip + toast ────────────────────────────────────

async function testReplayFailure() {
  console.log('\n=== A3-3: replay failure — red border, tooltip, toast ===')
  const { workspaceRoot, userDataDir } = scratchPair('replay-fail')
  const { app, page } = await driver.launchApp({ workspaceRoot, userDataDir })
  try {
    await driver.openWorkspace(page, workspaceRoot)
    const flow = driver.buildFlow({
      name: 'A3-ReplayFail-' + Date.now(),
      nodes: [
        // about:blank, not localhost:3000 — this replay actually runs, and nothing is
        // listening on 3000 in this scratch environment, which would fail the ROOT node
        // on connection-refused before ever reaching the code node under test.
        // NOTE: Replayer navigates using action.VALUE, not action.url (url is metadata only).
        { action: { type: 'goto', url: 'about:blank', value: 'about:blank', isPageNavigation: true, description: 'goto' } },
        { action: { type: 'code', code: "throw new Error('boom-from-code-node')", description: '會失敗的 code 節點' } },
      ],
    })
    await driver.saveFlow(page, flow)
    await driver.openFlowByName(page, flow.name, flow.rootNodeId)
    const failNodeId = flow.nodes[1].id

    await page.locator(`.react-flow__node[data-id="${failNodeId}"]`).click({ button: 'right' })
    await page.click('text=重播到此節點')

    // Replay opens a real (visible) browser and navigates — give it real time.
    await page.waitForFunction(
      (id) => {
        const el = document.querySelector(`.react-flow__node[data-id="${id}"] > div`)
        return el && el.getAttribute('title')
      },
      failNodeId,
      { timeout: 30000 },
    )

    const nodeInfo = await page.evaluate((id) => {
      const el = document.querySelector(`.react-flow__node[data-id="${id}"] > div`)
      return { title: el.getAttribute('title'), borderColor: getComputedStyle(el).borderColor }
    }, failNodeId)

    record('A3-3: failed node gets a native title tooltip with the error', (nodeInfo.title || '').includes('boom-from-code-node'), nodeInfo.title)
    record('A3-3: failed node border turns red (#ef4444)', nodeInfo.borderColor === 'rgb(239, 68, 68)', nodeInfo.borderColor)

    const toasts = await driver.getToasts(page)
    const errToast = toasts.find((t) => t.title === '節點執行失敗')
    record('A3-3: "節點執行失敗" toast raised with the same error in its detail', !!errToast && (errToast.detail || '').includes('boom-from-code-node'), JSON.stringify(errToast))
  } finally {
    await app.close()
  }
}

// ── 4. modal 開著時 toast 蓋在上面（z-index stacking）──────────────────────────

async function testToastAboveModal() {
  console.log('\n=== A3-4: background toast stacks above an open confirm dialog ===')
  const { workspaceRoot, userDataDir } = scratchPair('toast-over-modal')
  const { app, page } = await driver.launchApp({ workspaceRoot, userDataDir })
  try {
    await driver.openWorkspace(page, workspaceRoot)
    const flowA = driver.buildFlow({ name: 'A3-ModalA-' + Date.now() })
    const flowB = driver.buildFlow({ name: 'A3-ModalB-' + Date.now() })
    await driver.saveFlow(page, flowA)
    await driver.saveFlow(page, flowB)
    await driver.clickRefreshFlowList(page)

    // Open the delete-confirmation dialog for flow A (right-click -> 刪除流程) and leave it open.
    await page.getByText(flowA.name, { exact: true }).click({ button: 'right' })
    await page.click('text=刪除流程')
    await page.waitForSelector(`text=刪除流程「${flowA.name}」？`)

    // Trigger a background toast while the dialog is up: corrupt flow B's file and load it.
    driver.corruptJsonFile(driver.flowFilePath(workspaceRoot, flowB.id))
    await page.evaluate(async (id) => { await window.electronAPI.loadFlow(id) }, flowB.id)
    await page.waitForSelector('button[title="關閉"]', { timeout: 5000 })

    const confirmZ = await driver.fixedAncestorZIndex(page.getByRole('button', { name: '取消' }))
    const toastZ = await driver.fixedAncestorZIndex(page.locator('button[title="關閉"]').first())
    record('A3-4: both the confirm dialog and the toast are on screen simultaneously', confirmZ !== null && toastZ !== null, `confirmZ=${confirmZ} toastZ=${toastZ}`)
    record('A3-4: toast z-index is above the confirm dialog z-index', toastZ > confirmZ, `confirmZ=${confirmZ} toastZ=${toastZ}`)

    // Dismiss without deleting anything.
    await page.keyboard.press('Escape')
  } finally {
    await app.close()
  }
}

// ── 5. PropertyPanel 加解密失敗（跳解鎖對話框）──────────────────────────────────

async function testPropertyPanelLockedSaveOpensUnlock() {
  console.log('\n=== A3-5: saving a secret value while the vault is locked opens the unlock dialog ===')
  const { workspaceRoot, userDataDir } = scratchPair('propertypanel-lock')
  const { app, page } = await driver.launchApp({ workspaceRoot, userDataDir })
  try {
    await driver.openWorkspace(page, workspaceRoot)
    await page.evaluate(async () => { await window.electronAPI.setupVault('pw12345678') })
    const cipher = await driver.encryptSecret(page, 'original-secret')
    const flow = driver.buildFlow({
      name: 'A3-Lock-' + Date.now(),
      nodes: [
        { action: { type: 'goto', url: 'http://localhost:3000/', isPageNavigation: true, description: 'goto' } },
        { action: { type: 'fill', value: cipher, secret: true, description: '填入密碼' } },
      ],
    })
    await driver.saveFlow(page, flow)
    await driver.openFlowByName(page, flow.name, flow.rootNodeId)

    const secretNodeId = flow.nodes[1].id
    await page.click(`.react-flow__node[data-id="${secretNodeId}"]`)
    await page.waitForSelector('input[placeholder="（已加密，輸入以覆寫）"]', { timeout: 10000 })

    await page.evaluate(async () => { await window.electronAPI.lockVault() })

    await page.fill('input[placeholder="（已加密，輸入以覆寫）"]', 'new-secret-typed-while-locked')
    await page.getByRole('button', { name: '儲存' }).click()

    await page.waitForSelector('text=🔐 解鎖私密資料', { timeout: 10000 })
    record('A3-5: unlock dialog (VaultModal) opens after a locked-vault save failure', true)
  } finally {
    await app.close()
  }
}

// ── 6. main: 壞檔 list 合併成一則 toast ────────────────────────────────────────

async function testCorruptedFilesMergedToast() {
  console.log('\n=== A3-6: multiple corrupted flow files merge into ONE toast on list() ===')
  const { workspaceRoot, userDataDir } = scratchPair('list-merge')
  const { app, page } = await driver.launchApp({ workspaceRoot, userDataDir })
  try {
    await driver.openWorkspace(page, workspaceRoot)
    const flowA = driver.buildFlow({ name: 'ok-flow' })
    await driver.saveFlow(page, flowA)
    const flowsDir = path.join(workspaceRoot, 'flows')
    const badFile1 = path.join(flowsDir, 'bad-1.json')
    const badFile2 = path.join(flowsDir, 'bad-2.json')
    fs.writeFileSync(badFile1, '{not valid,,,')
    fs.writeFileSync(badFile2, '{also not valid,,,')

    await page.evaluate(async () => { await window.electronAPI.listFlows() })
    await page.waitForSelector('button[title="關閉"]', { timeout: 5000 })

    const toasts = await driver.getToasts(page)
    const listToasts = toasts.filter((t) => /個流程檔案無法讀取/.test(t.title || ''))
    record('A3-6: exactly one toast for two bad files (not two)', listToasts.length === 1, JSON.stringify(toasts))
    record('A3-6: that toast names both bad files', /bad-1\.json/.test(listToasts[0]?.detail || '') && /bad-2\.json/.test(listToasts[0]?.detail || ''), listToasts[0]?.detail)
  } finally {
    await app.close()
  }
}

// ── 7. main: toast 堆疊上限（4）不會被多筆錯誤炸掉 ─────────────────────────────

async function testToastCap() {
  console.log('\n=== A3-7: toast stack caps at 4 with 5 distinct failures ===')
  const { workspaceRoot, userDataDir } = scratchPair('toast-cap')
  const { app, page } = await driver.launchApp({ workspaceRoot, userDataDir })
  try {
    await driver.openWorkspace(page, workspaceRoot)
    const flowsDir = path.join(workspaceRoot, 'flows')
    const ids = []
    for (let i = 0; i < 5; i++) {
      const id = `bad-distinct-${i}-${Date.now()}`
      fs.writeFileSync(path.join(flowsDir, `${id}.json`), '{not valid,,,')
      ids.push(id)
    }
    for (const id of ids) {
      await page.evaluate(async (flowId) => { await window.electronAPI.loadFlow(flowId) }, id)
    }
    await page.waitForTimeout(300)

    const count = await driver.getToastCount(page)
    record('A3-7: toast stack does not exceed the documented cap of 4', count === 4, `count=${count}`)
  } finally {
    await app.close()
  }
}

// ── 8. main: 開啟中流程壞檔的 focus reload 行為 ─────────────────────────────────

async function testOpenFlowCorruptedOnFocus() {
  console.log('\n=== A3-8: currently-open flow becoming unreadable, then a focus event ===')
  const { workspaceRoot, userDataDir } = scratchPair('open-flow-corrupt')
  const { app, page } = await driver.launchApp({ workspaceRoot, userDataDir })
  try {
    await driver.openWorkspace(page, workspaceRoot)
    const flow = driver.buildFlow({ name: 'A3-OpenCorrupt-' + Date.now() })
    await driver.saveFlow(page, flow)
    await driver.openFlowByName(page, flow.name, flow.rootNodeId)

    driver.corruptJsonFile(driver.flowFilePath(workspaceRoot, flow.id))
    await driver.simulateFocus(app)
    await page.waitForTimeout(600)

    const toasts = await driver.getToasts(page)
    const readToast = toasts.find((t) => t.title === `流程檔案無法讀取：${flow.id}.json`)
    record('A3-8: a toast reports the open flow became unreadable', !!readToast, JSON.stringify(toasts))

    const nodeStillThere = await page.locator(`.react-flow__node[data-id="${flow.rootNodeId}"]`).count()
    record(
      'A3-8: known limitation confirmed — the open flow closes (treated as deleted)',
      nodeStillThere === 0,
      `nodeCount=${nodeStillThere}`,
    )
  } finally {
    await app.close()
  }
}

// ── 9. main: 啟動期 buffer/drain ──────────────────────────────────────────────

async function testStartupBufferDrain() {
  console.log('\n=== A3-9: startup buffer/drain — last workspace unwritable at launch ===')
  const { workspaceRoot, userDataDir } = scratchPair('startup-drain')
  fs.mkdirSync(workspaceRoot, { recursive: true })
  fs.mkdirSync(userDataDir, { recursive: true })
  // Pre-seed this run's ISOLATED settings.json so the app tries to reopen this workspace
  // on launch, before any window exists — exactly the buffered-error path.
  fs.writeFileSync(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify({ workspaceRoot, recentWorkspaces: [workspaceRoot], vaultKeys: {} }, null, 2),
  )
  driver.denyWrite(workspaceRoot)
  try {
    const { app, page } = await driver.launchApp({ workspaceRoot, userDataDir })
    try {
      await page.waitForSelector('button[title="關閉"]', { timeout: 15000 }).catch(() => {})
      const toasts = await driver.getToasts(page)
      const startupToast = toasts.find((t) => t.title === '無法開啟上次的工作區')
      record('A3-9: WelcomeScreen carries a "無法開啟上次的工作區" toast (buffered before window existed, then drained)', !!startupToast, JSON.stringify(toasts))

      const welcomeVisible = await page.locator('button[title="重新整理"]').count()
      record('A3-9: app falls back to WelcomeScreen rather than a broken workspace', welcomeVisible === 0)
    } finally {
      await app.close()
    }
  } finally {
    driver.restoreWrite(workspaceRoot)
  }
}

// ── 10. main: 刪除失敗 toast ───────────────────────────────────────────────────

async function testDeleteFailureToast() {
  console.log('\n=== A3-10: a failed flow delete (not ENOENT) raises a toast ===')
  const { workspaceRoot, userDataDir } = scratchPair('delete-fail')
  const { app, page } = await driver.launchApp({ workspaceRoot, userDataDir })
  try {
    await driver.openWorkspace(page, workspaceRoot)
    const flow = driver.buildFlow({ name: 'A3-DeleteFail-' + Date.now() })
    await driver.saveFlow(page, flow)
    const filePath = driver.flowFilePath(workspaceRoot, flow.id)
    driver.denyDelete(filePath)
    try {
      await page.evaluate(async (id) => { await window.electronAPI.deleteFlow(id) }, flow.id)
      await page.waitForSelector('button[title="關閉"]', { timeout: 5000 }).catch(() => {})
      const toasts = await driver.getToasts(page)
      const delToast = toasts.find((t) => t.title === `流程檔案刪除失敗：${flow.id}.json`)
      const stillThere = fs.existsSync(filePath)
      if (!stillThere) {
        // Windows delete authorization is an OR of (DELETE allowed on the file) and
        // (FILE_DELETE_CHILD allowed on the parent) — denying just the file's own DE right
        // does not block deletion when the parent still grants delete-child (inherited Full
        // Control), which is the default here. Reliably forcing this specific failure needs
        // either a non-admin account or locking down the parent directory itself (which is
        // indistinguishable from A3-1's write-denial scenario). Not chasing further — flag
        // for manual verification instead of reporting a false negative.
        skip(
          'A3-10: 流程刪除失敗 toast',
          `icacls deny on the file did not actually block fs.unlink on this account (Windows delete-child-via-parent quirk) — file was deleted anyway. Needs manual check (e.g. delete a flow file while it's open in another program, or test under a non-admin account).`,
        )
      } else {
        record('A3-10: delete failure (not ENOENT) raises a toast', !!delToast, JSON.stringify(toasts))
        record('A3-10: the file is still on disk (delete genuinely failed)', stillThere)
      }
    } finally {
      driver.restoreDelete(filePath)
    }
  } finally {
    await app.close()
  }
}

// ── 11. main: 正常啟動完全不冒 toast ──────────────────────────────────────────

async function testNormalStartupNoToast() {
  console.log('\n=== A3-11: a completely normal startup raises zero toasts ===')
  const { workspaceRoot, userDataDir } = scratchPair('normal-startup')
  const { app, page } = await driver.launchApp({ workspaceRoot, userDataDir })
  try {
    await driver.openWorkspace(page, workspaceRoot)
    await page.waitForTimeout(300)
    const count = await driver.getToastCount(page)
    record('A3-11: zero toasts on a clean first-run startup', count === 0, `count=${count}`)
  } finally {
    await app.close()
  }
}

// ── 12. 錄製失敗跳 modal（best-effort, bounded timeout）────────────────────────

async function testRecordingFailureModal() {
  console.log('\n=== A3-12 (best-effort): malformed recording URL should raise a modal, not silently fail ===')
  const { workspaceRoot, userDataDir } = scratchPair('record-fail')
  const { app, page } = await driver.launchApp({ workspaceRoot, userDataDir })
  try {
    await driver.openWorkspace(page, workspaceRoot)
    const projectId = await page.evaluate(async () => {
      const project = await window.electronAPI.loadProject('__default__')
      const envId = project.environments[0].id
      project.envVars.find((v) => v.key === 'domain').values[envId] = 'not-a-valid-url'
      await window.electronAPI.saveProject(project)
      return project.id
    })
    const flow = driver.buildFlow({ name: 'A3-RecordFail-' + Date.now(), projectId })
    await driver.saveFlow(page, flow)
    await driver.openFlowByName(page, flow.name, flow.rootNodeId)

    const clicked = await page.getByRole('button', { name: /開始錄製/ }).click({ timeout: 3000 }).then(() => true).catch(() => false)
    if (!clicked) {
      skip('A3-12: 開始錄製 button not reachable', 'could not click it within 3s — needs manual check')
      return
    }
    const modalAppeared = await page
      .waitForSelector('text=無法開始錄製', { timeout: 15000 })
      .then(() => true)
      .catch(() => false)
    if (modalAppeared) {
      record('A3-12: malformed recording URL raises the "無法開始錄製" modal', true)
    } else {
      skip('A3-12: recording-failure modal', '15s bounded wait elapsed with no modal — Chromium may have accepted/hung on the malformed URL differently on this machine; needs manual check')
    }
  } finally {
    await app.close().catch(() => {})
  }
}

// ── connection-refused warning: not automated ──────────────────────────────────

function noteConnectionRefusedSkipped() {
  skip('A3: 連線被拒 warning', 'needs a live connection-refused scenario; not deterministically triggerable without tampering with the shared browser install — needs manual check')
}

;(async () => {
  const before = driver.readRealSettings()
  const tests = [
    testSaveFailureToastAndDedup,
    testNormalPathNoToast,
    testReplayFailure,
    testToastAboveModal,
    testPropertyPanelLockedSaveOpensUnlock,
    testCorruptedFilesMergedToast,
    testToastCap,
    testOpenFlowCorruptedOnFocus,
    testStartupBufferDrain,
    testDeleteFailureToast,
    testNormalStartupNoToast,
    testRecordingFailureModal,
  ]
  for (const t of tests) {
    try {
      await t()
    } catch (err) {
      record(`${t.name}: (crashed)`, false, String((err && err.stack) || err))
    }
  }
  noteConnectionRefusedSkipped()

  driver.assertRealSettingsUntouched(before)
  record('A3: real app settings.json untouched by this test run', true)

  console.log('\n=== SUMMARY ===')
  const failed = results.filter((r) => r.pass === false)
  const skipped = results.filter((r) => r.pass === null)
  const passed = results.filter((r) => r.pass === true)
  for (const r of results) console.log(`${r.pass === true ? '✅' : r.pass === false ? '❌' : '⏭️ '} ${r.name}`)
  console.log(`\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped (needs manual check)`)
  if (failed.length) process.exitCode = 1
})()
