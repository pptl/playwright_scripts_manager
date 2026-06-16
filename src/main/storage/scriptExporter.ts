import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { Flow, FlowNode, ExportConfig, TestPath } from '../../shared/types'
import { hasVariables, valueToCodeExpr, VARIABLE_HELPERS_CODE } from '../../shared/variableResolver'

function exportsDir(): string {
  return app.isPackaged
    ? join(app.getPath('userData'), 'exports')
    : join(process.cwd(), 'exports')
}

export class ScriptExporter {
  static async export(flow: Flow, config: ExportConfig): Promise<string> {
    const outputDir = config.outputDir || exportsDir()
    await fs.mkdir(outputDir, { recursive: true })

    const paths = ScriptExporter.computePaths(flow)
    const nodeMap = new Map(flow.nodes.map((n) => [n.id, n]))

    let helperImport = ''
    let helperCode = ''

    if (config.helperFunctions) {
      const result = ScriptExporter.extractHelpers(paths, nodeMap, flow)
      helperCode = result.helperCode
      helperImport = result.helperImport
      if (helperCode) {
        const helpersDir = join(outputDir, 'helpers')
        await fs.mkdir(helpersDir, { recursive: true })
        await fs.writeFile(join(helpersDir, `${flow.id}-helpers.ts`), helperCode, 'utf-8')
      }
    }

    const specContent = ScriptExporter.generateSpec(flow, paths, nodeMap, config, helperImport)
    const specPath = join(outputDir, `${flow.id}.spec.ts`)
    await fs.writeFile(specPath, specContent, 'utf-8')

    return specPath
  }

  // Compute all root-to-leaf paths
  static computePaths(flow: Flow): TestPath[] {
    const nodeMap = new Map(flow.nodes.map((n) => [n.id, n]))
    const paths: TestPath[] = []

    const walk = (node: FlowNode, currentPath: string[], pathName: string[]) => {
      const newPath = [...currentPath, node.id]
      const newName = [...pathName, node.action.description]

      if (node.childIds.length === 0) {
        paths.push({
          id: `path-${paths.length + 1}`,
          name: newName.filter((_, i) => i === 0 || i === newName.length - 1).join(' → '),
          nodeIds: newPath,
        })
        return
      }

      for (const childId of node.childIds) {
        const child = nodeMap.get(childId)
        if (child) walk(child, newPath, newName)
      }
    }

    const root = nodeMap.get(flow.rootNodeId)
    if (root) walk(root, [], [])

    return paths
  }

  private static generateSpec(
    flow: Flow,
    paths: TestPath[],
    nodeMap: Map<string, FlowNode>,
    config: ExportConfig,
    helperImport: string,
  ): string {
    const usesVariables = flow.nodes.some((n) => n.action.value && hasVariables(n.action.value))

    const tests = paths
      .map((path, idx) => {
        const testName = path.name || `測試路徑 ${idx + 1}`
        const steps = path.nodeIds.map((id) => nodeMap.get(id)!).filter(Boolean)
        const stepCode = steps
          .map((node) => {
            const action = ScriptExporter.actionToCode(node)
            const assertCode = node.action.assertion
              ? ScriptExporter.assertionToCode(node.action)
              : ''
            if (config.useTestStep) {
              return `    await test.step('${node.action.description}', async () => {\n      ${action}${assertCode ? '\n      ' + assertCode : ''}\n    });`
            }
            return `    // ${node.action.description}\n    ${action}${assertCode ? '\n    ' + assertCode : ''}`
          })
          .join('\n\n')

        return `  test('${testName}', async ({ page }) => {\n${stepCode}\n  });`
      })
      .join('\n\n')

    return [
      `import { test, expect } from '@playwright/test';`,
      helperImport,
      usesVariables ? VARIABLE_HELPERS_CODE : '',
      '',
      `test.describe('${flow.name}', () => {`,
      '',
      tests,
      '',
      '});',
    ]
      .filter((line) => line !== undefined)
      .join('\n')
  }

