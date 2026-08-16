import { promises as fs } from 'fs'
import { join } from 'path'
import type { Flow, FlowListItem } from '../../shared/types'
import { isCallFlowAction } from '../../shared/types'
import { getWorkspaceRoot } from './workspace'
import { reportToUser, describeError, isNotFound } from '../errorChannel'

function flowsDir(): string {
  return join(getWorkspaceRoot(), 'flows')
}

export class FlowStorage {
  static async ensureDir(): Promise<void> {
    await fs.mkdir(flowsDir(), { recursive: true })
  }

  static filePath(flowId: string): string {
    return join(flowsDir(), `${flowId}.json`)
  }

  /**
   * `touch: false` writes without bumping updatedAt. Used by the debounced save
   * behind node dragging: repositioning is not a content change, and stamping a
   * new timestamp on every drag makes the flow's JSON conflict in git for what
   * is really just a cosmetic move.
   */
  static async save(flow: Flow, opts?: { touch?: boolean }): Promise<void> {
    await FlowStorage.ensureDir()
    if (opts?.touch !== false) flow.updatedAt = new Date().toISOString()
    const filePath = FlowStorage.filePath(flow.id)
    const tmpPath = `${filePath}.tmp`
    await fs.writeFile(tmpPath, JSON.stringify(flow, null, 2), 'utf-8')
    await fs.rename(tmpPath, filePath)
  }

  /**
   * Still `Flow | null` for both "not there" and "unreadable" — callers are unchanged.
   * But only the first is normal, so the second is now reported: a corrupted file used to
   * be indistinguishable from a deletion, and `reloadFromDisk` reads a null as "deleted out
   * from under us" and closes the open flow. It still does; at least the user now learns why.
   */
  static async load(flowId: string): Promise<Flow | null> {
    try {
      const raw = await fs.readFile(FlowStorage.filePath(flowId), 'utf-8')
      return JSON.parse(raw) as Flow
    } catch (err) {
      if (!isNotFound(err)) {
        reportToUser(`流程檔案無法讀取：${flowId}.json`, describeError(err))
      }
      return null
    }
  }

  static async list(): Promise<FlowListItem[]> {
    await FlowStorage.ensureDir()
    const files = await fs.readdir(flowsDir())
    const summaries: Omit<FlowListItem, 'refCount'>[] = []
    // subFlowId → how many callFlow nodes (across all flows) reference it
    const usage = new Map<string, number>()
    // Collected rather than reported per file: one unreadable directory would otherwise
    // raise a toast per file and blow straight past the 4-deep stack.
    const corrupted: string[] = []

    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = await fs.readFile(join(flowsDir(), file), 'utf-8')
        const flow = JSON.parse(raw) as Flow
        summaries.push({
          id: flow.id,
          name: flow.name,
          description: flow.description,
          updatedAt: flow.updatedAt,
          projectId: flow.projectId,
        })
        for (const node of flow.nodes ?? []) {
          if (isCallFlowAction(node.action)) {
            const subId = node.action.subFlowId
            usage.set(subId, (usage.get(subId) ?? 0) + 1)
          }
        }
      } catch (err) {
        corrupted.push(`${file} — ${describeError(err)}`)
      }
    }

    if (corrupted.length) {
      reportToUser(
        `有 ${corrupted.length} 個流程檔案無法讀取，已跳過`,
        `${corrupted.join('\n')}\n\n這些流程不會出現在清單中。`,
      )
    }

    return summaries
      .map((s) => ({ ...s, refCount: usage.get(s.id) ?? 0 }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  static async delete(flowId: string): Promise<void> {
    try {
      await fs.unlink(FlowStorage.filePath(flowId))
    } catch (err) {
      // Already gone is the outcome we wanted. Anything else has to be reported: the
      // renderer drops the row either way, so a failed unlink used to mean the flow
      // reappeared out of nowhere on the next reload.
      if (!isNotFound(err)) {
        reportToUser(`流程檔案刪除失敗：${flowId}.json`, describeError(err))
      }
    }
  }
}
