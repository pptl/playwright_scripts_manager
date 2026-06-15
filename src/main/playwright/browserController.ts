import { chromium, Browser, Page } from 'playwright-core'

export class BrowserController {
  private browser: Browser | null = null
  private page: Page | null = null

  async launch(): Promise<void> {
    this.browser = await chromium.launch({ headless: false })
    const context = await this.browser.newContext()
    this.page = await context.newPage()

    // Auto-clean when the user closes the browser window manually
    this.browser.on('disconnected', () => {
      this.browser = null
      this.page = null
    })

    // Also clean up if the page itself is closed (e.g. tab close)
    this.page.on('close', () => {
      this.page = null
    })
  }

  async close(): Promise<void> {
    try {
      await this.browser?.close()
    } catch {
      // ignore errors if already closed
    } finally {
      this.browser = null
      this.page = null
    }
  }

  getPage(): Page {
    if (!this.page || this.page.isClosed()) throw new Error('Browser page not available')
    return this.page
  }

  isRunning(): boolean {
    return (
      this.browser !== null &&
      this.browser.isConnected() &&
      this.page !== null &&
      !this.page.isClosed()
    )
  }
}
