// A14 regression test — EnvVarPickerPopover's outside-click detection must close the popover
// on a click anywhere inside ProfileEditorModal, not just outside the whole App.
//
// Root cause: EnvVarPickerPopover listened for `mousedown` on `document` in the (default)
// bubble phase. Modal.tsx's card wrapper has `onMouseDown={(e) => e.stopPropagation()}` (a
// normal, shared-by-every-modal guard against a click inside the card closing the modal via
// the backdrop's onClose) — a React bubble-phase handler, so it swallows the mousedown before
// it ever reaches `document`. Fix: register the popover's listener on the capture phase
// instead, which runs before Modal's bubble-phase stopPropagation.
'use strict'
const path = require('path')
const driver = require('../lib/driver')

const SCRATCH = path.join(require('os').tmpdir(), 'flowtest-a14-envvar-popover-regression')

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`)
  }
}

const POPOVER_SEARCH_INPUT = 'input[placeholder="🔍 搜尋變數…"]'

;(async () => {
  const before = driver.readRealSettings()
  const workspaceRoot = path.join(SCRATCH, 'ws')
  const userDataDir = path.join(SCRATCH, 'ud')
  driver.rmrf(workspaceRoot)
  driver.rmrf(userDataDir)

  const { app, page } = await driver.launchApp({ workspaceRoot, userDataDir })
  try {
    await driver.openWorkspace(page, workspaceRoot)

    // Needs >=1 profile: ProfileEditorModal shows "請從左側選擇或建立一個配置" and never
    // mounts ProfileVarTable (and so never renders the popover trigger) with none.
    const flow = driver.buildFlow({
      name: 'a14-popover-flow',
      profiles: [{ id: 'p1', name: 'Profile 1', vars: [{ key: 'foo', value: 'bar' }] }],
    })
    await driver.saveFlow(page, flow)
    await driver.openFlowByName(page, flow.name, flow.rootNodeId)

    // Open the ⚙ profile menu, then "管理配置..." (ProfileEditorModal).
    await page.click('button[title="切換環境配置"]')
    await page.getByText('✎ 管理配置...').click()
    await page.waitForSelector('text=環境配置管理', { timeout: 10000 })

    // Open the 🌐 project env var popover.
    await page.click('button[title^="瀏覽專案環境變數"]')
    await page.waitForSelector(POPOVER_SEARCH_INPUT, { timeout: 5000 })
    check('popover opens on trigger click', await page.locator(POPOVER_SEARCH_INPUT).isVisible())

    // Click inside the modal, outside the popover and its trigger button (the modal title).
    await page.getByText('環境配置管理', { exact: true }).click()
    await page.waitForTimeout(150)
    const stillOpenAfterInsideClick = await page.locator(POPOVER_SEARCH_INPUT).count()
    check(
      'click inside modal (outside popover) closes the popover',
      stillOpenAfterInsideClick === 0,
      `count=${stillOpenAfterInsideClick}`,
    )

    // Regression guard: Escape still closes the popover without closing the whole modal
    // (ProfileEditorModal has closeOnEscape={false}; only the popover's own handler should fire).
    await page.click('button[title^="瀏覽專案環境變數"]')
    await page.waitForSelector(POPOVER_SEARCH_INPUT, { timeout: 5000 })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    check('Escape still closes the popover', (await page.locator(POPOVER_SEARCH_INPUT).count()) === 0)
    check('Escape does not close the whole modal', await page.getByText('環境配置管理', { exact: true }).isVisible())

    // Regression guard: clicking a row inside the popover itself must NOT close it (only a
    // genuine outside click should).
    await page.click('button[title^="瀏覽專案環境變數"]')
    await page.waitForSelector(POPOVER_SEARCH_INPUT, { timeout: 5000 })
    await page.locator(POPOVER_SEARCH_INPUT).click()
    await page.waitForTimeout(150)
    check('clicking inside the popover keeps it open', (await page.locator(POPOVER_SEARCH_INPUT).count()) === 1)
  } finally {
    await app.close()
  }

  driver.assertRealSettingsUntouched(before)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail > 0 ? 1 : 0)
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
