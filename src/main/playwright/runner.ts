import { spawn } from 'child_process'
import { createRequire } from 'module'
import { delimiter, resolve, sep } from 'path'

/**
 * Running the generated specs used to mean `npx playwright test` with the cwd
 * set to wherever the data happened to live. That only ever worked by accident:
 * Playwright walks *up* from the cwd looking for a config, and in dev that
 * happened to land on this repo's own playwright.config.ts and node_modules.
 *
 * Once the data root is an arbitrary folder inside the user's project, both
 * assumptions break — their repo may carry its own playwright.config.ts (which
 * would silently hijack the run) and almost certainly has no @playwright/test,
 * leaving npx to download an arbitrary version, or fail with no network.
 *
 * So: run the CLI we ship, with Electron's own Node, against a config we
 * generated and name explicitly. The user's machine needs no Node at all.
 */

const _req = createRequire(import.meta.url)

/** asar is a read-only archive — spawn cannot execute out of it, so the
 *  Playwright packages are unpacked next to it (see build.asarUnpack). */
function unpacked(p: string): string {
  return p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
}

export interface PlaywrightCli {
  path: string
  version: string
  /** Our node_modules, handed to the child as NODE_PATH — see below. */
  nodePath: string
}

let cached: PlaywrightCli | null | undefined

/** The bundled Playwright CLI, or null when it is missing from the build. */
export function resolvePlaywrightCli(): PlaywrightCli | null {
  if (cached !== undefined) return cached

  try {
    const path = unpacked(_req.resolve('@playwright/test/cli'))
    const version = (_req('@playwright/test/package.json') as { version: string }).version
    // .../node_modules/@playwright/test/cli.js → .../node_modules
    cached = { path, version, nodePath: resolve(path, '..', '..', '..') }
  } catch {
    cached = null
  }
  return cached
}

/**
 * Where the HTML report goes, relative to the workspace. Forced through the env
 * var rather than left to the config file: an adopted folder may already carry a
 * playwright.config.ts pointing somewhere else, and SHOW_REPORT has to be able
 * to find the report without parsing it. This env var beats the config.
 */
export const HTML_REPORT_DIR = '.flowtest/playwright-report'

export interface SpawnResult {
  exitCode: number
  /** Everything the process wrote, so callers can inspect it after the fact. */
  output: string
}

/**
 * Run the bundled Playwright CLI, streaming its output as it arrives.
 *
 * Two env vars carry the whole "works in any folder" promise:
 *
 * - ELECTRON_RUN_AS_NODE turns our own binary into a plain Node interpreter, so
 *   the user's machine needs no Node installation.
 * - NODE_PATH points at our node_modules. Shipping the CLI is not enough on its
 *   own: both the generated config and every generated spec do
 *   `import ... from '@playwright/test'`, and Node resolves that by walking up
 *   from *the importing file*, i.e. the user's workspace — which has no
 *   node_modules and would fail with MODULE_NOT_FOUND. NODE_PATH is the
 *   fallback Node consults after that walk comes up empty.
 */
export function runPlaywright(
  cli: PlaywrightCli,
  args: string[],
  cwd: string,
  onOutput: (chunk: string) => void,
  /** Private values, as FT_SECRET_* names. Generated specs read them via process.env,
   *  so an in-app run never writes a plaintext credential to disk. */
  extraEnv: Record<string, string> = {},
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli.path, ...args], {
      cwd,
      env: {
        ...process.env,
        ...extraEnv,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_PATH: process.env.NODE_PATH
          ? `${cli.nodePath}${delimiter}${process.env.NODE_PATH}`
          : cli.nodePath,
        PLAYWRIGHT_HTML_OUTPUT_DIR: HTML_REPORT_DIR,
        // The run must never block on a browser popping open by itself; the user
        // opens the report deliberately via SHOW_REPORT.
        PLAYWRIGHT_HTML_OPEN: 'never',
      },
    })

    let output = ''
    const pipe = (d: Buffer): void => {
      const text = d.toString()
      output += text
      onOutput(text)
    }
    child.stdout.on('data', pipe)
    child.stderr.on('data', pipe)

    child.on('error', (err) => {
      const text = `\n✗ 無法啟動測試執行器: ${String(err)}\n`
      output += text
      onOutput(text)
      resolve({ exitCode: 1, output })
    })
    child.on('close', (code) => resolve({ exitCode: code ?? 1, output }))
  })
}

export const MISSING_CLI_MESSAGE =
  '✗ 找不到內建的測試執行器 (@playwright/test)。\n' +
  '  這是打包問題，不是設定問題 — 請確認建置時有包含並解壓 node_modules/@playwright/test。\n'
