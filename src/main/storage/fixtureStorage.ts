import { promises as fs } from 'fs'
import { createHash } from 'crypto'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { dataRoot } from './workspace'

export { dataRoot }

function fixturesDir(): string {
  return join(dataRoot(), 'fixtures')
}

/** Directory name as it appears in stored (relative) fixture paths. */
const FIXTURES_PREFIX = 'fixtures'

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

export class FixtureStorage {
  /**
   * Copy a picked file into fixtures/ and return both the stored (relative) path
   * written into the Action and the absolute path on disk.
   *
   * Same name + same content → reuse the existing copy. Same name, different
   * content → insert a short content hash before the extension.
   */
  static async importFile(sourcePath: string): Promise<{ stored: string; abs: string }> {
    await fs.mkdir(fixturesDir(), { recursive: true })
    const name = basename(sourcePath)
    let target = join(fixturesDir(), name)

    try {
      await fs.access(target)
      // A file with this name already exists — reuse it only if identical.
      if ((await sha256(target)) !== (await sha256(sourcePath))) {
        const ext = extname(name)
        const stem = ext ? name.slice(0, -ext.length) : name
        const hash = (await sha256(sourcePath)).slice(0, 6)
        target = join(fixturesDir(), `${stem}.${hash}${ext}`)
        await fs.copyFile(sourcePath, target)
      }
    } catch {
      await fs.copyFile(sourcePath, target)
    }

    return { stored: `${FIXTURES_PREFIX}/${basename(target)}`, abs: target }
  }

  /**
   * Resolve a stored fixture path for use with setInputFiles.
   * Absolute paths (hand-typed, or legacy nodes) pass through untouched; relative
   * paths resolve against the data root — the main process cwd is not the data root
   * once packaged, so this must never be left to the cwd.
   */
  static toAbsolute(stored: string): string {
    return isAbsolute(stored) ? stored : resolve(dataRoot(), stored)
  }

  /**
   * Make a user-supplied path portable before it is stored on an Action.
   *
   * An absolute path pins the flow to one machine, which defeats sharing the
   * workspace through git. Anything already inside the workspace just loses its
   * prefix — that also means a flow can reference the surrounding repo's own
   * test data (testdata/foo.png) without a redundant copy under fixtures/.
   * Anything outside is copied in, since nothing else would travel with the repo.
   *
   * Bare filenames (drag & drop uploads, which never expose a path) are left
   * alone for the UI to flag.
   */
  static async normalizeStoredPath(input: string): Promise<string> {
    const value = input.trim()
    if (!value || !isAbsolute(value)) return value

    const rel = relative(dataRoot(), value)
    // Inside the workspace: no '..' escape and not a different drive.
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      return rel.split(sep).join('/')
    }

    try {
      return (await FixtureStorage.importFile(value)).stored
    } catch {
      return value // unreadable source — keep what the user typed rather than lose it
    }
  }
}
