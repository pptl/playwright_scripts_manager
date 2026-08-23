// A15 residual-doubt diagnostic: CLEAN_UP_TODO.md records that a manual regression for A15
// (focus reload must not wipe undo history / must not reload when nothing changed) found one
// unresolved failure — "external modifications are still not picked up": hand-editing the
// open flow's JSON on disk (including bumping `updatedAt`) and then regaining focus left the
// canvas showing the stale value. CLEAN_UP.md:2653-2665 lists three mutually exclusive
// explanations that must be told apart before this can be classified:
//   1. The test didn't actually change `updatedAt` to a genuinely different value.
//   2. Some other app-triggered autosave landed between the hand edit and the focus event,
//      clobbering the external edit and re-syncing the ledger before focus fired.
//   3. The `reloadFromDisk()` gate (usePlaywrightEvents.ts, compared against
//      persistence.ts's `lastWrittenStamp` ledger) is genuinely too strict — a real bug,
//      more severe than the original A15 since it defeats the whole point of focus reload.
//
// Two scenarios isolate these:
//   Scenario A — a flow this renderer's `persistFlow` has NEVER written (opened via
//     `saveFlow` IPC bypass + `openFlowByName`, so the ledger has no entry for it). Per
//     usePlaywrightEvents.ts, "no ledger entry" must ALWAYS reload regardless of whether the
//     external edit even touched `updatedAt`. If this fails, hypotheses 1/2 are impossible
//     (nothing in-app ran that could autosave, and updatedAt is deliberately bumped anyway) —
//     it's direct evidence of hypothesis 3.
//   Scenario B — a flow this renderer DID persist this session (a real drag, waited out to a
//     stable on-disk `updatedAt`), matching the original manual regression's real-world setup.
//     After the drag settles, edit a DIFFERENT node's description externally, explicitly bump
//     `updatedAt` to a provably-different value, and focus immediately with zero intervening
//     app interaction (ruling out hypothesis 2 by construction). Also presses Ctrl+Z right
//     after a genuine reload happens, to confirm undo history was actually wiped (the other
//     unverified item bundled into the same CLEAN_UP_TODO.md "下一步" entry).
'use strict'

const path = require('path')
const fs = require('fs')
const driver = require('../lib/driver')

const SCRATCH = path.join(require('os').tmpdir(), 'flowtest-a15-regression')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}

async function nodeText(page, nodeId) {
  const loc = page.locator(`.react-flow__node[data-id="${nodeId}"]`)
  if ((await loc.count()) === 0) return null
  return loc.textContent()
}

