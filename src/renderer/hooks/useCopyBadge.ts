import { useState } from 'react'

/** Copy-to-clipboard with a transient "已複製" badge — the pattern all 4 sidebar
 *  lists duplicated independently (navigator.clipboard.writeText → set copied id →
 *  clear after resetMs). */
export function useCopyBadge(resetMs = 1500) {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (text: string, id: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(id)
      setTimeout(() => setCopied(null), resetMs)
    })
  }
  return { copied, copy }
}
