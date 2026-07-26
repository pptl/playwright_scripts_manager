import { promises as fs } from 'fs'
import { createHash } from 'crypto'
import { basename, extname, isAbsolute, join, resolve } from 'path'
import { app } from 'electron'

/** Root that flows/, projects/, exports/ and fixtures/ all live under.
 *  Also the cwd used when spawning `npx playwright test` (see ipcHandlers RUN_TESTS),
 *  which is why fixture paths can be stored relative to it. */
export function dataRoot(): string {
  return app.isPackaged ? app.getPath('userData') : process.cwd()
}

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
}
