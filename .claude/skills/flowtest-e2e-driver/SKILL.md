---
name: flowtest-e2e-driver
description: 這個 skill 應該在需要對 FlowTest（這個 Electron app 本身）做「開真實 app 實機驗證」時使用——例如 CLAUDE.md 或 workDoc/CLEAN_UP_TODO.md 裡標記「尚未實機回歸」的項目、驗證一個 bug 修好了、或需要重現一個難以單靠讀 code 判斷的行為（vault 換通行碼、focus reload、error toast/modal、canvas 拖曳存檔等）。它會用 Playwright 的 `_electron` API 直接驅動編譯後的真實 app（而不是叫使用者手動點來點去），對拋棄式的 scratch workspace 操作，並提供一組可重複使用的輔助函式（launchApp、模擬 focus、拖曳節點、讀 toast、icacls 權限注入等）。當使用者要求「實機測試」「regression 測試」「驗證這個修改在真的 app 裡有沒有用」時應主動使用。
---

# FlowTest 實機驅動測試 skill

用 Playwright 的 `_electron` API 直接開真的 FlowTest app 來驗證行為，取代「叫使用者手動點來點去回報結果」。2026-08-23 建置於 A7/A16（vault 換通行碼）與 A3/A13（error 通道、focus reload）的實機回歸過程中，三組測試現在都收在 `tests/` 下可直接重跑或當範本改寫。

## 何時用這個 skill

- `CLAUDE.md` 或 `workDoc/CLEAN_UP_TODO.md` 裡標記「程式碼已完成，尚未實機回歸」的項目。
- 使用者要求「幫我測試看看真的 app 裡這樣對不對」。
- 修完一個 bug，想在回報「改好了」之前實際跑一次驗證，而不是只憑讀 code 判斷。
- 需要重現一個時序/狀態相關、單靠靜態閱讀很難確認的行為（例如：換通行碼當下 renderer 記憶體裡的舊密文會不會被寫回磁碟）。

**不適合**：純 UI 樣式微調、純類型檢查（那用 `npx tsc --noEmit` 就好）、需要真人肉眼判斷「好不好看」的視覺回歸。

## 檔案結構

```
.claude/skills/flowtest-e2e-driver/
  SKILL.md                              — 本檔案
  lib/driver.js                         — 共用工具庫（見下方 API 一覽）
  tests/
    a7-a16-vault-repassphrase.js        — vault 換通行碼全有或全無 + A16 reload（20 項檢查）
    a3-error-channel.js                 — error channel toast/modal 全套（20 項檢查 + 2 項標記為需人工）
    a13-project-env-focus-reload.js     — focus reload 套用外部修改的 project env var（4 項檢查）
    a14-envvar-popover-outside-click.js — EnvVarPickerPopover 在 modal 內的 outside-click（5 項檢查）
    a12-assert-escape-press.js          — 斷言 dock Escape 取消不應多錄 press（4 項檢查）——
                                           **不用 `_electron`**，見下方獨立說明
```

**`a12-assert-escape-press.js` 是這個目錄裡唯一不驅動 Electron app 本體的測試。** A12 的
bug 活在注入到「被錄製頁面」裡的原始 JS（`getDOMCaptureScript()` /
`getAssertionToolbarScript()`，定義在 `src/main/playwright/captureShared.ts`），跟 Electron
UI 無關；`BrowserController` 沒有暴露 CDP/remote-debugging 通道，`launchApp()` 開的 Electron
app 本體搆不到它另外用 `playwright-core` 開出來的錄製瀏覽器視窗。這支測試改用
`npx tsc`（實際上是直接 `node node_modules/typescript/lib/tsc.js`，避開 Windows shell 對
帶空白路徑的引號問題）把 `captureShared.ts` 獨立編譯成 CommonJS，`require()` 進來後直接在一個
真的（headless）Chromium page 裡執行這兩支注入腳本，重現真實的事件時序（capture phase 監聽器
的註冊順序）。編譯用的暫存檔在 `tests/.a12-scratch/`（已加入 `.gitignore`）。

