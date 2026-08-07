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
    await ProjectStorage.writeAtomic(DEFAULT_PROJECT_ID, project)
  }

  static async save(project: Project): Promise<void> {
    await ProjectStorage.ensureDir()
    project.updatedAt = new Date().toISOString()
    await ProjectStorage.writeAtomic(project.id, project)
  }

  private static async writeAtomic(projectId: string, project: Project): Promise<void> {
    const filePath = ProjectStorage.filePath(projectId)
    const tmpPath = `${filePath}.tmp`
    await fs.writeFile(tmpPath, JSON.stringify(project, null, 2), 'utf-8')
    await fs.rename(tmpPath, filePath)
  }

  static async load(projectId: string): Promise<Project | null> {
    if (projectId === DEFAULT_PROJECT_ID) {
      // Guarantee the reserved default project (with its DEV env + domain) exists before loading.
      await ProjectStorage.ensureDefault()
    }
    try {
      const raw = await fs.readFile(ProjectStorage.filePath(projectId), 'utf-8')
      return JSON.parse(raw) as Project
    } catch {
      return null
    }
  }

  static async list(): Promise<Pick<Project, 'id' | 'name' | 'updatedAt'>[]> {
    await ProjectStorage.ensureDefault()
    const files = await fs.readdir(projectsDir())
    const results: Pick<Project, 'id' | 'name' | 'updatedAt'>[] = []

    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = await fs.readFile(join(projectsDir(), file), 'utf-8')
        const project = JSON.parse(raw) as Project
        results.push({ id: project.id, name: project.name, updatedAt: project.updatedAt })
      } catch (err) {
        console.error(`[ProjectStorage] Skipping corrupted project file: ${file}`, err)
      }
    }

    results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return results
  }

  static async delete(projectId: string): Promise<void> {
    // The reserved default project can never be deleted.
    if (projectId === DEFAULT_PROJECT_ID) return
    try {
      await fs.unlink(ProjectStorage.filePath(projectId))
    } catch {
      // ignore
    }
  }
}
