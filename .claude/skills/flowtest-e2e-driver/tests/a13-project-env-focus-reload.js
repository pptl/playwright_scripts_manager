// A13 regression: focus reload must pick up an externally-edited project env var, using
// content comparison (projectSignature) rather than an `updatedAt` gate — a hand edit or a
// `git pull` never touches `updatedAt`, which is exactly what made the old timestamp gate
// blind to this. See CLAUDE.md's "External changes" section and usePlaywrightEvents.ts.
'use strict'

const path = require('path')
const driver = require('../lib/driver')

const SCRATCH = path.join(require('os').tmpdir(), 'flowtest-a13-regression')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}

async function main() {
  const before = driver.readRealSettings()

  const workspaceRoot = path.join(SCRATCH, 'ws')
  const userDataDir = path.join(SCRATCH, 'ud')
  driver.rmrf(workspaceRoot)
  driver.rmrf(userDataDir)

  const { app, page } = await driver.launchApp({ workspaceRoot, userDataDir })
  try {
    await driver.openWorkspace(page, workspaceRoot)

    // Seed the default project with a custom (non-reserved) env var, and a flow under it.
    const projectId = await page.evaluate(async () => {
      const project = await window.electronAPI.loadProject('__default__')
      const envId = project.environments[0].id
      project.envVars = [
        ...(project.envVars || []),
        { key: 'apiKey', values: { [envId]: 'original-value' } },
      ]
      await window.electronAPI.saveProject(project)
      return project.id
    })

    const flow = driver.buildFlow({ name: 'A13-Test-' + Date.now(), projectId })
    await driver.saveFlow(page, flow)
    await driver.openFlowByName(page, flow.name, flow.rootNodeId)

    // Read the value through the real editor UI (🌐 dropdown -> 管理環境變數…), not IPC —
    // this is what actually proves the RENDERER's project store picked up the change.
    async function readApiKeyFromModal() {
      await page.click('button[title="切換環境"]')
      await page.click('text=🔧 管理環境變數…')
      await page.waitForSelector('text=專案環境變數')
      const val = await page.evaluate((key) => {
        // Scope to the modal: climb from the title text to its nearest `position: fixed`
        // ancestor (Modal has no test ids / aria roles to hook a selector onto).
        const titleEl = Array.from(document.querySelectorAll('*')).find(
          (el) => el.children.length === 0 && el.textContent === '專案環境變數',
        )
        let modal = titleEl
        while (modal && getComputedStyle(modal).position !== 'fixed') modal = modal.parentElement
        if (!modal) return undefined
        // Row layout inside the modal: [key input, value input, ...] per row, in order.
        const inputs = Array.from(modal.querySelectorAll('input'))
        const idx = inputs.findIndex((i) => i.value === key)
        return idx >= 0 ? inputs[idx + 1]?.value : undefined
      }, 'apiKey')
      await page.click('text=關閉')
      return val
    }

    const before1 = await readApiKeyFromModal()
    record('A13: modal shows the original value before any external edit', before1 === 'original-value', String(before1))

    // External edit: simulate a hand edit / git pull. Deliberately do NOT bump `updatedAt` —
    // that is the whole point of A13 (the old gate compared updatedAt and would miss this).
    const projFile = driver.projectFilePath(workspaceRoot, projectId)
    const onDisk = driver.readJsonFile(projFile)
    const envId = onDisk.environments[0].id
    const untouchedUpdatedAt = onDisk.updatedAt
    onDisk.envVars.find((v) => v.key === 'apiKey').values[envId] = 'updated-externally'
    require('fs').writeFileSync(projFile, JSON.stringify(onDisk, null, 2))
    const stillSameStamp = driver.readJsonFile(projFile).updatedAt === untouchedUpdatedAt
    record('A13: external edit leaves updatedAt untouched (matches a real hand-edit/git-pull)', stillSameStamp)

    // No real alt-tab needed — simulate the focus event main listens on.
    await driver.simulateFocus(app)
    await page.waitForTimeout(500)

    const after1 = await readApiKeyFromModal()
    record(
      'A13: focus reload picks up the externally-edited value (content comparison, not updatedAt)',
      after1 === 'updated-externally',
      String(after1),
    )
  } finally {
    await app.close()
  }

  driver.assertRealSettingsUntouched(before)
  record('A13: real app settings.json untouched by this test run', true)

  console.log('\n=== SUMMARY ===')
  const failed = results.filter((r) => !r.pass)
  for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}`)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