/** Polls the node's rendered text for `substr`, without throwing on timeout. */
async function waitForNodeTextContains(page, nodeId, substr, timeoutMs) {
  try {
    await page.waitForFunction(
      ({ nodeId, substr }) => {
        const el = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`)
        return !!el && el.textContent.includes(substr)
      },
      { nodeId, substr },
      { timeout: timeoutMs },
    )
    return true
  } catch {
    return false
  }
}

/** Waits past the drag's 500ms debounce (FlowCanvas.tsx), then reads a flow JSON off disk
 *  repeatedly until `updatedAt` stops changing between two reads spaced `intervalMs` apart, or
 *  `timeoutMs` elapses. The minimum wait matters: polling faster than the debounce window (as
 *  a first cut of this script did, at 300ms) falsely reports "stable" at the PRE-drag value —
 *  the debounced write hasn't fired yet, so two early reads agree by coincidence, not because
 *  anything actually settled. That produced a false pass here (drag: 0,0 -> 0,0) which looked
 *  identical to a real gate bug until the disk position was inspected directly. Waiting the
 *  debounce out first is what makes "what's on disk" a trustworthy ledger baseline — otherwise
 *  a later-firing debounce landing after our external edit would masquerade as a real gate bug
 *  (hypothesis 2 from CLEAN_UP.md). */
async function waitForStableUpdatedAt(filePath, { minWaitMs = 1200, intervalMs = 300, timeoutMs = 5000 } = {}) {
  await new Promise((r) => setTimeout(r, minWaitMs))
  const start = Date.now()
  let last = driver.readJsonFile(filePath).updatedAt
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs))
    const cur = driver.readJsonFile(filePath).updatedAt
    if (cur === last) return cur
    last = cur
  }
  return last
}

async function scenarioA(app, page, workspaceRoot) {
  const flow = driver.buildFlow({
    name: 'A15-ScenarioA-' + Date.now(),
    nodes: [{ action: { type: 'goto', url: 'http://localhost:3000/', description: 'A15-A-Original' } }],
  })
  await driver.saveFlow(page, flow)
  await driver.openFlowByName(page, flow.name, flow.rootNodeId)

  const before = await nodeText(page, flow.rootNodeId)
  record('A: canvas shows original description before any external edit', (before || '').includes('A15-A-Original'), before)

  const flowFile = driver.flowFilePath(workspaceRoot, flow.id)
  const onDisk = driver.readJsonFile(flowFile)
  const originalUpdatedAt = onDisk.updatedAt
  onDisk.nodes[0].action.description = 'A15-A-EXTERNALLY-EDITED'
  onDisk.updatedAt = new Date(Date.now() + 60_000).toISOString()
  fs.writeFileSync(flowFile, JSON.stringify(onDisk, null, 2))
  const bumped = driver.readJsonFile(flowFile).updatedAt !== originalUpdatedAt
  record('A: external edit actually bumped updatedAt to a new value', bumped, driver.readJsonFile(flowFile).updatedAt)

  await driver.simulateFocus(app)
  const picked = await waitForNodeTextContains(page, flow.rootNodeId, 'A15-A-EXTERNALLY-EDITED', 3000)
  record(
    'A (no ledger entry — must always reload): focus picks up external edit',
    picked,
    await nodeText(page, flow.rootNodeId),
  )
  return picked
}

async function scenarioB(app, page, workspaceRoot) {
  const flow = driver.buildFlow({
    name: 'A15-ScenarioB-' + Date.now(),
    nodes: [
      { action: { type: 'goto', url: 'http://localhost:3000/', description: 'A15-B-Node0-Original' } },
      { action: { type: 'goto', url: 'http://localhost:3000/', description: 'A15-B-Node1-Original' } },
    ],
  })
  const node0Id = flow.nodes[0].id
  const node1Id = flow.nodes[1].id
  await driver.saveFlow(page, flow)
  await driver.openFlowByName(page, flow.name, flow.rootNodeId)

  // Real in-app edit so persistFlow actually runs and populates the ledger — matches the
  // original manual regression's "already-open, already-edited flow" setup instead of the
  // trivial no-ledger case in scenario A.
  const boxBeforeDrag = await page.locator(`.react-flow__node[data-id="${node0Id}"]`).boundingBox()
  const flowFile = driver.flowFilePath(workspaceRoot, flow.id)
  const originalUpdatedAtBeforeDrag = driver.readJsonFile(flowFile).updatedAt
  await driver.dragNode(page, node0Id, 150, 90)
  const stableUpdatedAt = await waitForStableUpdatedAt(flowFile)
  const diskAfterDrag = driver.readJsonFile(flowFile)
  const dragPersisted =
    stableUpdatedAt !== originalUpdatedAtBeforeDrag &&
    (diskAfterDrag.nodes.find((n) => n.id === node0Id).position.x !== 0 ||
      diskAfterDrag.nodes.find((n) => n.id === node0Id).position.y !== 0)
  record(
    'B: drag settled to a stable, genuinely-new on-disk updatedAt (ledger populated)',
    dragPersisted,
    JSON.stringify({ originalUpdatedAtBeforeDrag, stableUpdatedAt, position: diskAfterDrag.nodes.find((n) => n.id === node0Id).position }),
  )

  const onDisk = driver.readJsonFile(flowFile)
  onDisk.nodes.find((n) => n.id === node1Id).action.description = 'A15-B-Node1-EXTERNALLY-EDITED'
  onDisk.updatedAt = new Date(Date.now() + 60_000).toISOString()
  fs.writeFileSync(flowFile, JSON.stringify(onDisk, null, 2))
  const bumped = driver.readJsonFile(flowFile).updatedAt !== stableUpdatedAt
  record('B: external edit bumped updatedAt to a value newer than the stable drag stamp', bumped, driver.readJsonFile(flowFile).updatedAt)

  // Focus immediately — zero intervening app interaction, so nothing can autosave in between
  // (rules out hypothesis 2 by construction rather than by hoping the timing worked out).
  await driver.simulateFocus(app)
  const picked = await waitForNodeTextContains(page, node1Id, 'A15-B-Node1-EXTERNALLY-EDITED', 3000)
  record(
    'B (real ledger entry from an in-app drag): focus picks up external edit',
    picked,
    await nodeText(page, node1Id),
  )

  // Only meaningful once a genuine reload actually happened — otherwise this would trivially
  // "pass" for the wrong reason (nothing to undo because setCurrentFlow was never called).
  if (picked) {
    const boxAfterReload = await page.locator(`.react-flow__node[data-id="${node0Id}"]`).boundingBox()
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(300)
    const boxAfterUndo = await page.locator(`.react-flow__node[data-id="${node0Id}"]`).boundingBox()
    const dragMoved = boxAfterReload && boxBeforeDrag &&
      (Math.abs(boxAfterReload.x - boxBeforeDrag.x) > 20 || Math.abs(boxAfterReload.y - boxBeforeDrag.y) > 20)
    record('B: sanity — the drag actually moved the node before reload', dragMoved,
      JSON.stringify({ boxBeforeDrag, boxAfterReload }))
    const undoWasNoop = boxAfterReload && boxAfterUndo &&
      Math.abs(boxAfterReload.x - boxAfterUndo.x) < 2 && Math.abs(boxAfterReload.y - boxAfterUndo.y) < 2
    record(
      'B: Ctrl+Z after a genuine external reload is a no-op (undo history correctly wiped)',
      undoWasNoop,
      JSON.stringify({ boxAfterReload, boxAfterUndo }),
    )
  } else {
    record('B: Ctrl+Z-after-reload check skipped (no genuine reload happened to test)', false, 'skipped')
  }

  return picked
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

    const passedA = await scenarioA(app, page, workspaceRoot)
    const passedB = await scenarioB(app, page, workspaceRoot)

    console.log('\n=== DIAGNOSIS ===')
    if (passedA && passedB) {
      console.log('Both scenarios reloaded correctly. The original manual-regression failure')
      console.log('was hypothesis 1 or 2 (test methodology / an intervening autosave) — NOT a')
      console.log('gate bug. Safe to record A15 as fully resolved / known-limitation-free.')
    } else if (!passedA) {
      console.log('Scenario A (no ledger entry — must ALWAYS reload) failed. Nothing in-app ran')
      console.log('that could autosave, so hypotheses 1/2 are ruled out by construction. This is')
      console.log('hypothesis 3: the reload gate itself is broken. Escalate and fix.')
    } else {
      console.log('Scenario A passed but B failed. Check the "external edit bumped updatedAt"')
      console.log('assertion in B\'s output above: if updatedAt reverted to the app\'s own stamp,')
      console.log('an autosave clobbered the external edit (hypothesis 2, re-run with a longer')
      console.log('settle wait). If updatedAt held the external value but the canvas still did not')
      console.log('update, the gate is broken specifically for flows with a ledger entry')
      console.log('(hypothesis 3).')
    }
  } finally {
    await app.close()
  }

  driver.assertRealSettingsUntouched(before)
  record('real app settings.json untouched by this test run', true)

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
