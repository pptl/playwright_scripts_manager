// A7/A16 regression: changing the vault passphrase is all-or-nothing (a corrupted envelope
// aborts before any disk write) and pushes a reload so the renderer's in-memory (old-key)
// flow can't clobber the freshly re-encrypted file. See CLAUDE.md's vault section and
// security/recrypt.ts. First run 2026-08-23 — 19/19 checks passed.
'use strict'

const fs = require('fs')
const path = require('path')
const driver = require('../lib/driver')

const SCRATCH = path.join(require('os').tmpdir(), 'flowtest-a7-a16-regression')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}

function scratchPair(label) {
  const workspaceRoot = path.join(SCRATCH, label, 'ws')
  const userDataDir = path.join(SCRATCH, label, 'ud')
  driver.rmrf(path.join(SCRATCH, label))
  return { workspaceRoot, userDataDir }
}

async function setupSecretFlow(page, workspaceRoot, passphrase, secretPlain) {
  await driver.openWorkspace(page, workspaceRoot)
  await page.evaluate(async (pw) => { await window.electronAPI.setupVault(pw) }, passphrase)
  const cipher = await driver.encryptSecret(page, secretPlain)
  const flow = driver.buildFlow({
    name: 'A7A16-Test-' + Date.now(),
    profiles: [{ id: require('crypto').randomUUID(), name: 'Default', vars: [{ key: 'secretVar', value: cipher, secret: true }] }],
  })
  await driver.saveFlow(page, flow)
  return flow
}

// ── A: corrupted envelope → passphrase change must abort cleanly, zero disk changes ────

