import { Page } from 'playwright-core'
import type { Action, LocatorOption } from '../../shared/types'
import { CodegenCapture } from './codegenCapture'
import type { AssertPickType } from './captureShared'

type ActionCallback = (action: Action, alternatives?: LocatorOption[]) => void

export class Recorder {
  private page: Page
  private capture: CodegenCapture
  private recording = false

  constructor(page: Page, onAction: ActionCallback) {
    this.page = page
    this.capture = new CodegenCapture(page.context(), onAction)
  }

  /**
   * @param baseURL - if provided, navigate to this URL after starting capture.
   *                  Omit for branch recording (already at the right page after silent replay).
   */
  async start(baseURL?: string): Promise<void> {
    if (this.recording) return
    this.recording = true
    await this.capture.start()
    if (baseURL) {
      await this.page.goto(baseURL)
    }
  }

  async stop(): Promise<void> {
    await this.capture.stop()
    this.recording = false
  }

  async startAssertionPick(assertionType: AssertPickType, onCancel: () => void): Promise<void> {
    await this.capture.startAssertionPick(assertionType, onCancel)
  }

  pause(): void  { this.capture.pause() }
  resume(): void { this.capture.resume() }

  isRecording(): boolean {
    return this.recording
  }
}

