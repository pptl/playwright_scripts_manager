import React from 'react'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { VaultModal } from './VaultModal'

/**
 * Renders the vault dialog wherever it was requested from — mounted once in App.tsx so
 * that a blocked replay or export can raise it without every call site owning a modal.
 */
export function VaultHost() {
  const dialog = useWorkspaceStore((s) => s.vaultDialog)
  const close = useWorkspaceStore((s) => s.closeVaultDialog)

  if (!dialog) return null
  return <VaultModal mode={dialog.mode} reason={dialog.reason} onClose={close} />
}
