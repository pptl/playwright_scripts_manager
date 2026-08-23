// C12 regression/verification test — generateCSSSelector/getLocatorExpr used to be
// hand-duplicated once as real TS functions inside getDOMCaptureScript()'s closure and once
// as a string-template copy inside getAssertionToolbarScript(). The fix extracts a single
// string source (getSelectorHelpersScript, in
// src/main/playwright/browserScripts/captureShared.ts) that
// both consumers now delegate to via window.__ftCssSelector / window.__ftLocatorExpr,
// installed by a new addInitScript registered before either consumer (see
// codegenCapture.ts's init-script order).
//
// This test proves three things that a `tsc --noEmit` pass cannot:
//   1. The click-capture path and the assertion-pick path now produce byte-identical
//      selector/locatorExpr for the same element (they're really sharing one
//      implementation, not two copies that merely look alike).
//   2. The injection order in codegenCapture.ts is correct — if getDOMCaptureScript() or
//      getAssertionToolbarScript() ran before getSelectorHelpersScript(), calling the
//      aliased functions would throw ("generateCSSSelector is not a function"), which
//      would show up here as report()/assert_report() never firing.
//   3. The quote-escaping fix (the two old copies disagreed: only the assertion-toolbar
//      copy escaped `"` inside aria-label/name) now applies identically on both paths —
//      tested with an aria-label that itself contains a double quote.
//
// Same standalone-compile approach as a12-assert-escape-press.js, for the same reason:
// BrowserController exposes no CDP endpoint an external script could attach to the real
// recorded browser window, so this runs the injected scripts in a plain headless Chromium
// page via `playwright` instead of driving the Electron app.
'use strict'
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')
const { chromium } = require('playwright')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const OUT_DIR = path.join(__dirname, '.c12-scratch', 'compiled')

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true })
}

// D3 (project references) moved captureShared.ts into its own browserScripts/ subdirectory
// so it could get its own DOM-enabled tsconfig — see tsconfig.recorder-dom.json.
const SRC_DIR = path.join(PROJECT_ROOT, 'src', 'main', 'playwright', 'browserScripts')
const SCRATCH_TS = path.join(SRC_DIR, 'captureShared.c12scratch.ts')

/** See a12-assert-escape-press.js for the full rationale — same compile step, duplicated
 *  here (rather than shared) so this test stays independently runnable. */
function compileCaptureShared() {
  rmrf(OUT_DIR)
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const original = fs.readFileSync(path.join(SRC_DIR, 'captureShared.ts'), 'utf8')
  fs.writeFileSync(SCRATCH_TS, original.replace('import.meta.url', "''"))
  try {
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
  return require(path.join(OUT_DIR, 'main', 'playwright', 'browserScripts', 'captureShared.c12scratch.js'))
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
  const { getSelectorHelpersScript, getDOMCaptureScript, getAssertionToolbarScript } = captureShared

  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    // No id/data-testid/name on the target, and an aria-label containing a literal double
    // quote — forces generateCSSSelector down the aria-label branch that used to be
    // unescaped in one of the two copies.
    await page.setContent(
      '<!doctype html><html><body>' +
      '<div data-test-target="1" aria-label=\'Say "Hi"\' style="width:120px;height:40px;">Click</div>' +
      '</body></html>',
    )

    const reportCalls = []
    const assertReportCalls = []
    await page.exposeFunction('__flowtest_report', (data) => reportCalls.push(data))
    await page.exposeFunction('__flowtest_assert_report', (data) => assertReportCalls.push(data))
    await page.exposeFunction('__flowtest_assert_cancel', () => {})

    // Injection order mirrors codegenCapture.ts exactly: helpers first, then the two
    // consumers. This ordering is itself under test — see file header point 2.
    await page.evaluate((src) => {
      // eslint-disable-next-line no-eval
      ;(0, eval)(src)
    }, getSelectorHelpersScript())
    check(
      'selector helpers installed on window',
      await page.evaluate(() => typeof window.__ftCssSelector === 'function' && typeof window.__ftLocatorExpr === 'function'),
    )

    await page.evaluate(getDOMCaptureScript())
    await page.evaluate((src) => {
      // eslint-disable-next-line no-eval
      ;(0, eval)(src)
    }, getAssertionToolbarScript())

    // ── Path 1: plain click, captured by getDOMCaptureScript's listeners ──────────
    await page.click('[data-test-target="1"]')
    await page.waitForTimeout(50)
    const clickReport = reportCalls.find((c) => c.kind === 'click')
    check('click path reported an action', !!clickReport, JSON.stringify(reportCalls))

    // ── Path 2: assertion picker, captured by getAssertionToolbarScript's overlay ─
    await page.evaluate(() => window.__ft_startAssertPick('assertVisible'))
    const box = await page.locator('[data-test-target="1"]').boundingBox()
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    // Raw mouse-level click (not page.click(selector)) — the picker overlay covers the
    // whole viewport, which would fail Playwright's actionability check on the target
    // itself. The overlay's own click handler hides itself and resolves elementFromPoint,
    // exactly like the real in-browser picker.
    await page.mouse.click(cx, cy)
    await page.waitForTimeout(50)
    const assertReport = assertReportCalls[0]
    check('assert-pick path reported an action', !!assertReport, JSON.stringify(assertReportCalls))

    if (clickReport && assertReport) {
      check(
        'both paths escape the quote in aria-label',
        clickReport.selector.includes('\\"Hi\\"'),
        clickReport.selector,
      )
      check(
        'click path and assert-pick path produce identical selector',
        clickReport.selector === assertReport.selector,
        `click=${clickReport.selector} assert=${assertReport.selector}`,
      )
      check(
        'click path and assert-pick path produce identical locatorExpr',
        clickReport.locatorExpr === assertReport.locatorExpr,
        `click=${clickReport.locatorExpr} assert=${assertReport.locatorExpr}`,
      )
      const resolvesToTarget = await page.evaluate((sel) => {
        try {
          return document.querySelector(sel) === document.querySelector('[data-test-target="1"]')
        } catch (e) {
          return 'ERROR: ' + e.message
        }
      }, clickReport.selector)
      check('the escaped selector is syntactically valid and resolves to the target element', resolvesToTarget === true, String(resolvesToTarget))
    }
  } finally {
    await browser.close()
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail > 0 ? 1 : 0)
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
