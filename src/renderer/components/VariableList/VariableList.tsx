import { BUILT_IN_VARIABLES } from '@shared/variableResolver'
import { SidebarSection } from '../common/SidebarSection'
import { useCopyBadge } from '../../hooks/useCopyBadge'

export function VariableList() {
  const { copied, copy } = useCopyBadge()

  return (
    <SidebarSection title="全域變數" bordered={false}>
      {BUILT_IN_VARIABLES.map((v) => (
        <div
          key={v.name}
          onClick={() => copy(v.placeholder, v.name)}
          title={`點擊複製 ${v.placeholder}`}
          style={{
            padding: '8px 14px',
            cursor: 'pointer',
            borderBottom: '1px solid #0f172a',
            userSelect: 'none',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <code
              style={{
                fontSize: 11,
                background: '#0f172a',
                color: '#7dd3fc',
                padding: '1px 5px',
                borderRadius: 3,
                border: '1px solid #1e40af',
              }}
            >
              {v.placeholder}
            </code>
            {copied === v.name && (
              <span style={{ fontSize: 10, color: '#4ade80' }}>已複製</span>
            )}
          </div>
          <div style={{ fontSize: 10, color: '#64748b' }}>{v.description}</div>
          <div style={{ fontSize: 10, color: '#475569', marginTop: 1 }}>
            例：{v.example}
          </div>
        </div>
      ))}
    </SidebarSection>
  )
}
