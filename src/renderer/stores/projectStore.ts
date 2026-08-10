import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { Project, ProjectEnvironment } from '@shared/types'
import { DEFAULT_ENV_NAME, DEFAULT_DOMAIN, DOMAIN_ENV_KEY } from '@shared/types'
import { persistProject } from './persistence'

/**
 * Projects, their environments, and project-level environment variables.
 *
 * Kept out of flowStore for the same reason workspaceStore is: a project outlives every
 * flow opened under it. It is also structurally un-undoable — flowStore's history holds
 * `Flow[]` snapshots, so nothing here could ever enter it. That is why there is no
 * `setSilently` and no suppression counter in this file: there is no history to suppress.
 *
 * This store never reads or writes a `Flow` and never imports flowStore. Sequences that
 * span both domains — opening a flow and loading its project, deleting or duplicating a
 * project together with its flows — live in `hooks/useFlowManager.ts`.
 */
interface ProjectStore {
  /** Sidebar summaries. The full record is loaded only for `currentProject`. */
  projects: Pick<Project, 'id' | 'name' | 'updatedAt'>[]
  currentProject: Project | null
  /** Active environment of `currentProject`; null = use profile var fallback values. */
  activeEnvironmentId: string | null

  setProjects: (projects: ProjectStore['projects']) => void
  refreshProjects: () => Promise<void>
  /** The project and its active environment in ONE write — there is no moment where the
   *  two are meaningfully apart, and writing them separately leaves a transient pairing of
   *  a new project with the previous project's environment id. */
  setProjectContext: (project: Project | null, envId: string | null) => void
  setActiveEnvironment: (envId: string | null) => void
  /** Drop everything (workspace switch). A single set(), so no half-cleared state renders. */
  reset: () => void

  createProject: (name: string, envName?: string, domain?: string) => Promise<Project>
  renameProject: (projectId: string, name: string) => Promise<void>
  /** Copies the project RECORD only — its flows are copied by
   *  `useFlowManager.duplicateProjectWithFlows`, which owns all flow-graph knowledge. */
  duplicateProject: (projectId: string) => Promise<Project | null>
  /** Deletes the project RECORD only — its flows are deleted by
   *  `useFlowManager.deleteProjectWithFlows`. */
  deleteProject: (projectId: string) => Promise<void>

  addEnvironmentToProject: (name: string) => Promise<void>
  renameEnvironment: (envId: string, name: string) => Promise<void>
  duplicateEnvironment: (envId: string) => Promise<void>
  deleteEnvironment: (envId: string) => Promise<void>
  /** Atomic whole-table write of the active environment's project env vars. */
  commitProjectEnvVars: (
    rows: { origKey: string | null; key: string; value: string; secret?: boolean }[],
    envId: string,
  ) => Promise<void>
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  currentProject: null,
  activeEnvironmentId: null,

  setProjects: (projects) => set({ projects }),

  refreshProjects: async () => {
    set({ projects: await window.electronAPI.listProjects() })
  },

  setProjectContext: (project, envId) =>
    set({ currentProject: project, activeEnvironmentId: envId }),

  setActiveEnvironment: (envId) => set({ activeEnvironmentId: envId }),

  reset: () => set({ projects: [], currentProject: null, activeEnvironmentId: null }),

