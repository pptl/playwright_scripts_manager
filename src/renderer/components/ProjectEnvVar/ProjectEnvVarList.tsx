import { useFlowStore } from '../../stores/flowStore'
import { useProjectStore } from '../../stores/projectStore'
import { SecretValue } from '../common/SecretValue'
import { SidebarSection } from '../common/SidebarSection'
import { useCopyBadge } from '../../hooks/useCopyBadge'

/** Sidebar list of the current project's environment variables, showing each
 *  key with its value for the active environment. Click a row to copy {{key}}. */
export function ProjectEnvVarList() {
  const currentFlow = useFlowStore((s) => s.currentFlow)
  const { currentProject, activeEnvironmentId } = useProjectStore()
  const { copied, copy } = useCopyBadge()

  if (!currentFlow?.projectId || currentFlow.projectId !== currentProject?.id) return null

  const envVars = currentProject.envVars ?? []
  const activeEnv = currentProject.environments.find((e) => e.id === activeEnvironmentId) ?? null

  return (
    <SidebarSection
      title={
        <>
          <span>🌐 專案環境變數</span>
          {activeEnv && (
            <span
              style={{
                fontSize: 11,
                padding: '2px 6px',
                borderRadius: 3,
                background: '#14532d',
                color: '#4ade80',
                fontWeight: 600,
                textTransform: 'none',
                letterSpacing: 0,
              }}
            >
              {activeEnv.name}
            </span>
          )}
        </>
      }
    >
      {envVars.length === 0 ? (
        <div style={{ padding: '12px 14px', color: '#64748b', fontSize: 12 }}>
          尚無專案環境變數。
        </div>
      ) : (
        envVars.map((v) => {
          const placeholder = `{{${v.key}}}`
          const value = (activeEnvironmentId && v.values[activeEnvironmentId]) ?? ''
          return (
            <div
              key={v.key}
              onClick={() => copy(placeholder, v.key)}
              title={`點擊複製 ${placeholder}`}
              style={{
                padding: '7px 14px',
                cursor: 'pointer',
                borderBottom: '1px solid #0f172a',
                userSelect: 'none',
              }}
              onMouseEnter={(e) => {
                ;(e.currentTarget as HTMLDivElement).style.background = '#08140c'
              }}
              onMouseLeave={(e) => {
                ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                <code
                  style={{
                    fontSize: 11,
                    background: '#0f172a',
                    color: '#4ade80',
                    padding: '1px 5px',
                    borderRadius: 3,
                    border: '1px solid #166534',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {placeholder}
                </code>
                {v.secret && (
                  <span title="私密資料（加密儲存）" style={{ fontSize: 10, flexShrink: 0 }}>
                    🔐
                  </span>
                )}
                {copied === v.key && (
                  <span style={{ fontSize: 10, color: '#4ade80', flexShrink: 0 }}>已複製</span>
                )}
              </div>
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  fontSize: 10,
                  color: value ? '#78716c' : '#475569',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                <SecretValue value={value} secret={v.secret} />
              </div>
            </div>
          )
        })
      )}
    </SidebarSection>
  )
}
