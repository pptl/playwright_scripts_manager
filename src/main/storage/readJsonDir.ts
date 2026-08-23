import { promises as fs } from 'fs'
import { join } from 'path'
import { describeError } from '../errorChannel'

/**
 * Reads every `.json` file in `dir`, calling `onEntry(parsed, file)` for each one that
 * parses successfully. Files that fail to read/parse are collected — not reported per
 * file, which would blow past the 4-deep toast stack for one bad directory — and handed
 * to `onCorrupted` once at the end, with the caller's own wording.
 */
export async function readJsonDir<T>(
  dir: string,
  files: string[],
  onEntry: (parsed: T, file: string) => void,
  onCorrupted: (corrupted: string[]) => void,
): Promise<void> {
  const corrupted: string[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(join(dir, file), 'utf-8')
      onEntry(JSON.parse(raw) as T, file)
    } catch (err) {
      corrupted.push(`${file} — ${describeError(err)}`)
    }
  }
  if (corrupted.length) onCorrupted(corrupted)
}
