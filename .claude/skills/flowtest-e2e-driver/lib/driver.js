// Reusable harness for driving the real FlowTest Electron app with Playwright's
// _electron API, against disposable scratch workspaces. Built while regression-testing
// A7/A16 (vault re-key) and A3/A13 (error channel, focus reload) from CLEAN_UP_TODO.md.
//
// Safety model — read before using:
//   - NEVER point `workspaceRoot` at a real user workspace (e.g. the esd-flows folder).
//     Always use a fresh scratch directory; several tests here deliberately corrupt files,
//     revoke write permissions, etc.
//   - ALWAYS pass an isolated `userDataDir` to launchApp(). Without it Electron uses the
//     real `app.getPath('userData')` (on this machine: `%APPDATA%/flowtest`), which holds
//     the user's actual `workspaceRoot` / `recentWorkspaces` / `vaultKeys`. An isolated
//     --user-data-dir keeps every test run from touching that file. assertRealSettingsUntouched()
//     below is a cheap sanity check to run at the end of a test suite.
//   - This file must be required from a script that itself lives inside this project
//     directory (or a subdirectory of it) — Node resolves `require('playwright')` from the
//     requiring file's own location, not `cwd`. A script under this project's
//     `.claude/skills/*/tests/` folder satisfies that automatically.
//   - Run via the PowerShell tool, not Bash — `node` invoked from this session's Bash prints
//     "stdin is not a tty" and exits 1 (unrelated tty quirk on this machine).
//   - Clear `ELECTRON_RUN_AS_NODE` from the child env before launching, or Electron parses
//     its own CLI args wrong and fails with `bad option: --remote-debugging-port=0`.
'use strict'

const { _electron: electron } = require('playwright')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

// ── Paths ──────────────────────────────────────────────────────────────────────

/** This project's root — three levels up from lib/driver.js (.claude/skills/<name>/lib/). */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..')

/** The real app's userData settings file (Windows). Used only by assertRealSettingsUntouched. */
const REAL_SETTINGS_PATH = path.join(
  process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
  'flowtest',
  'settings.json',
)

function ensureDirTolerantOfAcl(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) return
    throw err
  }
}

// ── Process lifecycle ─────────────────────────────────────────────────────────

/**
 * Launch the real built app (out/main/index.js — run `npm run build` first if you changed
 * source since the last build) against an isolated workspace + userData directory.
 *
 * @param {object} opts
 * @param {string} opts.workspaceRoot - scratch folder for flows/projects/fixtures (created if missing)
 * @param {string} opts.userDataDir - scratch folder for this run's Electron userData (created if missing)
 * @param {Record<string,string>} [opts.extraEnv] - additional env vars for the launched process
 */
async function launchApp({ workspaceRoot, userDataDir, extraEnv }) {
  // fs.mkdirSync(..., {recursive:true}) is normally a silent no-op on an existing directory,
  // but on Windows that "already exists" short-circuit can itself throw EPERM/EACCES instead
  // of succeeding when the directory's ACL denies write — and empirically even
  // fs.existsSync() can come back false under such a deny (its statSync throws, existsSync
  // swallows it). Matters for tests that pre-create + lock down the workspace (e.g. the
  // startup-buffer/drain scenario) before calling launchApp. Treat a permission error here
  // as "something is already there" rather than a real failure; anything else still throws.
  ensureDirTolerantOfAcl(workspaceRoot)
  ensureDirTolerantOfAcl(userDataDir)
  const env = { ...process.env, ...(extraEnv || {}) }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    args: [PROJECT_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: PROJECT_ROOT,
    env,
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => !!window.electronAPI, { timeout: 20000 })
  return { app, page }
}

/**
 * `window.electronAPI.setWorkspace(dir)` only updates MAIN's state — the renderer's
 * `workspaceStore.load()` already ran once on mount and won't re-poll, so the UI stays on
 * WelcomeScreen. Reload so the remount picks up the new workspace and actually renders
 * past it. Waits for the FlowList "重新整理" button as proof the main UI is up.
 */
