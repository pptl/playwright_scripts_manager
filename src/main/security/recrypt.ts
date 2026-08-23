import { promises as fs } from 'fs'
import { basename, join } from 'path'
import type { Flow, Project } from '@shared/types'
import { getWorkspaceRoot } from '../storage/workspace'
import { FlowStorage } from '../storage/flowStorage'
import { ProjectStorage } from '../storage/projectStorage'
import {
  stageJson,
  commitStaged,
  discardStaged,
  type StagedWrite,
} from '../storage/atomicWrite'
import { reportToUser, describeError } from '../errorChannel'
import { isCiphertext } from './vault'

/**
 * Re-encrypt every stored secret under a new key (see VAULT_CHANGE_PASSPHRASE).
 *
 * This has to be all-or-nothing, and per-file atomicity does not give that. Rewriting the
 * workspace is a BATCH: the old loop was `load → rewrite → save` per file, so a throw part
 * way through left the already-written files under the NEW key while the vault metadata and
 * verifier still described the OLD one — and that batch could then be opened with neither
 * passphrase. The comment on the IPC handler claimed a failure left the old passphrase
 * working; that was only ever true of the metadata, never of the files.
 *
 * Three phases, ordered so that each one moves the remaining risk closer to zero:
 *
 *   1. Load and rewrite entirely in memory. The likeliest real failure — one envelope that
 *      will not decrypt — lands here, with not a single byte written.
 *   2. Copy every file that is about to be overwritten into `.flowtest/vault-backup/<ts>/`,
 *      which is gitignored. This is the only thing that survives a crash or a power cut.
 *   3. Stage every new file beside its destination, THEN rename them all. Staging is where
 *      disk-full and permission failures happen, and nothing is replaced until it succeeds,
 *      so the commit is nothing but renames. A rename failing part way restores everything
 *      from the backup.
 */

/** Backup generations kept under `.flowtest/vault-backup/`. */
const KEEP_BACKUPS = 3
const BACKUP_ROOT = join('.flowtest', 'vault-backup')

interface PendingWrite {
  filePath: string
  /** Which subdirectory of the backup this file's original belongs in. */
  kind: 'flows' | 'projects'
  data: Flow | Project
}

export async function recryptWorkspace(recrypt: (envelope: string) => string): Promise<void> {
  const pending = await rewriteInMemory(recrypt)
  // Nothing in this workspace is encrypted — no backup, no writes, no timestamps touched.
  if (!pending.length) return

  const backupDir = await backupOriginals(pending)
  await commitAll(pending, backupDir)
}

// ── Phase 1: load + rewrite, memory only ──────────────────────────────────────

async function rewriteInMemory(recrypt: (envelope: string) => string): Promise<PendingWrite[]> {
  const pending: PendingWrite[] = []
  // Tracks whether this file actually held any ciphertext. A file with no secrets is left
  // completely alone — no rewrite, no `updatedAt` bump, nothing for git to see.
  let changed = false
  const pass = (v: string): string => {
    if (!isCiphertext(v)) return v
    changed = true
    return recrypt(v)
  }

  for (const filePath of await FlowStorage.allFilePaths()) {
    const flow = await readOrRefuse<Flow>(filePath)
    changed = false
    for (const profile of flow.profiles ?? []) {
      for (const v of profile.vars) {
        v.value = pass(v.value)
        if (v.envValues) {
          for (const envId of Object.keys(v.envValues)) v.envValues[envId] = pass(v.envValues[envId])
        }
      }
    }
    for (const node of flow.nodes ?? []) {
      if (node.action.value) node.action.value = pass(node.action.value)
    }
    if (!changed) continue
    // The equivalent of `touch: true`, applied here because the write is staged rather than
    // going through FlowStorage.save. Turning over every envelope in the file IS a content
    // change, and the renderer's focus reload gates on this stamp: leaving it untouched is
    // what let the open flow keep its old-key ciphertext and write it back over this (A16).
    flow.updatedAt = new Date().toISOString()
    pending.push({ filePath, kind: 'flows', data: flow })
  }

  for (const filePath of await ProjectStorage.allFilePaths()) {
    const project = await readOrRefuse<Project>(filePath)
    changed = false
    for (const v of project.envVars ?? []) {
      for (const envId of Object.keys(v.values)) v.values[envId] = pass(v.values[envId])
    }
    if (!changed) continue
    project.updatedAt = new Date().toISOString()
    pending.push({ filePath, kind: 'projects', data: project })
  }

  return pending
}

