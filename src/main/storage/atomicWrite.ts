import { promises as fs } from 'fs'

/**
 * JSON writes that cannot leave a half-written file behind.
 *
 * Every storage class already wrote through a `.tmp` + `rename` pair — this is that idiom
 * with one owner instead of a copy per class. `rename` is the atomic step: a reader either
 * sees the whole old file or the whole new one, never a truncated write.
 *
 * The stage/commit half exists for one caller, `security/recrypt.ts`. Rewriting every stored
 * secret under a new key is a BATCH, and per-file atomicity says nothing about a batch: a
 * failure half way through leaves some files under the new key and the rest under the old.
 * Splitting the two phases moves every write that can realistically fail (disk full, file
 * locked, permissions) ahead of the point where any real file is replaced, so the commit is
 * nothing but renames.
 */

const TMP_SUFFIX = '.tmp'

export interface StagedWrite {
  /** Where the content is destined to land. */
  filePath: string
  /** Where it is sitting right now. */
  tmpPath: string
}

function serialize(data: unknown): string {
  return JSON.stringify(data, null, 2)
}

/** Write one JSON file so that no reader can observe a partial write. */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}${TMP_SUFFIX}`
  await fs.writeFile(tmpPath, serialize(data), 'utf-8')
  await fs.rename(tmpPath, filePath)
}

/** Put the new content beside its destination without replacing anything yet. */
export async function stageJson(filePath: string, data: unknown): Promise<StagedWrite> {
  const tmpPath = `${filePath}${TMP_SUFFIX}`
  await fs.writeFile(tmpPath, serialize(data), 'utf-8')
  return { filePath, tmpPath }
}

/**
 * Replace every destination with its staged content. Throws on the first failure —
 * the caller is responsible for restoring whatever was already replaced, since only it
 * knows where the originals were kept.
 */
export async function commitStaged(staged: StagedWrite[]): Promise<void> {
  for (const s of staged) {
    await fs.rename(s.tmpPath, s.filePath)
  }
}

/** Best-effort cleanup of staged content that will never be committed. */
export async function discardStaged(staged: StagedWrite[]): Promise<void> {
  for (const s of staged) {
    try {
      await fs.unlink(s.tmpPath)
    } catch {
      // The abort path must not fail on cleanup — a leftover .tmp is harmless.
    }
  }
}
