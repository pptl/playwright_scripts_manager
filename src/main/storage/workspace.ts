import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join, parse, resolve } from 'path'
import { app } from 'electron'
import { reportToUser, describeError } from '../errorChannel'

/**
 * The workspace: one user-chosen directory holding flows/, projects/, fixtures/
 * and exports/. The user drops it inside their own repo, so version control of
 * test data is entirely theirs — and different repos are isolated by construction.
 *
 * Also the cwd used when spawning the Playwright runner, which is what lets
 * fixture paths be stored relative (see fixtureStorage).
 */

const RECENT_LIMIT = 8

/** Marker file identifying a directory as a FlowTest workspace. */
const MARKER = '.flowtest.json'

/** Everything Playwright generates lives here, so one ignore rule covers it all. */
const ARTIFACT_DIR = '.flowtest'

let workspaceRoot: string | null = null
let recent: string[] = []
let settingsLoaded = false
/**
 * Vault passphrases, keyed by workspace path and encrypted with the OS keychain
 * (DPAPI on Windows) by the vault module before they get here.
 *
 * Kept in userData rather than the workspace for the same reason as workspaceRoot:
 * the workspace is the thing that gets committed, and this must never be.
 */
let vaultKeys: Record<string, string> = {}

/**
 * Deliberately stored OUTSIDE any workspace — it is what tells us which
 * workspace to open, so it cannot live in one.
 */
function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function hasWorkspace(): boolean {
  return workspaceRoot !== null
}

export function getWorkspaceRoot(): string {
  if (workspaceRoot === null) {
    throw new Error('[FlowTest] No workspace is open — 請先開啟資料夾')
  }
  return workspaceRoot
}

export function getRecentWorkspaces(): string[] {
  return [...recent]
}

/** The generated Playwright config a run must be pointed at explicitly. */
export function configPath(root: string = getWorkspaceRoot()): string {
  return join(root, 'playwright.config.ts')
}

// ── Settings persistence ──────────────────────────────────────────────────────

export async function loadSettings(): Promise<void> {
  if (settingsLoaded) return
  settingsLoaded = true

  try {
    const raw = await fs.readFile(settingsPath(), 'utf-8')
    const data = JSON.parse(raw) as {
      workspaceRoot?: string
      recentWorkspaces?: string[]
      vaultKeys?: Record<string, string>
    }
    recent = Array.isArray(data.recentWorkspaces) ? data.recentWorkspaces : []
    vaultKeys = data.vaultKeys && typeof data.vaultKeys === 'object' ? data.vaultKeys : {}

    // A remembered workspace that no longer exists must not block startup.
    if (data.workspaceRoot && (await isDirectory(data.workspaceRoot))) {
      // Top up on every open, not just the first: a fresh clone of a workspace
      // arrives without whatever was gitignored (exports/, .flowtest/).
      try {
        await scaffold(data.workspaceRoot)
        workspaceRoot = data.workspaceRoot
      } catch (err) {
        // Unwritable now (moved onto read-only media, permissions changed) —
        // fall through to the picker rather than dying at startup. Reported, because
        // otherwise the user is looking at the Welcome screen with no idea why their
        // workspace didn't open. This runs before the window exists, so it lands in
        // errorChannel's buffer and reaches the renderer via the drain.
        reportToUser(
          '無法開啟上次的工作區',
          `${data.workspaceRoot}\n${describeError(err)}\n\n請重新選擇資料夾。`,
        )
      }
    } else if (data.workspaceRoot) {
      recent = recent.filter((p) => p !== data.workspaceRoot)
      await persist()
    }
  } catch {
    // No settings yet — first run.
  }
}

async function persist(): Promise<void> {
  const payload = { workspaceRoot, recentWorkspaces: recent, vaultKeys }
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(settingsPath(), JSON.stringify(payload, null, 2), 'utf-8')
}

/** The keychain-encrypted vault passphrase remembered for a workspace, if any. */
export function readRememberedPassphrase(root: string): string | null {
  return vaultKeys[root] ?? null
}

/** Remember (or, with null, forget) a workspace's keychain-encrypted vault passphrase. */
export async function rememberPassphrase(root: string, encrypted: string | null): Promise<void> {
  if (encrypted === null) delete vaultKeys[root]
  else vaultKeys[root] = encrypted
  await persist()
}

export async function removeRecentWorkspace(dir: string): Promise<void> {
  recent = recent.filter((p) => p !== dir)
  await persist()
}

// ── Opening a workspace ───────────────────────────────────────────────────────

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Reasons to think twice about a directory. Not a hard block — the user may
 * genuinely want an unusual location — so this only produces a warning string.
 */
export function warnAbout(dir: string): string | null {
  const abs = resolve(dir)
  if (abs === parse(abs).root) return '這是磁碟根目錄，工作區檔案會散落在整個磁碟中。'
  if (abs === resolve(homedir())) return '這是你的使用者家目錄，建議改選一個專屬的子資料夾。'
  return null
}

export async function setWorkspaceRoot(dir: string): Promise<string> {
  const abs = resolve(dir)

  if (!(await isDirectory(abs))) throw new Error(`資料夾不存在：${abs}`)

  try {
    await scaffold(abs)
  } catch (err) {
    throw new Error(`無法寫入資料夾：${abs}\n${String(err)}`)
  }

  workspaceRoot = abs
  recent = [abs, ...recent.filter((p) => p !== abs)].slice(0, RECENT_LIMIT)
  await persist()

  return abs
}

// ── Scaffolding ───────────────────────────────────────────────────────────────

/** Write a file only when absent — scaffolding must never clobber user edits. */
async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await fs.access(path)
  } catch {
    await fs.writeFile(path, content, 'utf-8')
  }
}

/**
 * Lay out (or top up) a workspace. Idempotent: re-opening an existing workspace
 * only fills in what is missing.
 *
 * Ignore rules are written as per-directory .gitignore files rather than by
 * touching the user's own .gitignore at the repo root — git applies each one
 * relative to its own directory, so this needs zero coordination with whatever
 * ignore rules the surrounding project already has.
 */
export async function scaffold(root: string): Promise<void> {
  for (const dir of ['flows', 'projects', 'fixtures', 'exports', ARTIFACT_DIR]) {
    await fs.mkdir(join(root, dir), { recursive: true })
  }

  // Both ignore their own contents but keep themselves tracked: a bare '*' would
  // hide the ignore file too, so it would never be committed and the rule would
  // not survive a clone — leaving the next person's git status full of artifacts.
  //
  // exports/ is regenerated on every export.
  await writeIfMissing(join(root, 'exports', '.gitignore'), '*\n!.gitignore\n')
  // Playwright wipes outputDir before each run, so this has to sit a level above
  // test-results/ to survive.
  await writeIfMissing(join(root, ARTIFACT_DIR, '.gitignore'), '*\n!.gitignore\n')

  await writeIfMissing(configPath(root), PLAYWRIGHT_CONFIG)
  await writeIfMissing(join(root, MARKER), JSON.stringify({ version: 1 }, null, 2) + '\n')
}

const PLAYWRIGHT_CONFIG = `import { defineConfig } from '@playwright/test';

// Generated by FlowTest. Runs are always pointed here explicitly with --config,
// so this file is never shadowed by a playwright.config.ts further up the tree.
export default defineConfig({
  testDir: './exports',
  outputDir: './.flowtest/test-results',
  timeout: 30000,
  reporter: [['html', { outputFolder: './.flowtest/playwright-report', open: 'never' }]],
  use: {
    headless: false,
    viewport: null,
    launchOptions: {
      args: ['--start-maximized'],
    },
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
`
