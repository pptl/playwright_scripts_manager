import { useEffect } from 'react'
import { useFlowStore } from '../stores/flowStore'

/**
 * Registers global keyboard shortcuts for flow undo/redo:
 *   Ctrl/Cmd+Z       → undo
 *   Ctrl/Cmd+Shift+Z → redo
 *
 * Ignores keystrokes while focus is in an editable field so it doesn't hijack
 * normal text editing, and bails during recording/replay.
 */
export function useUndoRedo() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key.toLowerCase() !== 'z') return

      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return
      }

      const { isRecording, isReplaying, undo, redo } = useFlowStore.getState()
      if (isRecording || isReplaying) return

      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
}