async function openWorkspace(page, workspaceRoot) {
  await page.evaluate(async (dir) => {
    await window.electronAPI.setWorkspace(dir)
  }, workspaceRoot)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => !!window.electronAPI, { timeout: 20000 })
  await page.waitForSelector('button[title="重新整理"]', { timeout: 20000 })
}

/** Simulates the window regaining focus (what WORKSPACE_RELOAD listens on) without needing
 *  a real OS window manager / real alt-tab. */
async function simulateFocus(app) {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].emit('focus')
  })
}

// ── Flow / project construction ─────────────────────────────────────────────────

/** A minimal but complete Flow object. Pass `nodes` to override the single-goto-node
 *  default (e.g. to add a `code` node that throws, for replay-failure testing). Each node
 *  needs at least `{ action, position }`; id/parentId/childIds are filled in as a straight
 *  chain if omitted. */
function buildFlow({ name, projectId = '__default__', profiles = [], nodes } = {}) {
  const nodeSpecs = nodes && nodes.length ? nodes : [{ action: { type: 'goto', url: 'http://localhost:3000/', isPageNavigation: true, description: 'goto http://localhost:3000/' } }]
  const built = nodeSpecs.map((spec, i) => ({
    id: spec.id || crypto.randomUUID(),
    action: {
      id: crypto.randomUUID(),
      type: spec.action.type,
      selector: spec.action.selector ?? '',
      // Replayer navigates using action.VALUE, not action.url (url is display metadata
      // only) — default value to url for `goto` so a caller passing just `url` still
      // actually replays, instead of navigating to an empty string.
      value: spec.action.value ?? (spec.action.type === 'goto' ? spec.action.url : undefined) ?? '',
      description: spec.action.description ?? spec.action.type,
      timestamp: Date.now() + i,
      url: spec.action.url ?? 'http://localhost:3000/',
      isPageNavigation: !!spec.action.isPageNavigation,
      ...(spec.action.code !== undefined ? { code: spec.action.code } : {}),
      ...(spec.action.secret !== undefined ? { secret: spec.action.secret } : {}),
      ...(spec.action.captureAs !== undefined ? { captureAs: spec.action.captureAs } : {}),
    },
    position: spec.position ?? { x: 0, y: i * 120 },
    parentId: null,
    childIds: [],
  }))
  for (let i = 0; i < built.length - 1; i++) {
    built[i].childIds = [built[i + 1].id]
    built[i + 1].parentId = built[i].id
  }
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    name: name || `driver-test-${Date.now()}`,
    createdAt: now,
    updatedAt: now,
    baseURL: 'http://localhost:3000/',
    projectId,
    profiles,
    nodes: built,
    rootNodeId: built[0].id,
    positionsFinalized: true,
  }
}

/** Calls electronAPI.saveFlow directly (same storage path the UI's persistFlow uses). */
async function saveFlow(page, flow) {
  await page.evaluate(async (f) => {
    await window.electronAPI.saveFlow(f, true)
  }, flow)
  return flow
}

/** Encrypts a plaintext into a profile-var-ready envelope. Vault must already be unlocked. */
async function encryptSecret(page, plain) {
  return page.evaluate(async (p) => window.electronAPI.encryptSecret(p), plain)
}

// ── UI gestures ────────────────────────────────────────────────────────────────

async function clickRefreshFlowList(page) {
  await page.click('button[title="重新整理"]')
}

/** Refreshes the flow list, then opens a flow by its exact visible name and waits for its
 *  root node to render on the canvas. Returns nothing — inspect `page` afterwards. */
async function openFlowByName(page, name, rootNodeId) {
  await clickRefreshFlowList(page)
  await page.getByText(name, { exact: true }).click()
  if (rootNodeId) {
    await page.waitForSelector(`.react-flow__node[data-id="${rootNodeId}"]`, { timeout: 10000 })
  }
}

