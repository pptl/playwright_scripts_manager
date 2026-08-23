import { useFlowStore } from '../../stores/flowStore'
import { useProjectStore } from '../../stores/projectStore'
import { flattenProjectEnvVars, resolveValue, hasVariables } from '../../../shared/variableResolver'
import { SecretValue } from '../common/SecretValue'
import { SidebarSection } from '../common/SidebarSection'
import { useCopyBadge } from '../../hooks/useCopyBadge'

export function ProfileVarList() {
  const { currentFlow, activeProfileId } = useFlowStore()
  const { activeEnvironmentId, currentProject } = useProjectStore()
  const { copied, copy } = useCopyBadge()

  const profiles = currentFlow?.profiles ?? []
  const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? profiles[0] ?? null
  const envVars = flattenProjectEnvVars(currentProject?.envVars, activeEnvironmentId)

  return (
    <SidebarSection
      title={
        <>
          <span>環境變數</span>
          {activeProfile && (
            <span
              style={{
                fontSize: 11,
                padding: '2px 6px',
                borderRadius: 3,
                background: '#78350f',
                color: '#fcd34d',
                fontWeight: 600,
                textTransform: 'none',
                letterSpacing: 0,
              }}
            >
              {activeProfile.name}
            </span>
          )}
        </>
      }
    >
      {!activeProfile || activeProfile.vars.length === 0 ? (
        <div style={{ padding: '12px 14px', color: '#64748b', fontSize: 12 }}>
          {activeProfile ? '此配置尚無變數。' : '尚無環境配置。'}
        </div>
      ) : (
        activeProfile.vars.map((v) => {
          const placeholder = `{{${v.key}}}`
          const rawValue = (activeEnvironmentId && v.envValues?.[activeEnvironmentId]) ?? v.value
          // A private value is ciphertext here; resolving it would be meaningless, and it
          // must stay masked until the user explicitly reveals it.
          const referencesEnvVar = !v.secret && hasVariables(rawValue)
          const resolvedValue = v.secret ? rawValue : resolveValue(rawValue, { envVars })
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
                ;(e.currentTarget as HTMLDivElement).style.background = '#1c1408'
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
                    color: '#fcd34d',
                    padding: '1px 5px',
                    borderRadius: 3,
                    border: '1px solid #78350f',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {placeholder}
                </code>
                {referencesEnvVar && (
                  <span
                    title="引用專案環境變數"
                    style={{ fontSize: 10, color: '#4ade80', flexShrink: 0 }}
                  >
                    🌐
                  </span>
                )}
                {v.secret && (
                  <span
                    title="私密資料（加密儲存）"
                    style={{ fontSize: 10, flexShrink: 0 }}
                  >
                    🔐
                  </span>
                )}
                {copied === v.key && (
                  <span style={{ fontSize: 10, color: '#4ade80', flexShrink: 0 }}>已複製</span>
                )}
              </div>
              {v.description && (
                <div
                  style={{
                    fontSize: 10,
                    color: '#94a3b8',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    marginBottom: 1,
                  }}
                >
                  {v.description}
                </div>
              )}
              {resolvedValue && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    fontSize: 10,
                    color: '#78716c',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <SecretValue value={resolvedValue} secret={v.secret} />
                </div>
              )}
            </div>
          )
        })
      )}
    </SidebarSection>
  )
}