每支測試都是獨立可執行的 Node 腳本，內建自己的 PASS/FAIL/SKIP 報表，結尾都會呼叫
`driver.assertRealSettingsUntouched()` 驗證沒有動到使用者真正的 `%APPDATA%/flowtest/settings.json`。

## 執行方式（務必照這個流程，踩過的坑都寫在這）

```powershell
cd "C:\Users\Alen Chua\Desktop\project\playwright_scripts_manager"
npm run build            # 只要 src/ 有未編譯進 out/ 的改動就必須先跑，driver 開的是 out/main/index.js
$env:ELECTRON_RUN_AS_NODE = $null
node ".\.claude\skills\flowtest-e2e-driver\tests\<要跑的測試>.js"
```

- **一定要用 PowerShell 工具跑，不要用 Bash** ——這個環境的 Bash 對 `node` 有 tty 相關的怪癖
  （會印 "stdin is not a tty" 然後 exit 1），與這個 skill 無關，純粹是這台機器的環境問題。
- **一定要先清空 `ELECTRON_RUN_AS_NODE`**，否則 `_electron.launch()` 會把子行程當成純 Node 執行，
  出現 `bad option: --remote-debugging-port=0` 這種莫名其妙的錯誤（見 `[[electron-run-as-node-leak]]`
  這個跨專案記憶）。
- **改了 `src/` 底下任何東西都要先 `npm run build`** —— driver 開的是 `package.json#main`
  指到的 `out/main/index.js`，不是即時編譯，舊的 build 不會反映你的改動。
- 測試腳本本身必須放在**這個專案目錄之內**（`.claude/skills/.../tests/` 滿足這個條件）——
  Node 的 `require('playwright')` 是照著「執行的那個檔案自己的路徑」往上找 `node_modules`，
  不是照 `cwd`；丟到專案外的暫存目錄跑會直接 `Cannot find module 'playwright'`。

## 安全模型（每次寫新測試都要遵守）

1. **絕對不要把 `workspaceRoot` 指到使用者真正在用的 workspace**（例如 `esd-flows`）。永遠用
   拋棄式的 scratch 目錄——這裡的測試會刻意毀損檔案、撤銷寫入權限。
2. **每次 `launchApp()` 都要給獨立的 `userDataDir`**。不給的話 Electron 會用真正的
   `app.getPath('userData')`（這台機器上是 `%APPDATA%/flowtest`），裡面存著使用者真正的
   `workspaceRoot`/`recentWorkspaces`/`vaultKeys`。獨立的 `--user-data-dir` 讓整個測試碰不到那個檔案。
3. **收尾一定呼叫 `driver.assertRealSettingsUntouched(before)`**（在跑任何東西之前先
   `driver.readRealSettings()` 存一份快照）。這是低成本的事後檢查，抓到「不小心沒隔離」的錯誤配置。
4. 任何 `denyWrite`/`denyDelete` 都要包在 `try/finally` 裡呼叫對應的 `restoreWrite`/`restoreDelete`，
   否則會在使用者機器上留下一個真的被鎖住寫入權限的資料夾。

## `lib/driver.js` API 一覽

**行程生命週期**
- `launchApp({ workspaceRoot, userDataDir, extraEnv? })` → `{ app, page }` — 開真的 app（見上方安全模型）
- `openWorkspace(page, dir)` — 呼叫 `setWorkspace` 後**一定要 reload**，否則 renderer 的
  `workspaceStore` 不會重新讀（它只在 mount 時讀一次），畫面會卡在 WelcomeScreen
- `simulateFocus(app)` — 觸發 `win.emit('focus')`，不需要真的視窗管理員/真的 alt-tab

**建構測試資料**
- `buildFlow({ name, projectId, profiles, nodes })` — 產生最小可用的 `Flow`；`nodes` 可自訂節點鏈
  （例如塞一個會丟例外的 `code` 節點）。**注意**：`goto` 節點實際導覽用的是 `action.value`，
  不是 `action.url`（`url` 只是顯示用 metadata）——`buildFlow` 已經預設把 `value` 補成 `url`，
  但如果你手動組 `Action` 物件要記得這件事，不然 replay 會導覽到空字串然後報
  `Cannot navigate to invalid URL`