/** Drags a ReactFlow node by (dx, dy) screen pixels from its current position. Exercises the
 *  real debounced-position-autosave path (500ms debounce — caller should wait ~1s after). */
async function dragNode(page, nodeId, dx, dy) {
  const handle = page.locator(`.react-flow__node[data-id="${nodeId}"]`)
  const box = await handle.boundingBox()
  if (!box) throw new Error(`dragNode: node ${nodeId} has no bounding box (not rendered?)`)
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + dx, startY + dy, { steps: 12 })
  await page.mouse.up()
}

// ── Toast / dialog introspection (no test ids in this app — DOM-shape based) ───

/** Every toast card has exactly one "關閉" (dismiss) button. Returns {title, detail} for each,
 *  in on-screen order (newest first — reportError unshifts). */
async function getToasts(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('button[title="關閉"]')).map((btn) => {
      const row = btn.parentElement // icon span + content div + this button
      const content = row && row.children[1]
      const titleEl = content && content.children[0]
      const detailEl = content && content.children[1]
      return {
        title: titleEl ? titleEl.textContent : null,
        detail: detailEl ? detailEl.textContent : null,
      }
    })
  })
}

async function getToastCount(page) {
  return page.locator('button[title="關閉"]').count()
}

/** Climbs from a located element to its nearest `position: fixed` ancestor and returns that
 *  ancestor's computed z-index (as a number, or null if none set). Used to prove the toast
 *  stack renders above a modal (tokens.css: zIndex.toast > zIndex.confirm). */
async function fixedAncestorZIndex(locator) {
  return locator.evaluate((el) => {
    let node = el
    while (node && node !== document.body) {
      if (getComputedStyle(node).position === 'fixed') {
        const z = getComputedStyle(node).zIndex
        return z === 'auto' ? null : Number(z)
      }
      node = node.parentElement
    }
    return null
  })
}

// ── Filesystem snapshotting (for "nothing else changed" assertions) ────────────

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** {relPath: {hash, mtimeMs, size}} for every file under root, recursively. */
function snapshotDir(root) {
  const out = {}
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const rel = path.relative(root, full)
      if (entry.isDirectory()) walk(full)
      else {
        const buf = fs.readFileSync(full)
        const st = fs.statSync(full)
        out[rel] = { hash: sha256(buf), mtimeMs: st.mtimeMs, size: st.size }
      }
    }
  }
  walk(root)
  return out
}

function diffSnapshots(before, after) {
  const changed = []
  const removed = []
  const added = []
  const beforeKeys = new Set(Object.keys(before))
  const afterKeys = new Set(Object.keys(after))
  for (const k of beforeKeys) {
    if (!afterKeys.has(k)) { removed.push(k); continue }
    if (before[k].hash !== after[k].hash || before[k].mtimeMs !== after[k].mtimeMs) changed.push(k)
  }
  for (const k of afterKeys) if (!beforeKeys.has(k)) added.push(k)
  return { changed, removed, added }
}

// ── Error injection ──────────────────────────────────────────────────────────

/** Deliberately corrupts a JSON file in place so JSON.parse throws, while leaving a file
 *  present (simulates a truncated/garbled write, not a deletion). */
function corruptJsonFile(filePath) {
  fs.writeFileSync(filePath, '{not valid json,,,')
}

