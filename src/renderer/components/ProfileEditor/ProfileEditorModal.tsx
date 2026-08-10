import { useState } from 'react'
import { useFlowStore } from '../../stores/flowStore'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { ProfileList } from './ProfileList'
import { ProfileVarTable } from './ProfileVarTable'
import { token } from '../../styles/tokens'

interface ProfileEditorModalProps {
  onClose: () => void
}

/**
 * 環境配置管理 — the shell around two columns: the profile list and the selected
 * profile's variable table (which in turn carries the project env-var picker).
 *
 * The only state here is which profile is selected; everything else belongs to the
 * column that owns it.
 */
export function ProfileEditorModal({ onClose }: ProfileEditorModalProps) {
  const { currentFlow, activeProfileId } = useFlowStore()

  const profiles = currentFlow?.profiles ?? []
  const [selectedProfileId, setSelectedProfileId] = useState<string>(
    () => activeProfileId ?? profiles[0]?.id ?? '',
  )
  const selectedProfile = profiles.find((p) => p.id === selectedProfileId) ?? profiles[0] ?? null

  return (
    <Modal
      variant="panel"
      title="環境配置管理"
      width={960}
      onClose={onClose}
      // A backdrop click here would silently discard an in-progress variable table
      // (there is deliberately no dirty tracking — see CLAUDE.md), and Escape is
      // already taken by the env-var popover's own handler.
      closeOnBackdrop={false}
      closeOnEscape={false}
      bodyStyle={{ overflow: 'hidden' }}
      footer={
        <Button onClick={onClose} size="md">
          關閉
        </Button>
      }
    >
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
        <ProfileList
          profiles={profiles}
          activeProfileId={activeProfileId}
          selectedProfileId={selectedProfileId}
          onSelect={setSelectedProfileId}
        />

        {selectedProfile ? (
          // Keyed on the profile: switching remounts the table, which drops the caret map
          // and the unsaved draft in one move. Reloading is deliberate and silent — the
          // editing model has no dirty tracking.
          <ProfileVarTable key={selectedProfile.id} profile={selectedProfile} onClose={onClose} />
        ) : (
          <div style={{ flex: 1, padding: 24, color: token.textMuted, fontSize: 13 }}>
            請從左側選擇或建立一個配置。
          </div>
        )}
      </div>
    </Modal>
  )
}