async function testA() {
  console.log('\n=== Test A: corrupted envelope → passphrase change must abort cleanly ===')
  const { workspaceRoot, userDataDir } = scratchPair('wsA')
  const { app, page } = await driver.launchApp({ workspaceRoot, userDataDir })
  try {
    const flow = await setupSecretFlow(page, workspaceRoot, 'oldpass1234', 'super-secret-plaintext')
    const ffPath = driver.flowFilePath(workspaceRoot, flow.id)

    const parsed = driver.readJsonFile(ffPath)
    const origCipher = parsed.profiles[0].vars[0].value
    const tail = origCipher.slice(-8)
    parsed.profiles[0].vars[0].value = origCipher.slice(0, -8) + (tail === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA')
    fs.writeFileSync(ffPath, JSON.stringify(parsed, null, 2))

    const before = driver.snapshotDir(workspaceRoot)
    const attempt = await page.evaluate(async () => {
      try {
        const r = await window.electronAPI.changeVaultPassphrase('oldpass1234', 'newpass5678')
        return { threw: false, result: r }
      } catch (err) {
        return { threw: true, message: String((err && err.message) || err) }
      }
    })
    const after = driver.snapshotDir(workspaceRoot)
    const diff = driver.diffSnapshots(before, after)
    const nothingChanged = diff.changed.length === 0 && diff.removed.length === 0 && diff.added.length === 0
    const backupCreated = fs.existsSync(path.join(workspaceRoot, '.flowtest', 'vault-backup')) &&
      fs.readdirSync(path.join(workspaceRoot, '.flowtest', 'vault-backup')).length > 0

    record('A: changeVaultPassphrase rejects/fails on corrupted envelope', attempt.threw || attempt.result?.ok === false, JSON.stringify(attempt))
    record('A: zero disk changes after failed attempt', nothingChanged, JSON.stringify(diff))
    record('A: no vault-backup directory created', !backupCreated)

    const unlockAfter = await page.evaluate(async () => {
      await window.electronAPI.lockVault()
      return await window.electronAPI.unlockVault('oldpass1234')
    })
    record('A: old passphrase still unlocks after failed attempt', unlockAfter.ok === true, JSON.stringify(unlockAfter))
  } finally {
    await app.close()
  }
}

// ── B: successful passphrase change + A16 reload + drag persistence ────────────────────

async function testB() {
  console.log('\n=== Test B: successful passphrase change + A16 reload + drag persistence ===')
  const { workspaceRoot, userDataDir } = scratchPair('wsB')
  const { app, page } = await driver.launchApp({ workspaceRoot, userDataDir })
  try {
    const flow = await setupSecretFlow(page, workspaceRoot, 'oldpass1234', 'super-secret-plaintext-b')
    const oldCipher = driver.readJsonFile(driver.flowFilePath(workspaceRoot, flow.id)).profiles[0].vars[0].value

    await driver.openFlowByName(page, flow.name, flow.rootNodeId)

    const changeResult = await page.evaluate(async () => {
      return await window.electronAPI.changeVaultPassphrase('oldpass1234', 'newpass5678')
    })
    record('B: changeVaultPassphrase succeeds on the happy path', changeResult.ok === true, JSON.stringify(changeResult))

    await page.waitForTimeout(800)
    const newCipherAfterRecrypt = driver.readJsonFile(driver.flowFilePath(workspaceRoot, flow.id)).profiles[0].vars[0].value
    record('B: on-disk secret value rewritten under the new key', newCipherAfterRecrypt !== oldCipher)

    const backupDir = path.join(workspaceRoot, '.flowtest', 'vault-backup')
    const backupGenerations = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : []
    record('B: vault-backup generation created', backupGenerations.length === 1, JSON.stringify(backupGenerations))
    if (backupGenerations.length) {
      const backedUpFlow = driver.readJsonFile(path.join(backupDir, backupGenerations[0], 'flows', `${flow.id}.json`))
      record('B: backup holds the ORIGINAL (old-key) ciphertext', backedUpFlow.profiles[0].vars[0].value === oldCipher)
    }

    await driver.dragNode(page, flow.rootNodeId, 180, 120)
    await page.waitForTimeout(1200)

    const afterDrag = driver.readJsonFile(driver.flowFilePath(workspaceRoot, flow.id))
    const positionMoved = afterDrag.nodes[0].position.x !== 0 || afterDrag.nodes[0].position.y !== 0
    record('B: drag position persisted to disk', positionMoved, JSON.stringify(afterDrag.nodes[0].position))
    record(
      'B: drag-triggered autosave did NOT clobber the new-key ciphertext (A16)',
      afterDrag.profiles[0].vars[0].value === newCipherAfterRecrypt,
      afterDrag.profiles[0].vars[0].value === oldCipher ? 'REGRESSED: value reverted to OLD-key ciphertext' : 'value matches post-recrypt ciphertext',
    )

    const decryptCheck = await page.evaluate(async () => {
      await window.electronAPI.lockVault()
      const oldUnlock = await window.electronAPI.unlockVault('oldpass1234')
      await window.electronAPI.lockVault()
      const newUnlock = await window.electronAPI.unlockVault('newpass5678')
      return { oldUnlock: oldUnlock.ok, newUnlock: newUnlock.ok }
    })
    record('B: OLD passphrase no longer unlocks the vault', decryptCheck.oldUnlock === false, JSON.stringify(decryptCheck))
    record('B: NEW passphrase unlocks the vault', decryptCheck.newUnlock === true, JSON.stringify(decryptCheck))

    const reveal = await page.evaluate(async (cipher) => window.electronAPI.revealSecret(cipher), afterDrag.profiles[0].vars[0].value)
    record('B: new-key ciphertext decrypts back to the original plaintext', reveal === 'super-secret-plaintext-b', reveal)
  } finally {
    await app.close()
  }
}

// ── C: no-ciphertext workspace → passphrase change touches nothing ─────────────────────

async function testC() {
  console.log('\n=== Test C: no-ciphertext workspace → passphrase change touches nothing ===')
  const { workspaceRoot, userDataDir } = scratchPair('wsC')
  const { app, page } = await driver.launchApp({ workspaceRoot, userDataDir })
  try {
    await driver.openWorkspace(page, workspaceRoot)
    await page.evaluate(async () => { await window.electronAPI.setupVault('onlypass1234') })
    const flow = driver.buildFlow({
      name: 'plain-flow',
      profiles: [{ id: require('crypto').randomUUID(), name: 'Default', vars: [{ key: 'plainVar', value: 'not-secret' }] }],
    })
    await driver.saveFlow(page, flow)

    const before = driver.snapshotDir(workspaceRoot)
    const result = await page.evaluate(async () => window.electronAPI.changeVaultPassphrase('onlypass1234', 'newonlypass5678'))
    const after = driver.snapshotDir(workspaceRoot)

    record('C: changeVaultPassphrase succeeds (no ciphertext anywhere)', result.ok === true, JSON.stringify(result))
    const diff = driver.diffSnapshots(before, after)
    const unexpectedChanges = diff.changed.filter((f) => f !== '.flowtest.json')
    record('C: no flow/project file rewritten', unexpectedChanges.length === 0 && diff.removed.length === 0, JSON.stringify(diff))
    record('C: .flowtest.json vault meta did change (new salt/verifier)', diff.changed.includes('.flowtest.json'))
    const backupExists = fs.existsSync(path.join(workspaceRoot, '.flowtest', 'vault-backup'))
    record('C: no vault-backup directory created', !backupExists)
  } finally {
    await app.close()
  }
}

// ── D: A15 regression — focus with no external change doesn't reload/rewrite ───────────

async function testD() {
  console.log('\n=== Test D: A15 regression — focus event on an untouched flow must not reload it ===')
  const { workspaceRoot, userDataDir } = scratchPair('wsD')
  const { app, page } = await driver.launchApp({ workspaceRoot, userDataDir })
  try {
    const flow = await setupSecretFlow(page, workspaceRoot, 'passD1234', 'plaintext-d')
    await driver.openFlowByName(page, flow.name, flow.rootNodeId)

    const before = driver.snapshotDir(workspaceRoot)
    await driver.simulateFocus(app)
    await page.waitForTimeout(500)
    const after = driver.snapshotDir(workspaceRoot)
    const diff = driver.diffSnapshots(before, after)
    record('D: focus with no external change causes no disk writes', diff.changed.length === 0 && diff.removed.length === 0 && diff.added.length === 0, JSON.stringify(diff))
    const stillThere = await page.locator(`.react-flow__node[data-id="${flow.rootNodeId}"]`).count()
    record('D: canvas still shows the node after the focus event', stillThere === 1)
  } finally {
    await app.close()
  }
}

;(async () => {
  const before = driver.readRealSettings()
  for (const t of [testA, testB, testC, testD]) {
    try {
      await t()
    } catch (err) {
      record(`${t.name}: (crashed)`, false, String((err && err.stack) || err))
    }
  }
  driver.assertRealSettingsUntouched(before)
  record('real app settings.json untouched by this test run', true)

  console.log('\n=== SUMMARY ===')
  const failed = results.filter((r) => !r.pass)
  for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}`)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) process.exitCode = 1
})()
