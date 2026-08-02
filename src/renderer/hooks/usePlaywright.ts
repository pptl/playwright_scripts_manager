import { useCallback } from 'react'
import { useFlowStore } from '../stores/flowStore'
import type { Flow } from '@shared/types'
import { DOMAIN_ENV_KEY } from '@shared/types'
import { buildProfileVars as buildVars, getEnvVars, getSecretEnvKeys } from '../utils/varMaps'
import { useWorkspaceStore } from '../stores/workspaceStore'

/**
 * Refuse anything that would drive a real browser while private values are unreadable,
 * and raise the unlock dialog. Blanket rather than "only when a secret is involved" —
 * failing loudly beats silently typing `enc:v1:…` into a login form.
 */
function blockedByLock(reason: string): boolean {
  const { vault, openVaultDialog } = useWorkspaceStore.getState()
  if (!vault || vault.state !== 'locked') return false
  openVaultDialog('unlock', reason)
  return true
}

function buildProfileVars(
  flow: Flow | null,
  activeProfileId: string | null,
  activeEnvironmentId: string | null,
  envVars: Record<string, string>,
  secretEnvKeys: string[],
): Record<string, string> | undefined {
  return buildVars(
    flow?.profiles?.find((p) => p.id === activeProfileId),
    activeEnvironmentId,
    envVars,
    secretEnvKeys,
  )
}

/**
 * Returns action functions for controlling Playwright (record / replay).
 * Does NOT set up IPC subscriptions — use usePlaywrightEvents in App.tsx for that.
 */
export function usePlaywright() {
  const { setIsRecording, setIsReplaying, clearReplayStatus } = useFlowStore()

  const startRecording = useCallback(async () => {
    const { currentFlow: flow, currentProject, activeEnvironmentId } = useFlowStore.getState()
    if (!flow) return
    // The recording origin is the active environment's `domain` env var (falling back to the
    // flow's existing baseURL). Persist it as baseURL so replay/export origin substitution
    // matches the origin recorded against.
    const domain = getEnvVars(currentProject, activeEnvironmentId)[DOMAIN_ENV_KEY] || flow.baseURL
    setIsRecording(true)
    try {
      await window.electronAPI.startRecording({ baseURL: domain })
      if (domain && domain !== flow.baseURL) {
        const updated: Flow = { ...flow, baseURL: domain }
        useFlowStore.setState({ currentFlow: updated })
        await window.electronAPI.saveFlow(updated).catch(console.error)
      }
    } catch (err) {
      setIsRecording(false)
      console.error('Failed to start recording:', err)
    }
  }, [setIsRecording])

  const startBranchRecording = useCallback(
    async (fromNodeId: string) => {
      const { currentFlow, activeProfileId, activeEnvironmentId, currentProject } = useFlowStore.getState()
      if (!currentFlow) return
      // Branch recording silently replays to the branch point first, which may type
      // private values into the page.
      if (blockedByLock('分支錄製會先重播到該節點，需要讀取私密資料。請先解鎖。')) return
      // Set recording head so new actions append as children of this node
      useFlowStore.getState().setRecordingHead(fromNodeId)
      setIsRecording(true)

      const envVars = getEnvVars(currentProject, activeEnvironmentId)
      const profileVars = buildProfileVars(currentFlow, activeProfileId, activeEnvironmentId, envVars, getSecretEnvKeys(currentProject))

      try {
        await window.electronAPI.startRecording({
          baseURL: currentFlow.baseURL,
          branchFromNodeId: fromNodeId,
          branchNodes: currentFlow.nodes,
          replaySpeed: 200,
          profileVars,
          activeProfileId: activeProfileId ?? undefined,
          activeEnvironmentId: activeEnvironmentId ?? undefined,
          envVars,
          activeProjectId: currentProject?.id,
        })
      } catch (err) {
        setIsRecording(false)
        useFlowStore.getState().setRecordingHead(null)
        console.error('Failed to start branch recording:', err)
      }
    },
    [setIsRecording],
  )

  const stopRecording = useCallback(async () => {
    try {
      await window.electronAPI.stopRecording()
    } catch (err) {
      console.error('Failed to stop recording:', err)
    } finally {
      setIsRecording(false)
      useFlowStore.getState().setRecordingHead(null)
      const flow = useFlowStore.getState().currentFlow
      if (flow) await window.electronAPI.saveFlow(flow).catch(console.error)
    }
  }, [setIsRecording])

  const replayToNode = useCallback(
    async (targetNodeId: string, speed: number) => {
      const { currentFlow, activeProfileId, activeEnvironmentId, currentProject } = useFlowStore.getState()
      if (!currentFlow) return
      if (blockedByLock('重播需要讀取私密資料，請先解鎖。')) return
      clearReplayStatus()
      setIsReplaying(true)

      const envVars = getEnvVars(currentProject, activeEnvironmentId)
      const profileVars = buildProfileVars(currentFlow, activeProfileId, activeEnvironmentId, envVars, getSecretEnvKeys(currentProject))

      try {
        await window.electronAPI.replayToNode(
          currentFlow.nodes,
          targetNodeId,
          speed,
          currentFlow.baseURL,
          profileVars,
          activeProfileId ?? undefined,
          activeEnvironmentId ?? undefined,
          envVars,
          currentProject?.id,
        )
      } catch (err) {
        console.error('Replay IPC error:', err)
      } finally {
        setIsReplaying(false)
      }
    },
    [clearReplayStatus, setIsReplaying],
  )

  return { startRecording, startBranchRecording, stopRecording, replayToNode }
}
