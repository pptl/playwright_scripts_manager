import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { Project } from '../../shared/types'

function projectsDir(): string {
  return app.isPackaged
    ? join(app.getPath('userData'), 'projects')
    : join(process.cwd(), 'projects')
}

export class ProjectStorage {
  static async ensureDir(): Promise<void> {
    await fs.mkdir(projectsDir(), { recursive: true })
  }

  static filePath(projectId: string): string {
    return join(projectsDir(), `${projectId}.json`)
  }

  static async save(project: Project): Promise<void> {
    await ProjectStorage.ensureDir()
    project.updatedAt = new Date().toISOString()
    await fs.writeFile(ProjectStorage.filePath(project.id), JSON.stringify(project, null, 2), 'utf-8')
  }

  static async load(projectId: string): Promise<Project | null> {
    try {
      const raw = await fs.readFile(ProjectStorage.filePath(projectId), 'utf-8')
      return JSON.parse(raw) as Project
    } catch {
      return null
    }
  }

  static async list(): Promise<Pick<Project, 'id' | 'name' | 'updatedAt'>[]> {
    await ProjectStorage.ensureDir()
    const files = await fs.readdir(projectsDir())
    const results: Pick<Project, 'id' | 'name' | 'updatedAt'>[] = []

    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = await fs.readFile(join(projectsDir(), file), 'utf-8')
        const project = JSON.parse(raw) as Project
        results.push({ id: project.id, name: project.name, updatedAt: project.updatedAt })
      } catch {
        // skip corrupted files
      }
    }

    return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  static async delete(projectId: string): Promise<void> {
    try {
      await fs.unlink(ProjectStorage.filePath(projectId))
    } catch {
      // ignore
    }
  }
}
