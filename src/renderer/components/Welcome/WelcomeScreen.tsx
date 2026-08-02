import React, { useState } from 'react'
import { useWorkspace } from '../../hooks/useWorkspace'

/**
 * Shown until a workspace is chosen. Nothing else may mount before then —
 * every storage call throws without a workspace root.
 *
 * Laid out after VSCode's Get Started page: a Start list, a Recent list, and
 * explanatory cards. The cards carry their weight — "workspace" and the app's
 * own "project" concept are easy to confuse, so the difference is stated here
 * rather than left for the user to infer.
 */
export function WelcomeScreen() {
  const { info, installing, pick, switchTo, forget, installBrowser } = useWorkspace()
  const [dragging, setDragging] = useState(false)

  const recent = info?.recent ?? []
  const needsBrowser = info ? !info.hasChromium : false

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const path = e.dataTransfer.files[0]?.path
    if (path) await switchTo(path)
  }

  return (
    <div
      onDragOver={(e) => {
        // Without this Electron navigates the window to the dropped file.
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: '#0f172a',
        color: '#e2e8f0',
        outline: dragging ? '2px dashed #38bdf8' : 'none',
        outlineOffset: -8,
      }}
    >
      {needsBrowser && (
        <div style={bannerStyle}>
          <span>⚠ 尚未安裝 Chromium 瀏覽器，錄製與執行測試都會失敗。</span>
          <button onClick={installBrowser} disabled={installing} style={installBtnStyle}>
            {installing ? '安裝中…' : '安裝瀏覽器'}
          </button>
        </div>
      )}

      <div style={bodyStyle}>
        <div style={{ flex: '1 1 380px', minWidth: 320 }}>
          <h1 style={{ fontSize: 30, fontWeight: 600, margin: 0 }}>FlowTest</h1>
          <p style={{ color: '#94a3b8', marginTop: 6, marginBottom: 34 }}>
            錄製瀏覽器操作，產生 Playwright 測試
          </p>

          <h2 style={sectionStyle}>開始</h2>
          <button onClick={pick} style={linkStyle}>
            📂 開啟資料夾…
          </button>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4, marginBottom: 30 }}>
            選一個空資料夾即可建立新的工作區
          </div>

          <h2 style={sectionStyle}>最近使用</h2>
          {recent.length === 0 ? (
            <div style={{ fontSize: 12, color: '#64748b' }}>還沒有開啟過任何工作區</div>
          ) : (
            recent.map((w) => (
              <div key={w.path} style={recentRowStyle}>
                <button
                  onClick={() => switchTo(w.path)}
                  title={w.exists ? w.path : `找不到：${w.path}`}
                  style={{
                    ...recentBtnStyle,
                    color: w.exists ? '#e2e8f0' : '#64748b',
                  }}
                >
                  <span style={{ flexShrink: 0 }}>{w.name}</span>
                  <span style={recentPathStyle}>{w.path}</span>
                  {!w.exists && <span style={missingStyle}>找不到</span>}
                </button>
                <button
                  onClick={() => forget(w.path)}
                  title="從清單移除"
                  style={forgetBtnStyle}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>

        <div style={{ flex: '0 1 320px', minWidth: 260, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Card title="什麼是工作區？">
            工作區就是一個資料夾，你的流程、專案設定與上傳檔案都存在裡面。
            把它放進你自己的專案 repo，就能用 git 版控、開 PR、切分支 —— 不同的
            repo 之間也自然互不干擾。
          </Card>
          <Card title="工作區 vs 專案">
            一個工作區可以含多個「專案」。工作區決定檔案存在哪裡；專案負責分組流程，
            並持有環境（DEV / UAT / PRD）與環境變數。
          </Card>
          <Card title="產出物不會進版控">
            工具會在工作區裡放好 .gitignore，把 exports/ 與 .flowtest/ 排除掉，
            不會動到你原本的 .gitignore。
          </Card>
        </div>
      </div>

      <div style={hintStyle}>把資料夾拖曳到這裡也可以開啟</div>
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={cardStyle}>
      <div style={{ fontWeight: 600, marginBottom: 6, color: '#f1f5f9' }}>{title}</div>
      <div style={{ fontSize: 12, lineHeight: 1.7, color: '#94a3b8' }}>{children}</div>
    </div>
  )
}

const bannerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '10px 20px',
  background: '#78350f',
  color: '#fef3c7',
  fontSize: 12,
  flexShrink: 0,
}

const installBtnStyle: React.CSSProperties = {
  background: '#f59e0b',
  color: '#1c1917',
  border: 'none',
  borderRadius: 4,
  padding: '5px 12px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  flexShrink: 0,
}

const bodyStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexWrap: 'wrap',
  gap: 48,
  alignContent: 'center',
  justifyContent: 'center',
  padding: '32px 56px',
  overflowY: 'auto',
}

const sectionStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  color: '#64748b',
  margin: '0 0 10px',
}

const linkStyle: React.CSSProperties = {
  display: 'block',
  background: 'none',
  border: 'none',
  padding: 0,
  color: '#38bdf8',
  fontSize: 14,
  cursor: 'pointer',
  textAlign: 'left',
}

const recentRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
}

const recentBtnStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'baseline',
  gap: 10,
  background: 'none',
  border: 'none',
  padding: '4px 0',
  fontSize: 13,
  cursor: 'pointer',
  textAlign: 'left',
}

const recentPathStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 11,
  color: '#64748b',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  direction: 'rtl', // keep the tail (the folder itself) visible when truncating
  textAlign: 'left',
}

const missingStyle: React.CSSProperties = {
  fontSize: 10,
  color: '#f87171',
  flexShrink: 0,
}

const forgetBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#475569',
  cursor: 'pointer',
  fontSize: 12,
  padding: '2px 6px',
  flexShrink: 0,
}

const cardStyle: React.CSSProperties = {
  background: '#1e293b',
  border: '1px solid #334155',
  borderRadius: 6,
  padding: '14px 16px',
  fontSize: 13,
}

const hintStyle: React.CSSProperties = {
  textAlign: 'center',
  padding: '0 0 22px',
  fontSize: 11,
  color: '#475569',
  flexShrink: 0,
}
