import { promises as fs } from 'fs'
import { join } from 'path'
import type { Flow, FlowListItem } from '../../shared/types'
import { isCallFlowAction } from '../../shared/types'
import { getWorkspaceRoot } from './workspace'

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
    await fs.writeFile(FlowStorage.filePath(flow.id), JSON.stringify(flow, null, 2), 'utf-8')
  }

  static async load(flowId: string): Promise<Flow | null> {
    try {
      const raw = await fs.readFile(FlowStorage.filePath(flowId), 'utf-8')
      return JSON.parse(raw) as Flow
    } catch {
      return null
    }
  }

  static async list(): Promise<FlowListItem[]> {
    await FlowStorage.ensureDir()
    const files = await fs.readdir(flowsDir())
    const summaries: Omit<FlowListItem, 'refCount'>[] = []
    // subFlowId → how many callFlow nodes (across all flows) reference it
    const usage = new Map<string, number>()

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
      } catch {
        // skip corrupted files
      }
    }

    return summaries
      .map((s) => ({ ...s, refCount: usage.get(s.id) ?? 0 }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  static async delete(flowId: string): Promise<void> {
    try {
      await fs.unlink(FlowStorage.filePath(flowId))
    } catch {
      // ignore
    }
  }
}
