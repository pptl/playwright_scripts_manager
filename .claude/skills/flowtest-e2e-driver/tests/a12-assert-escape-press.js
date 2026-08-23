// A12 regression test — assertion dock Escape-to-cancel must not also get recorded as a
// `press` action on <body>. Root cause: getAssertionToolbarScript()'s escHandler and
// getDOMCaptureScript()'s press listener were both registered on `document` in the capture
// phase; the press listener (installed at page-init time) always registers first, so by the
// time escHandler's `stopPropagation()` ran, the press listener had already fired. Fix moves
// escHandler onto `window`, which is strictly earlier in the capture-phase traversal
// (window -> document -> ... -> target) regardless of registration order.
//
// Unlike the other tests in this directory, this one does NOT drive the Electron app via
// `_electron` — A12 lives entirely in JS injected into the RECORDED page
// (getDOMCaptureScript / getAssertionToolbarScript in
// src/main/playwright/browserScripts/captureShared.ts),
// and BrowserController exposes no CDP endpoint an external script could attach to. Instead
// this compiles captureShared.ts standalone (it has zero runtime `electron` import — only
// `import type { BrowserWindow }`) and runs the two injected scripts in a real headless
// Chromium page via plain `playwright`, reproducing the exact registration-order bug.
'use strict'
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')
const { chromium } = require('playwright')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
// Must live under PROJECT_ROOT (not os.tmpdir()) so Node's ESM resolution can walk up to
// PROJECT_ROOT/node_modules and find `uuid` from the compiled file. Gitignored.
const OUT_DIR = path.join(__dirname, '.a12-scratch', 'compiled')

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true })
}

// D3 (project references) moved captureShared.ts into its own browserScripts/ subdirectory
// so it could get its own DOM-enabled tsconfig — see tsconfig.recorder-dom.json.
const SRC_DIR = path.join(PROJECT_ROOT, 'src', 'main', 'playwright', 'browserScripts')
const SCRATCH_TS = path.join(SRC_DIR, 'captureShared.a12scratch.ts')

/** Compiles captureShared.ts (+ its two relative deps) to CommonJS JS so it can be
 *  require()'d from plain Node, without pulling in the whole electron-vite/bundler setup.
 *
 *  Two wrinkles this works around:
 *   - Node's CommonJS `require()` resolves extensionless relative imports fine (unlike its
 *     ESM loader, which demands explicit `.js` extensions tsc's output doesn't add) — so
 *     CommonJS is the easy target here, not ESM.
 *   - The file has one `import.meta.url` reference (inside extractSource3(), which this test
 *     never calls) — a *syntax* error under `--module commonjs` regardless of whether it runs.
 *     Compiling a scratch copy with that one expression replaced sidesteps it without editing
 *     the real source. The scratch file sits next to the original (not in a temp dir) so its
 *     relative imports ("../../errorChannel", "../../../shared/types") still resolve during
 *     compilation, and is always removed in a `finally`. */
function compileCaptureShared() {
  rmrf(OUT_DIR)
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const original = fs.readFileSync(path.join(SRC_DIR, 'captureShared.ts'), 'utf8')
  fs.writeFileSync(SCRATCH_TS, original.replace('import.meta.url', "''"))
  try {
    // Invoke the compiler's own JS entry point via `node` directly rather than `npx tsc`/a
    // shell — avoids Windows shell-quoting pitfalls with the project path's space ("Alen Chua").
    const tscBin = path.join(PROJECT_ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js')
    execFileSync(
      process.execPath,
      [
        tscBin,
        SCRATCH_TS,
        '--outDir', OUT_DIR,
        '--module', 'commonjs',
        '--target', 'es2020',
        '--moduleResolution', 'node',
        '--esModuleInterop',
        '--skipLibCheck',
        '--lib', 'ES2020,DOM',
        '--rootDir', path.join(PROJECT_ROOT, 'src'),
      ],
      { cwd: PROJECT_ROOT, stdio: 'pipe' },
    )
  } finally {
    rmrf(SCRATCH_TS)
  }
  return require(path.join(OUT_DIR, 'main', 'playwright', 'browserScripts', 'captureShared.a12scratch.js'))
}

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`)
  }
}

;(async () => {
  console.log('Compiling captureShared.ts...')
  const captureShared = await compileCaptureShared()
  const { getDOMCaptureScript, getAssertionToolbarScript } = captureShared

  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<!doctype html><html><body></body></html>')

    const reportCalls = []
    const assertReportCalls = []
    const assertCancelCalls = []
    await page.exposeFunction('__flowtest_report', (data) => reportCalls.push(data))
    await page.exposeFunction('__flowtest_assert_report', (data) => assertReportCalls.push(data))
    await page.exposeFunction('__flowtest_assert_cancel', () => assertCancelCalls.push(true))

    // Install the DOM capture press listener first (mirrors the real init-script timing:
    // it runs at page load, before the user ever opens the assertion dock).
    await page.evaluate(getDOMCaptureScript())
    // Then install the assertion dock/overlay script (mirrors the real recorder, which
    // injects both together, but the dock's picker only *activates* on user click — later).
    await page.evaluate((src) => {
      // eslint-disable-next-line no-eval
      ;(0, eval)(src)
    }, getAssertionToolbarScript())

    // Equivalent of the user clicking the 👁 button on the dock, then pressing Escape to
    // cancel the pick instead of clicking an element.
    await page.evaluate(() => window.__ft_startAssertPick('assertVisible'))
    await page.keyboard.press('Escape')
    // Give the exposed-function round trips a tick to land.
    await page.waitForTimeout(100)

    check('assert_cancel fired exactly once', assertCancelCalls.length === 1, `got ${assertCancelCalls.length}`)
    check('assert_report was never called (no element was picked)', assertReportCalls.length === 0)
    const spuriousPress = reportCalls.find((c) => c.kind === 'press' && c.value === 'Escape')
    check(
      'no spurious press/Escape action was recorded',
      !spuriousPress,
      spuriousPress ? JSON.stringify(spuriousPress) : undefined,
    )
    check('no other report() calls happened', reportCalls.length === 0, `got ${JSON.stringify(reportCalls)}`)
  } finally {
    await browser.close()
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail > 0 ? 1 : 0)
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