/**
 * Read one file, refusing the whole operation if it cannot be parsed.
 *
 * Deliberately not `FlowStorage.load` / `.list`, which skip what they cannot read so the rest
 * of the app keeps working. That is the right call everywhere else and the wrong one here: a
 * file skipped during a re-key stays under the OLD key while everything around it moves to
 * the new one — A7's exact damage, arrived at quietly. A transiently locked file is the
 * realistic case, and refusing costs the user a retry instead of a stranded file.
 */
async function readOrRefuse<T>(filePath: string): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T
  } catch (err) {
    throw new Error(
      `[FlowTest] 換通行碼中止：無法讀取 ${basename(filePath)}（${describeError(err)}）。\n` +
        `為了避免只有部分檔案換到新金鑰，整個操作已取消，磁碟沒有任何改動。`,
    )
  }
}

// ── Phase 2: back the originals up ────────────────────────────────────────────

async function backupOriginals(pending: PendingWrite[]): Promise<string> {
  const root = getWorkspaceRoot()
  await pruneOldBackups(root)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(root, BACKUP_ROOT, stamp)
  for (const kind of ['flows', 'projects'] as const) {
    await fs.mkdir(join(backupDir, kind), { recursive: true })
  }
  for (const p of pending) {
    await fs.copyFile(p.filePath, backupPathFor(backupDir, p))
  }
  return backupDir
}

function backupPathFor(backupDir: string, p: PendingWrite): string {
  return join(backupDir, p.kind, basename(p.filePath))
}

/** Keep the most recent generations; a stale backup is only old-key ciphertext, but there
 *  is no reason to accumulate one per passphrase change forever. */
async function pruneOldBackups(root: string): Promise<void> {
  try {
    const dir = join(root, BACKUP_ROOT)
    const entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
    for (const name of entries.slice(0, Math.max(0, entries.length - (KEEP_BACKUPS - 1)))) {
      await fs.rm(join(dir, name), { recursive: true, force: true })
    }
  } catch {
    // No backups yet, or an unreadable directory. Pruning is housekeeping — never a reason
    // to abort a passphrase change that is otherwise fine.
  }
}

// ── Phase 3: stage everything, then commit ────────────────────────────────────

async function commitAll(pending: PendingWrite[], backupDir: string): Promise<void> {
  const staged: StagedWrite[] = []
  try {
    for (const p of pending) staged.push(await stageJson(p.filePath, p.data))
  } catch (err) {
    // Nothing has been replaced yet, so there is nothing to roll back.
    await discardStaged(staged)
    throw err
  }

  try {
    await commitStaged(staged)
  } catch (err) {
    await discardStaged(staged)
    await rollback(pending, backupDir, err)
  }
}

/**
 * Put every original back. Deliberately restores ALL of them rather than only the ones the
 * failed commit had reached: copying a file over an identical copy of itself costs nothing,
 * and not having to know how far the rename loop got removes the one thing that could get
 * this wrong.
 */
async function rollback(pending: PendingWrite[], backupDir: string, cause: unknown): Promise<never> {
  const failed: string[] = []
  for (const p of pending) {
    try {
      await fs.copyFile(backupPathFor(backupDir, p), p.filePath)
    } catch (err) {
      failed.push(`${basename(p.filePath)} — ${describeError(err)}`)
    }
  }

  if (failed.length) {
    // The one outcome the user genuinely has to act on, and the modal that raised this is
    // about to close over it — so it also goes out as a toast, which does not expire.
    reportToUser(
      '換通行碼失敗，且自動還原沒有完成',
      `以下檔案未能還原：\n${failed.join('\n')}\n\n` +
        `原始檔案的備份在：\n${backupDir}\n\n` +
        `請先不要繼續編輯，直接從備份手動複製回去。舊通行碼仍然有效。`,
    )
    throw new Error(
      `[FlowTest] 換通行碼失敗，且有 ${failed.length} 個檔案未能自動還原。備份在 ${backupDir}`,
    )
  }

  throw new Error(
    `[FlowTest] 換通行碼失敗，所有檔案已還原（舊通行碼仍然有效）。` +
      `備份在 ${backupDir}。原因：${describeError(cause)}`,
  )
}