- `saveFlow(page, flow)` — 走 `electronAPI.saveFlow`，跟 UI 的 `persistFlow` 同一條路徑
- `encryptSecret(page, plain)` — vault 要先 unlock 過

**UI 操作**
- `clickRefreshFlowList(page)` / `openFlowByName(page, name, rootNodeId?)`
- `dragNode(page, nodeId, dx, dy)` — 真的滑鼠事件拖曳，會觸發 500ms debounce 的存檔（拖完等 >600ms 再讀檔）

**讀 toast / dialog（這個 app 沒有 test id，全靠 DOM 結構猜）**
- `getToasts(page)` → `[{title, detail}]`；`getToastCount(page)`
- `fixedAncestorZIndex(locator)` — 從任一元素往上爬到最近的 `position:fixed` 祖先，回傳其
  computed z-index（用來驗證 toast 疊在 modal 上面這種 stacking 關係）

**檔案系統快照**
- `snapshotDir(root)` / `diffSnapshots(before, after)` — 用 hash+mtime 比對「這批操作到底動了哪些檔案」

**錯誤注入**
- `corruptJsonFile(path)` — 讓 `JSON.parse` 失敗，但檔案還在（不是刪除）
- `denyWrite(dir)` / `restoreWrite(dir)` — icacls 撤銷該目錄的 WriteData+AppendData。
  **只擋這兩個權限，不要用泛用的 `(W)`** ——實測泛用 `(W)` 在這台機器上連
  `fs.statSync`/`fs.existsSync` 都會一起壞掉（回報「不存在」而不是報錯/拒絕），會讓
  `workspace.ts` 的 `isDirectory()` 誤判，測試會悄悄走錯分支。細節寫在 `driver.js` 的
  `denyWrite` 註解裡
- `denyDelete(filePath)` / `restoreDelete(filePath)` — **已知不可靠**：Windows 的刪除授權是
  「檔案自己的 DELETE 權限」或「父目錄的 delete-child 權限」兩者任一即可，光靠 deny 檔案自己的
  DE 擋不住（父目錄繼承的 Full Control 還是放行）。目前在這台機器/這個帳號上測不出真的刪除失敗，
  A3 測試裡這項標成 SKIP，需要人工驗證

**安全檢查**
- `readRealSettings()` / `assertRealSettingsUntouched(before)`

## 已知未自動化、需要人工確認的行為

- **刪除失敗 toast**（`FlowStorage.delete` 的錯誤路徑）——icacls 擋不住這台機器上的刪除，
  需要換個方式製造真的刪除失敗（例如檔案被另一個程式佔用鎖定），或在非管理員帳號下測。
- **連線被拒 warning**——需要真的連線被拒場景，沒有動到共用瀏覽器安裝的前提下無法決定性重現。
- **undo 歷史在 focus 事件後是否仍在**（A15 殘留疑點的一部分）——renderer 的 Zustand store
  沒有暴露到 `window`，腳本內省不到 undo stack，只能驗證「沒有觸發 reload/沒有寫入磁碟」這個外顯行為。

## 加新測試的建議模式

抄 `tests/a13-project-env-focus-reload.js`（最簡單完整的範例）或
`tests/a3-error-channel.js`（多場景、每個測試獨立開一個 app instance 的範例）：

```js
'use strict'
const path = require('path')
const driver = require('../lib/driver')

const SCRATCH = path.join(require('os').tmpdir(), 'flowtest-<你的測試名>-regression')

;(async () => {
  const before = driver.readRealSettings()
  const workspaceRoot = path.join(SCRATCH, 'ws')
  const userDataDir = path.join(SCRATCH, 'ud')
  driver.rmrf(workspaceRoot); driver.rmrf(userDataDir)

  const { app, page } = await driver.launchApp({ workspaceRoot, userDataDir })
  try {
    await driver.openWorkspace(page, workspaceRoot)
    // ...組資料、操作 UI、斷言...
  } finally {
    await app.close()
  }

  driver.assertRealSettingsUntouched(before)
})()
```

跑之前記得：`npm run build`（如果動過 `src/`）→ 清空 `ELECTRON_RUN_AS_NODE` → 用 PowerShell 工具跑。