/**
 * Deny this user's write access to a directory via icacls (Windows only). Reliable for
 * making `fs.writeFile` / `fs.mkdir` INSIDE that directory fail with EPERM — confirmed
 * experimentally (unlike a directory's read-only *attribute*, which Windows does NOT
 * enforce against writes; an ACL deny does). Always pair with restoreWrite() in a
 * try/finally — a leaked deny ACE will break the folder for the current user going forward.
 *
 * Deliberately denies only WD+AD (WriteData/AppendData — "create a file or subdirectory
 * inside this directory"), NOT the broader generic `(W)`. Confirmed experimentally that
 * `(W)` also breaks `fs.statSync`/`fs.existsSync` on the directory ITSELF on this machine
 * (they come back as "doesn't exist" instead of throwing/denying), which silently steers
 * code like workspace.ts's `isDirectory()` check onto the wrong branch — e.g. it makes a
 * startup-buffer/drain test (which needs `isDirectory()` to see the dir as real, then have
 * `scaffold()`'s mkdir fail) instead exercise the "workspace no longer exists, drop it from
 * recents" branch, silently testing the wrong thing. WD+AD alone blocks writes/mkdir while
 * leaving stat/read intact.
 */
function denyWrite(dir) {
  execFileSync('icacls', [dir, '/deny', `${process.env.USERNAME}:(OI)(CI)(WD,AD)`], { stdio: 'pipe' })
}

/** Removes the deny ACE added by denyWrite(). Safe to call even if denyWrite was never called
 *  (icacls /remove:d on an ACE that isn't there is a no-op, not an error). */
function restoreWrite(dir) {
  try {
    execFileSync('icacls', [dir, '/remove:d', process.env.USERNAME], { stdio: 'pipe' })
  } catch {
    // Best-effort — if the directory itself is already gone there's nothing to restore.
  }
}

/** Deny this user's Delete right on a single FILE (not a directory) via icacls — makes
 *  `fs.unlink` on it fail with EPERM. A directory-level write deny does not block deleting
 *  an existing file inside it (that needs the child's own Delete right or the parent's
 *  Delete-Child right), so this is the file-scoped counterpart to denyWrite(). */
function denyDelete(filePath) {
  execFileSync('icacls', [filePath, '/deny', `${process.env.USERNAME}:(DE)`], { stdio: 'pipe' })
}

function restoreDelete(filePath) {
  try {
    execFileSync('icacls', [filePath, '/remove:d', process.env.USERNAME], { stdio: 'pipe' })
  } catch {
    // Best-effort.
  }
}

// ── Safety check ─────────────────────────────────────────────────────────────

/** Re-reads the REAL app settings.json and throws if it doesn't deep-equal the snapshot taken
 *  before the test run. Call this at the end of any suite that launches the app, to prove
 *  the isolated --user-data-dir actually isolated it. */
function readRealSettings() {
  try {
    return JSON.parse(fs.readFileSync(REAL_SETTINGS_PATH, 'utf-8'))
  } catch {
    return null
  }
}

function assertRealSettingsUntouched(before) {
  const after = readRealSettings()
  const same = JSON.stringify(before) === JSON.stringify(after)
  if (!same) {
    throw new Error(
      `REAL app settings.json changed during this test run — a test leaked into the user's ` +
        `real userData. Before: ${JSON.stringify(before)}\nAfter: ${JSON.stringify(after)}`,
    )
  }
}

// ── Misc ──────────────────────────────────────────────────────────────────────

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true })
}

function readJsonFile(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'))
}

function flowFilePath(workspaceRoot, flowId) {
  return path.join(workspaceRoot, 'flows', `${flowId}.json`)
}

function projectFilePath(workspaceRoot, projectId) {
  return path.join(workspaceRoot, 'projects', `${projectId}.json`)
}

module.exports = {
  PROJECT_ROOT,
  REAL_SETTINGS_PATH,
  launchApp,
  openWorkspace,
  simulateFocus,
  buildFlow,
  saveFlow,
  encryptSecret,
  clickRefreshFlowList,
  openFlowByName,
  dragNode,
  getToasts,
  getToastCount,
  fixedAncestorZIndex,
  snapshotDir,
  diffSnapshots,
  corruptJsonFile,
  denyWrite,
  restoreWrite,
  denyDelete,
  restoreDelete,
  readRealSettings,
  assertRealSettingsUntouched,
  rmrf,
  readJsonFile,
  flowFilePath,
  projectFilePath,
}
