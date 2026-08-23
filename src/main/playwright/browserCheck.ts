import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Where Playwright keeps its downloaded browsers.
 * PLAYWRIGHT_BROWSERS_PATH wins when set (0 means "next to the package", which we
 * cannot enumerate reliably — treated as "unknown", see hasChromium).
 */
function browsersRoot(): string | null {
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (override) return override === '0' ? null : override

  switch (process.platform) {
    case 'win32':
      return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ms-playwright')
    case 'darwin':
      return join(homedir(), 'Library', 'Caches', 'ms-playwright')
    default:
      return join(homedir(), '.cache', 'ms-playwright')
  }
}

/**
 * Is *any* Chromium build present?
 *
 * Deliberately does NOT use chromium.executablePath(): that returns a
 * revision-pinned path (ms-playwright/chromium-<revision>/…), so a machine
 * carrying a perfectly usable Chromium from a different Playwright version
 * would be reported as "not installed" — a false alarm on every launch.
 *
 * A revision mismatch is not our problem to predict. Playwright itself reports
 * it precisely ("Executable doesn't exist … run npx playwright install") when a
 * run actually fails, and isMissingBrowserError() turns that into an install
 * prompt after the fact.
 */
export async function hasChromium(): Promise<boolean> {
  const root = browsersRoot()
  if (root === null) return true // can't enumerate — assume fine rather than nag

  try {
    const entries = await fs.readdir(root)
    return entries.some((e) => e.startsWith('chromium'))
  } catch {
    return false // no ms-playwright directory at all
  }
}

/** Does this failure mean the browser binary is missing (as opposed to a test failure)? */
export function isMissingBrowserError(text: string): boolean {
  return (
    text.includes("Executable doesn't exist") ||
    text.includes('playwright install') ||
    text.includes('browserType.launch: Executable')
  )
}