  createProject: async (name, envName = DEFAULT_ENV_NAME, domain = DEFAULT_DOMAIN) => {
    // Every project starts with one environment holding the fixed `domain` env var.
    const env: ProjectEnvironment = { id: uuidv4(), name: envName }
    const project: Project = {
      id: uuidv4(),
      name,
      environments: [env],
      envVars: [{ key: DOMAIN_ENV_KEY, values: { [env.id]: domain } }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await persistProject(project)
    set({ projects: await window.electronAPI.listProjects() })
    return project
  },

  // In-place project mutators set() BEFORE saving so the UI follows the gesture rather than
  // the disk round-trip; persistence is fire-and-forget from the caller's perspective.
  addEnvironmentToProject: async (name) => {
    const project = get().currentProject
    if (!project) return
    const newEnv: ProjectEnvironment = { id: uuidv4(), name }
    const updatedProject: Project = { ...project, environments: [...project.environments, newEnv] }
    set({ currentProject: updatedProject })
    await persistProject(updatedProject)
  },

  renameEnvironment: async (envId, name) => {
    const project = get().currentProject
    if (!project) return
    const updatedProject: Project = {
      ...project,
      environments: project.environments.map((e) => (e.id === envId ? { ...e, name } : e)),
    }
    set({ currentProject: updatedProject })
    await persistProject(updatedProject)
  },

  duplicateEnvironment: async (envId) => {
    const project = get().currentProject
    if (!project) return
    const source = project.environments.find((e) => e.id === envId)
    if (!source) return
    const newEnv: ProjectEnvironment = { id: uuidv4(), name: `${source.name}-副本` }
    const updatedProject: Project = {
      ...project,
      environments: [...project.environments, newEnv],
      // Copy the source environment's value for every env var into the new environment.
      envVars: (project.envVars ?? []).map((v) => ({
        ...v,
        values: { ...v.values, [newEnv.id]: v.values[envId] ?? '' },
      })),
    }
    set({ currentProject: updatedProject, activeEnvironmentId: newEnv.id })
    await persistProject(updatedProject)
  },

  deleteEnvironment: async (envId) => {
    const project = get().currentProject
    if (!project) return
    const updatedProject: Project = {
      ...project,
      environments: project.environments.filter((e) => e.id !== envId),
      // Drop the deleted environment's value from every project env var
      envVars: (project.envVars ?? []).map((v) => {
        const { [envId]: _removed, ...rest } = v.values
        return { ...v, values: rest }
      }),
    }
    const { activeEnvironmentId } = get()
    set({
      currentProject: updatedProject,
      activeEnvironmentId:
        activeEnvironmentId === envId
          ? (updatedProject.environments[0]?.id ?? null)
          : activeEnvironmentId,
    })
    await persistProject(updatedProject)
  },

  deleteProject: async (projectId) => {
    await window.electronAPI.deleteProject(projectId)
    const list = await window.electronAPI.listProjects()
    // Deleting the open project always clears the context — the caller cannot be left
    // pointing at a project that no longer exists on disk.
    const clearing = get().currentProject?.id === projectId
    set({
      projects: list,
      ...(clearing ? { currentProject: null, activeEnvironmentId: null } : {}),
    })
  },

  renameProject: async (projectId, name) => {
    const full = await window.electronAPI.loadProject(projectId)
    if (!full) return
    const updated: Project = { ...full, name, updatedAt: new Date().toISOString() }
    // Update the open project immediately; a project that is NOT open has nothing in
    // memory to update, only the sidebar list refresh below.
    if (get().currentProject?.id === projectId) set({ currentProject: updated })
    await persistProject(updated)
    set({ projects: await window.electronAPI.listProjects() })
  },

  duplicateProject: async (projectId) => {
    const full = await window.electronAPI.loadProject(projectId)
    if (!full) return null
    const now = new Date().toISOString()
    // New project id (else saveProject overwrites the original). Environment ids are
    // kept verbatim so envVars.values maps and flow profile envValues stay aligned.
    const newProject: Project = {
      ...full,
      id: uuidv4(),
      name: `${full.name}-副本`,
      environments: full.environments.map((e) => ({ ...e })),
      envVars: (full.envVars ?? []).map((v) => ({ ...v, values: { ...v.values } })),
      createdAt: now,
      updatedAt: now,
    }
    await persistProject(newProject)
    set({ projects: await window.electronAPI.listProjects() })
    return newProject
  },

  commitProjectEnvVars: async (rows, envId) => {
    const project = get().currentProject
    if (!project) return
    const existing = project.envVars ?? []
    const byKey = new Map(existing.map((v) => [v.key, v]))

    const envVars = rows.map((row) => {
      // Existing row: carry every other environment's value across, keyed by the ORIGINAL key
      // (the draft may have renamed it). New row: start from an empty value map.
      const base = row.origKey !== null ? byKey.get(row.origKey) : undefined
      // `domain` is reserved — its key can never change, and it can never be private:
      // it is baked into goto URLs as a literal at export time.
      const isDomain = base?.key === DOMAIN_ENV_KEY
      const key = isDomain ? DOMAIN_ENV_KEY : row.key
      return {
        ...(base ?? {}),
        key,
        secret: isDomain ? false : !!row.secret,
        values: { ...(base?.values ?? {}), [envId]: row.value },
      }
    })

    const updatedProject: Project = { ...project, envVars }
    set({ currentProject: updatedProject })
    await persistProject(updatedProject)
  },
}))