  private static actionToCode(node: FlowNode): string {
    const { action } = node

    // Locator priority:
    // 1. If selector has [name="..."] (form inputs), always use it — it's already
    //    the most specific unique CSS selector and avoids strict-mode violations
    //    caused by getByPlaceholder matching multiple elements on the same page.
    // 2. If locatorExpr uses getByText, try to upgrade to getByRole with exact:true.
    //    This handles the case where the click landed on a <span> inside a <button>
    //    before the bubble-up fix was applied.
    // 3. Otherwise use locatorExpr, falling back to CSS selector.
    let loc: string
    const { locatorExpr, selector } = action

    if (selector && /^\[name=/.test(selector)) {
      // Form input with a name attribute — always the most reliable locator
      loc = `page.locator('${selector}')`
    } else if (selector && /^\[data-id=/.test(selector)) {
      // Unique data-id attribute (e.g. MUI nav buttons that share the same aria-label)
      loc = `page.locator('${selector}')`
    } else if (selector && /^\[aria-label=/.test(selector) && locatorExpr && /^getByText\(/.test(locatorExpr)) {
      // Element has a unique aria-label: prefer it over getByText which can time out
      // on buttons whose textContent doesn’t perfectly match (e.g. icon + text).
      loc = `page.locator('${selector}')`
    } else if (locatorExpr && /^getByText\(/.test(locatorExpr)) {
      // Attempt to upgrade getByText("X") → getByRole("tag", { name: "X", exact: true })
      // when the selector tells us the actual HTML element type.
      // Note: stored locatorExpr may already contain { exact: true } so match just the text portion.
      const textMatch = locatorExpr.match(/^getByText\("([^"]+)"/)
      if (textMatch && selector && /^button/.test(selector)) {
        loc = `page.getByRole("button", { name: "${textMatch[1]}", exact: true })`
      } else if (textMatch && selector && /^a[\s\[]/.test(selector)) {
        loc = `page.getByRole("link", { name: "${textMatch[1]}", exact: true })`
      } else if (textMatch) {
        // No role info — at least add exact:true to limit partial matches
        loc = `page.getByText("${textMatch[1]}", { exact: true })`
      } else {
        loc = `page.${locatorExpr}`
      }
    } else if (locatorExpr) {
      loc = `page.${locatorExpr}`
    } else {
      loc = `page.locator('${selector}')`
    }

    switch (action.type) {
      case 'goto':
        return `await page.goto(${valueToCodeExpr(action.value ?? '')});`
      case 'click':
        return `await ${loc}.click();`
      case 'fill':
        return `await ${loc}.fill(${valueToCodeExpr(action.value ?? '')});`
      case 'selectOption':
        return `await ${loc}.selectOption(${valueToCodeExpr(action.value ?? '')});`
      case 'check':
        return `await ${loc}.check();`
      case 'uncheck':
        return `await ${loc}.uncheck();`
      case 'press':
        // keyboard.press has no locator
        return action.locatorExpr
          ? `await ${loc}.press(${valueToCodeExpr(action.value ?? '')});`
          : `await page.keyboard.press(${valueToCodeExpr(action.value ?? '')});`
      case 'wait':
        return `await ${loc}.waitFor({ state: 'visible' });`
      case 'assertVisible':
        return `await expect(${loc}).toBeVisible();`
      case 'assertText':
        return `await expect(${loc}).toContainText(${valueToCodeExpr(action.value ?? '')});`
      case 'assertValue':
        return `await expect(${loc}).toHaveValue(${valueToCodeExpr(action.value ?? '')});`
      default:
        return `// TODO: ${action.type}`
    }
  }

  private static assertionToCode(action: { assertion?: Flow['nodes'][0]['action']['assertion'] }): string {
    const a = action.assertion
    if (!a) return ''
    switch (a.type) {
      case 'text':
        return `await expect(page.locator('${a.target}')).toContainText('${a.expected}');`
      case 'visible':
        return `await expect(page.locator('${a.target}')).toBeVisible();`
      case 'url':
        return `await expect(page).toHaveURL(/${a.expected}/);`
      case 'count':
        return `await expect(page.locator('${a.target}')).toHaveCount(${a.expected});`
      default:
        return ''
    }
  }

  private static extractHelpers(
    paths: TestPath[],
    nodeMap: Map<string, FlowNode>,
    flow: Flow,
  ): { helperCode: string; helperImport: string } {
    if (paths.length < 2) return { helperCode: '', helperImport: '' }

    // Find the longest common prefix across all paths
    const pathArrays = paths.map((p) => p.nodeIds)
    let prefixLen = 0
    outer: for (let i = 0; i < pathArrays[0].length; i++) {
      const id = pathArrays[0][i]
      for (let j = 1; j < pathArrays.length; j++) {
        if (pathArrays[j][i] !== id) break outer
      }
      prefixLen++
    }

    if (prefixLen < 3) return { helperCode: '', helperImport: '' }

    const prefixNodes = pathArrays[0].slice(0, prefixLen).map((id) => nodeMap.get(id)!)
    const fnName = `setup_${flow.id.replace(/-/g, '_')}`
    const body = prefixNodes
      .map((node) => {
        const action = ScriptExporter.actionToCode(node)
        const assertCode = node.action.assertion ? ScriptExporter.assertionToCode(node.action) : ''
        return `  // ${node.action.description}\n  ${action}${assertCode ? '\n  ' + assertCode : ''}`
      })
      .join('\n\n')

    const helperCode = `import { Page, expect } from '@playwright/test';\n\nexport async function ${fnName}(page: Page): Promise<void> {\n${body}\n}\n`
    const helperImport = `import { ${fnName} } from './helpers/${flow.id}-helpers';`

    return { helperCode, helperImport }
  }
}
