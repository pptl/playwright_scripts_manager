import { useState } from 'react'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { Input } from '../common/Input'

interface GroupNameModalProps {
  selectedCount: number
  onConfirm: (name: string) => void
  onClose: () => void
}

/** Small dialog to name a new in-place group (Electron disables window.prompt). */
export function GroupNameModal({ selectedCount, onConfirm, onClose }: GroupNameModalProps) {
  const [name, setName] = useState('群組')

  const confirm = () => {
    onConfirm(name.trim() || '群組')
  }

  return (
    <Modal
      title="組成群組"
      subtitle={`將選取的 ${selectedCount} 個節點折疊為一個群組`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button tone="primaryAlt" onClick={confirm}>
            建立
          </Button>
        </>
      }
    >
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') confirm()
        }}
        placeholder="群組名稱"
      />
    </Modal>
  )
}
