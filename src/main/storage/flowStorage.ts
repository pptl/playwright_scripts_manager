import { promises as fs } from 'fs'
import { join } from 'path'
import type { Flow, FlowListItem } from '../../shared/types'
import { isCallFlowAction } from '../../shared/types'
import { getWorkspaceRoot } from './workspace'
import { writeJsonAtomic } from './atomicWrite'
import { readJsonDir } from './readJsonDir'
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

  /** Every flow file on disk, readable or not. `list()` deliberately skips what it cannot
   *  parse; a caller that must account for EVERY file (security/recrypt.ts) needs to see
   *  those too, so it can refuse rather than silently leave one behind. */
  static async allFilePaths(): Promise<string[]> {
    await FlowStorage.ensureDir()
    const files = await fs.readdir(flowsDir())
    return files.filter((f) => f.endsWith('.json')).map((f) => join(flowsDir(), f))
  }

  /**
   * `touch: false` writes without bumping updatedAt. Used by the debounced save
   * behind node dragging: repositioning is not a content change, and stamping a
   * new timestamp on every drag makes the flow's JSON conflict in git for what
   * is really just a cosmetic move.
   *
   * Returns the `updatedAt` that actually landed on disk. That return trip is not
   * cosmetic: this stamp is applied to main's own deserialized copy, which never
   * travels back on its own, so the renderer's in-memory `updatedAt` is always a
   * few milliseconds behind after a touch:true write. `persistence.ts` records what
   * comes back, and the focus reload compares against it — without this, "is the disk
   * copy newer than mine" was true after every single local edit.
   */
  static async save(flow: Flow, opts?: { touch?: boolean }): Promise<string> {
    await FlowStorage.ensureDir()
    if (opts?.touch !== false) flow.updatedAt = new Date().toISOString()
    await writeJsonAtomic(FlowStorage.filePath(flow.id), flow)
    return flow.updatedAt
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

    await readJsonDir<Flow>(
      flowsDir(),
      files,
      (flow) => {
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
      },
      (corrupted) => reportToUser(
        `有 ${corrupted.length} 個流程檔案無法讀取，已跳過`,
        `${corrupted.join('\n')}\n\n這些流程不會出現在清單中。`,
      ),
    )

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

  /** Whether adding candidateSubFlowId as a sub-flow of startFlowId would create a cycle —
   *  recursively walks the candidate's own callFlow graph looking for a path back to start. */
  static async hasCallFlowCycle(
    startFlowId: string,
    candidateSubFlowId: string,
    visited = new Set<string>(),
  ): Promise<boolean> {
    if (candidateSubFlowId === startFlowId) return true
    if (visited.has(candidateSubFlowId)) return false
    visited.add(candidateSubFlowId)

    const subFlow = await FlowStorage.load(candidateSubFlowId)
    if (!subFlow) return false

    const nestedCallIds = subFlow.nodes
      .filter((n) => isCallFlowAction(n.action))
      .map((n) => n.action.subFlowId!)

    for (const nestedId of nestedCallIds) {
      if (await FlowStorage.hasCallFlowCycle(startFlowId, nestedId, visited)) return true
    }
    return false
  }
}
