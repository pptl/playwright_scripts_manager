import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import type { Project } from '../../shared/types'
import {
  DEFAULT_PROJECT_ID,
  DEFAULT_PROJECT_NAME,
  DEFAULT_ENV_NAME,
  DEFAULT_DOMAIN,
  DOMAIN_ENV_KEY,
} from '../../shared/types'
import { getWorkspaceRoot } from './workspace'
import { writeJsonAtomic } from './atomicWrite'
import { readJsonDir } from './readJsonDir'
import { reportToUser, describeError, isNotFound } from '../errorChannel'

function projectsDir(): string {
  return join(getWorkspaceRoot(), 'projects')
}

export class ProjectStorage {
  static async ensureDir(): Promise<void> {
    await fs.mkdir(projectsDir(), { recursive: true })
  }

  static filePath(projectId: string): string {
    return join(projectsDir(), `${projectId}.json`)
  }

  /** Mirror of `FlowStorage.allFilePaths` — every project file, including ones `list()`
   *  would skip as unparseable. See the note there. */
  static async allFilePaths(): Promise<string[]> {
    await ProjectStorage.ensureDir()
    const files = await fs.readdir(projectsDir())
    return files.filter((f) => f.endsWith('.json')).map((f) => join(projectsDir(), f))
  }

  /** Materialize the reserved default project ("未分類") on disk if it doesn't exist yet,
   *  seeded with a DEV environment and a fixed `domain` env var. Writing it to a file (rather
   *  than returning a synthetic object) gives its environment a stable id across loads. */
  static async ensureDefault(): Promise<void> {
    await ProjectStorage.ensureDir()
    try {
      await fs.access(ProjectStorage.filePath(DEFAULT_PROJECT_ID))
      return // already exists
    } catch {
      // doesn't exist — create it
    }
    const envId = randomUUID()
    const now = new Date().toISOString()
    const project: Project = {
      id: DEFAULT_PROJECT_ID,
      name: DEFAULT_PROJECT_NAME,
      environments: [{ id: envId, name: DEFAULT_ENV_NAME }],
      envVars: [{ key: DOMAIN_ENV_KEY, values: { [envId]: DEFAULT_DOMAIN } }],
      createdAt: now,
      updatedAt: now,
    }
    await writeJsonAtomic(ProjectStorage.filePath(DEFAULT_PROJECT_ID), project)
  }

  static async save(project: Project): Promise<void> {
    await ProjectStorage.ensureDir()
    project.updatedAt = new Date().toISOString()
    await writeJsonAtomic(ProjectStorage.filePath(project.id), project)
  }

  static async load(projectId: string): Promise<Project | null> {
    if (projectId === DEFAULT_PROJECT_ID) {
      // Guarantee the reserved default project (with its DEV env + domain) exists before loading.
      await ProjectStorage.ensureDefault()
    }
    try {
      const raw = await fs.readFile(ProjectStorage.filePath(projectId), 'utf-8')
      return JSON.parse(raw) as Project
    } catch (err) {
      // Mirrors FlowStorage.load: "not there" is normal, "unreadable" is not.
      if (!isNotFound(err)) {
        reportToUser(`專案檔案無法讀取：${projectId}.json`, describeError(err))
      }
      return null
    }
  }

  static async list(): Promise<Pick<Project, 'id' | 'name' | 'updatedAt'>[]> {
    await ProjectStorage.ensureDefault()
    const files = await fs.readdir(projectsDir())
    const results: Pick<Project, 'id' | 'name' | 'updatedAt'>[] = []

    await readJsonDir<Project>(
      projectsDir(),
      files,
      (project) => results.push({ id: project.id, name: project.name, updatedAt: project.updatedAt }),
      (corrupted) => reportToUser(
        `有 ${corrupted.length} 個專案檔案無法讀取，已跳過`,
        `${corrupted.join('\n')}\n\n這些專案底下的流程會歸到「未分類」。`,
      ),
    )

    results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return results
  }

  static async delete(projectId: string): Promise<void> {
    // The reserved default project can never be deleted.
    if (projectId === DEFAULT_PROJECT_ID) return
    try {
      await fs.unlink(ProjectStorage.filePath(projectId))
    } catch (err) {
      // Already gone is fine; anything else means the row comes back on the next reload.
      if (!isNotFound(err)) {
        reportToUser(`專案檔案刪除失敗：${projectId}.json`, describeError(err))
      }
    }
  }
}
