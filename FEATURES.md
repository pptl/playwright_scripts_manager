# FlowTest — 系統特點與功能總覽

> FlowTest 是一套 **Electron 桌面應用**，把使用者在瀏覽器中的操作錄製成「視覺化分支流程圖」，再一鍵產生可獨立執行的 Playwright `.spec.ts` 測試套件。
>
> 技術堆疊：Electron 30 + React 18 + React Flow 11 + Zustand 4 + playwright-core 1.44 + TypeScript 5（建置：electron-vite / electron-builder）
>
> 文件版本：2026-07-26　對應分支：`develop`

---

## 目錄

1. [核心定位與差異化特點](#1-核心定位與差異化特點)
2. [錄製功能](#2-錄製功能)
3. [重播功能](#3-重播功能)
4. [視覺化流程編輯器](#4-視覺化流程編輯器)
5. [子流程（Sub-flow）系統](#5-子流程sub-flow系統)
6. [變數系統](#6-變數系統)
7. [環境配置（Profile）系統](#7-環境配置profile系統)
8. [專案與環境（Project / Environment）系統](#8-專案與環境projectenvironment系統)
9. [程式碼節點（Code Node）](#9-程式碼節點code-node)
10. [腳本匯出與測試執行](#10-腳本匯出與測試執行)
11. [資料儲存](#11-資料儲存)
12. [使用者介面總覽](#12-使用者介面總覽)
13. [系統架構](#13-系統架構)
14. [功能速查表](#14-功能速查表)

---

## 1. 核心定位與差異化特點

| # | 特點 | 說明 |
|---|------|------|
| **1** | **分支錄製（Branch Recording）** | 本系統最核心的創新。可從流程圖上「任何一個已錄製的節點」開始續錄：系統會靜默重播 root → 該節點，把瀏覽器還原到當時的狀態，再從那裡開始錄新動作。原本要重錄 30 步的另一條測試路徑，現在只需錄 5 步。 |
| **2** | **樹狀分支流程，而非線性腳本** | 一個 Flow 是一棵（可多根）節點樹，每條 root→leaf 路徑即一個測試案例。共用前綴只錄一次，分歧點自然形成多個測試。 |
| **3** | **Playwright 原生等級的 Locator 品質** | 直接從 `playwright-core` 的 `coreBundle.js` 抽出官方 `InjectedScript`，複用其 `generateSelectorSimple` + `asLocator`，因此錄出來的是 `getByRole('button', { name: '登入' })` 這類語意化 locator，而非脆弱的 CSS 路徑。 |
| **4** | **產出的是可獨立執行的標準 Playwright 專案** | 匯出的 `.spec.ts` 不依賴本應用，可直接 `npx playwright test` 執行、可進版控、可接 CI。 |
| **5** | **多層環境抽象** | 「專案環境變數」→「流程環境配置」→「區域（Session）變數」→「內建變數」四層優先序，一次切換 DEV / UAT / PRD 即換掉整組值與網域。 |
| **6** | **子流程可重用與 N 層巢狀** | 登入、選單導覽等共用步驟抽成子流程，被多個測試引用；支援無限層巢狀與逐層的配置對應（Profile Mapping）。 |
| **7** | **錄製時的瀏覽器內互動 UI** | 斷言選取器、Locator 選擇器都直接渲染在「被錄製的瀏覽器」內，不需切回應用視窗，錄製節奏不中斷。 |

---

## 2. 錄製功能

### 2.1 支援錄製的動作類型（共 14 種 ActionType）

| 類型 | 說明 |
|------|------|
| `goto` | 頁面導覽 |
| `click` | 點擊（含左/中/右鍵、修飾鍵組合、**雙擊 dblclick**） |
| `fill` | 文字輸入（含 `contentEditable` 元素） |
| `selectOption` | 下拉選單（支援 multiple 多選，記錄 `values[]`） |
| `check` / `uncheck` | 勾選 / 取消勾選 |
| `press` | 鍵盤按鍵 |
| `upload` | 檔案上傳 |
| `wait` | 等待元素可見 |
| `assertVisible` / `assertText` / `assertValue` | 三種斷言 |
| `callFlow` | 呼叫子流程 |
| `code` | 自訂 Playwright 程式碼區塊 |

### 2.2 智慧事件過濾（對齊官方 codegen 的 `RecordActionTool`）

- **點擊採黑名單策略**：記錄所有點擊，僅排除 `SELECT` / `OPTION` / `INPUT[date|range]` / `html` / `body` 與所有 FlowTest 注入的 UI（id 以 `__ft_` 開頭）。
- **Shadow DOM 穿透**：以 `event.composedPath()[0]` 取真實目標元素。
- **輸入框點擊抑制**：文字框的點擊先暫存，若後續發生 `fill` 就丟棄該點擊，避免產生多餘節點。
- **勾選框轉換**：checkbox / radio 的點擊自動轉為 `check` / `uncheck`。
- **按鍵過濾**：比照 Playwright 的 `_shouldGenerateKeyPressFor` — 只記錄 `Tab`、`Enter`（textarea 外）、`Escape`、方向鍵、功能鍵、修飾鍵組合；略過 `Backspace`、`Delete`、貼上快捷鍵、單獨修飾鍵與無修飾的單一可列印字元。
- **導覽抑制**：點擊 / 輸入 / 按鍵後 5 秒內（`NAV_SUPPRESSION_MS`）發生的導覽不會被重複記成 `goto`，正確處理 redirect 與 SPA 路由。
- **雙擊合併**：單擊先緩衝一小段時間，若隨即出現 `dblclick` 則合併為單一雙擊節點。

### 2.3 多頁面（Popup / 新分頁）錄製

- 監聽 context 的 `page` 事件，新視窗自動配置別名 `page1`、`page2`…（初始頁為空別名）。
- 觸發彈窗的動作會被回填 `opensPage` 欄位；若該動作已送到畫布，透過 `ACTION_UPDATED` 通道**回溯修補**節點。
- 重播時以 `waitForEvent('page')` 等待；匯出時產生官方標準的 `waitForEvent('popup')` 樣板。

### 2.4 iframe 錄製

- 為每個 frame 建立 iframe locator 鏈（外→內），存於 `action.framePath`。
- 無法解析 frame 元素時，降級為 `iframe[name=…]` / `iframe[src=…]`。
- 重播透過 `.contentFrame()` 逐層下鑽；匯出同樣產生 `.contentFrame()` 鏈。

### 2.5 檔案上傳錄製（`fixtures/`）

這是技術上最細膩的一塊：

- **刻意不攔截 file chooser** — 讓 Chromium 開自己的原生對話框（在使用者當前視窗上），而非跳出突兀的 Electron 跨視窗對話框。
- 透過 CDP 的 `Runtime.evaluate` + **`DOM.getFileInfo`** 讀取瀏覽器端的**真實檔案路徑**（頁面 JS 只看得到 `File.name`）。
- 讀到的檔案由 `FixtureStorage.importFile()` **複製進 `fixtures/`**，同名衝突時加上內容雜湊後綴。
- 路徑以**相對於資料根目錄**（`fixtures/cat.jpg`）儲存 → 匯出的 spec 具可攜性。
- **自動移除「開啟檔案選擇器的那個點擊」**：該點擊不可重播（input 被隱藏在樣式化觸發器後），系統會丟棄緩衝中的點擊，或以 `ACTION_REMOVED` 通道通知畫布刪除該節點並回退錄製游標。
- **Locator 帶標籤限定**：這類元件常讓觸發器與隱藏 input 共用同一個 id，故產生 `input#id` 而非裸 `#id`；舊節點在重播時由 `resolveFileInput()` 逐步收斂（`.and(input[type=file])` → 子孫 → 原 locator → 全頁唯一 file input）。
- **拖放上傳**無 chooser 事件，只能取得裸檔名 → 節點顯示紅色 `⚠ 缺少檔案路徑` 徽章，可在屬性面板用「📂 選擇檔案…」補上。

### 2.6 瀏覽器內斷言選取器

錄製期間在被錄製的瀏覽器右側注入一個工具列（dock）：

1. 三顆按鈕：**👁 可見** / **T 文字** / **= 值**
2. 點擊後進入拾取模式：透明遮罩即時高亮游標下的元素，並以 tooltip 顯示其 locator
3. 點擊元素即產生對應斷言節點；按 `Esc` 取消
4. dock 本身的 id 為 `__ft_assert_toolbar`，其點擊已被錄製黑名單排除

### 2.7 瀏覽器內 Locator 選擇器（表格 / 清單）

當點擊落在重複性的表格列或清單項目時，系統會提供兩種 locator 方案並在瀏覽器內彈出「選擇 Locator 方式」對話框：

- **依儲存格內容定位**（Cell by content）— 資料變動時較穩定
- **依列序定位**（Row by nth position）— 位置固定時較穩定

使用者選定後才最終確立該動作的 locator。

---

## 3. 重播功能

- **重播到任一節點**：右鍵節點 →「重播到此節點」。系統沿 `parentId` 往上走到根節點（含循環防護）建立有序路徑，逐步執行。
- **黃色游標高亮**：注入視覺提示點，清楚顯示每一步作用在哪個元素。
- **三段速度**：快 100ms / 正常 500ms / 慢 1000ms（工具列可切換）。
- **即時狀態回饋**：每步發出 `REPLAY_NODE_START` / `REPLAY_NODE_COMPLETE`，畫布節點即時顯示執行中 / 成功 / 失敗邊框。
- **斷言執行**：支援 `text` / `visible` / `url` / `count` 四型，逾時 10 秒。
- **變數即時解析**：重播時所有 `{{...}}` 依「區域 > 配置 > 專案環境 > 內建」優先序解析。
- **網域替換**：goto 的 URL 若 origin 與 `flow.baseURL` 相同，會被換成當前環境的 `domain` 值。
- **子流程遞迴重播**：`executeCallFlow()` 載入子流程、解析其配置、建立巢狀 Replayer，並把子流程捕獲的區域變數回併到父層。
- **多頁面 / iframe 感知**：依 `pageAlias` 選頁、依 `framePath` 下鑽 frame。
- **File chooser 抑制的正確釋放**：重播期間抑制檔案對話框，並在 `finally` 中釋放（避免遺留監聽器導致之後「按上傳沒反應」）。

---

## 4. 視覺化流程編輯器

基於 React Flow，是一個完整的圖形編輯器而不只是檢視器。

### 4.1 版面與佈局

- **自動樹狀佈局**：`computeTreeLayout`（子樹置中演算法）與 `computeAllRootsLayout`（多根並排）。
- **`positionsFinalized` 機制**：節點座標一旦由使用者手動調整（或首次載入時被物化）即成為唯一真實來源，之後不再自動重排。
- **🧹 整理節點**：隨時無條件重新套用自動佈局。
- **拖曳移動**：位置變更以 **debounce 寫入磁碟**，且走 `runWithoutHistory`，不會灌爆 undo 歷史。
- **MiniMap + Controls + 網格背景**。

### 4.2 節點圖編輯

| 操作 | 說明 |
|------|------|
| 拖曳連接 | 拉節點把手建立父子關係（若目標已有父節點則拒絕） |
| 刪除連線 | 移除父子關係 |
| 中斷連線 | 右鍵「中斷連線」— 從父與子雙向脫鉤，各自成為浮動根節點 |
| 刪除節點及子節點 | 連同整個子樹刪除 |
| 僅刪除節點 | 刪除節點但保留子節點（升為浮動根節點） |
| 多重選取 | Shift 框選，驅動群組 / 抽取子流程 / 批次刪除 / 批次斷連 |
| 空白處右鍵 | 「加入節點」— 目前支援新增 **程式碼節點** |
| 分支標籤 | 連線可帶標籤，以自訂 Bezier 邊（`BranchEdge`）顯示徽章 |

### 4.3 視覺群組（Visual Group）

- 把**連續、單一入口單一出口**的節點折疊成畫布上的一個節點。
- **純畫布層概念**：不產生任何獨立 Flow、不進入流程清單、不改變 `parentId`/`childIds` 接線，僅以 `FlowNode.groupId` 記錄成員。
- 支援 建立群組 / 展開收合 / 解散群組；佈局演算法會把展開中的群組視為一個「大節點」保留其完整版面空間。
- 指向已折疊群組的連線會自動導向該群組節點。

### 4.4 復原 / 重做

**復原 / 重做只作用於畫布上的節點操作。**

**適用範圍**

- 新增節點、刪除節點、刪除節點及子樹、多選刪除
- 拖曳連接 / 斷開連線、中斷節點連線
- 建立群組 / 解散群組、一鍵整理版面
- 插入 / 附加子流程呼叫節點、另存為子流程
- 屬性面板（PropertyPanel）按下「儲存」後的節點欄位變更

**不適用範圍（刻意排除）**

| 項目 | 說明 |
|---|---|
| 區域變數（`captureAs`） | 不論是在畫布右鍵設定，或在右側側邊欄🗑刪除，行為一致 |
| 環境配置 | 新增 / 改名 / 刪除 / 建立副本配置檔，以及配置變數表的儲存 |
| 專案環境與環境變數 | 新增 / 改名 / 刪除 / 複製環境，以及環境變數表的儲存 |
| 流程改名、移至專案 | 流程的中繼資料，非節點圖 |

排除的理由：**這些設定在畫布上看不見。** 變數表採整表原子提交，一次 `Ctrl+Z` 會把整張表打回上一版，而使用者當下毫無察覺 —— 悄悄弄丟組態的風險遠大於「能還原」的便利。這些項目改由刪除確認對話框保護（見 §4.5）。

**其他行為**

- **一個操作 = 一步復原**：多選斷開 3 個節點、一次刪除多條連線、插入子流程呼叫（含自動整理版面）等，都只需按一次 `Ctrl+Z`。
- 上限 **50 步**，切換流程時清空。錄製 / 重播進行中不記錄也不可觸發。
- 節點拖曳定位與群組收合**不進入歷史**（純版面 / 檢視狀態）。
- 快捷鍵 `Ctrl/Cmd+Z`（復原）與 `Ctrl/Cmd+Shift+Z`（重做），在輸入框中打字時自動停用。
- 工具列另有 **↶ 復原** / **↷ 重做** 按鈕。

### 4.5 編輯與儲存模式

全 App 的編輯行為統一為「**本地編輯 → 按下儲存才寫入**」：

- **所有文字 / 表單欄位**（節點屬性、配置變數表、專案環境變數表、各種命名對話框）都先改在本地，按下 **儲存 / 確認** 才寫入。輸入框按 `Enter` 等同按儲存。
- **不追蹤「未儲存」狀態，也不會出現任何提醒。** 切換節點、切換流程、切換配置 / 環境、關閉對話框時，欄位直接以最新資料重新載入，沒按儲存的輸入就此丟棄。
- **單一手勢的控制項維持即時生效**，不需按確認：配置與環境下拉選單、重播速度、節點拖曳、拖曳連接 / 斷開、群組收合展開。
- 一次提交 = 一次寫檔 = 一步復原（若該項目在復原範圍內）。
- **所有破壞性刪除都會二次確認**（刪流程 / 專案 / 環境 / 配置檔 / 各類變數，以及複製專案），採用 App 風格對話框；危險操作的 Enter 預設落在「取消」。
  **唯一例外是刪除節點**（含子樹）—— 這是高頻編輯動作，且 `Ctrl+Z` 可以救回來。

---

## 5. 子流程（Sub-flow）系統

`callFlow` 節點可把另一個 Flow 內嵌進來。

### 5.1 兩種建立方式

1. **引用既有流程**（`CallFlowModal`，2–3 步）
   - 選擇子流程（含**循環引用檢查** `FLOW_CHECK_CYCLE`，遞迴走訪整張 callFlow 圖）
   - 選擇出口節點（子流程的葉節點）
   - 配置對應（僅當子流程有多組 Profile 時出現）
   - 可從節點右鍵「在此節點前插入 / 在此節點後加入」，或從流程清單「↳ 加入當前流程中」

2. **從選取範圍抽取**
   - 多選連續節點（須通過 `validateExtraction`：單一入口、單一出口、完全連通）
   - 「另存為子流程」→ 自動建立新 Flow、以 `callFlow` 節點取代原選取範圍、重接父子關係、同時存檔兩個 Flow

### 5.2 子流程配置對應（Profile Mapping）

- `subFlowProfileMapping: Record<父配置ID, 子配置ID | null>`；`null` 表示「使用子流程的第一組配置」。
- **支援 N 層巢狀**：每一層 Replayer / ScriptExporter 都以「解析出的子流程配置 ID」作為自己的 `activeProfileId`，再往下一層解析。
- 解析順序：`subFlowProfileMapping[activeProfileId]` → 舊版 `subFlowProfileId` → 第一組配置。
- 節點徽章：對應項 >1 顯示靛色 `⚙ 動態配置`；否則顯示琥珀色 `⚙ <配置名稱>`。

### 5.3 引用計數

流程清單會計算每個 Flow 的 `refCount`（被多少 callFlow 節點引用）：
- `refCount > 0` → 歸入可收合的「子流程」區塊
- `refCount = 0` → 視為頂層測試案例

---

## 6. 變數系統

`{{...}}` 佔位符，解析優先序：**區域變數 > 環境配置變數 > 專案環境變數 > 內建變數**。

### 6.1 內建變數（5 個）

| 變數 | 產生內容 |
|------|----------|
| `{{randomText}}` | 8 字元隨機字串 |
| `{{randomNumber}}` | 8 位隨機數字 |
| `{{randomOneText}}` | 單一 A–Z 字母 |
| `{{randomOneNumber}}` | 單一 0–9 數字 |
| `{{timestamp}}` | `yyyyMMddHHmmssSSS` 格式時間戳 |

### 6.2 區域（Session）變數

- 任一動作節點可右鍵設定 `captureAs = "變數名"`，把該節點的值捕獲為變數。
- 重播時存入 Replayer 的 sessionVars；匯出時產生 `const 變數名 = ...` 宣告。
- 右側邊欄 `SessionVarList` 列出全流程的區域變數，可點擊複製、可刪除。

### 6.3 程式碼產生的細節處理

- `valueToCodeExpr()` — 值 → TS 字面值，配置變數轉為 `${_ftProf_key}`
- `sessionAwareValueToCodeExpr()` — 額外把區域變數視為裸識別字
- `locatorExprToCode()` — 改寫 locator 表達式字串參數內的 `{{...}}`
- `emitProfileVarDecls()` / `emitEnvVarDecls()` — 產生 `const _ftProf_key = '...'` / `_ftEnv_*` 宣告
- `VARIABLE_HELPERS_CODE` — 在需要時注入 `_ftRandomText` / `_ftRandomNumber` / `_ftRandomOneLetter` / `_ftRandomOneDigit` / `_ftTimestamp` 輔助函式

**`useTestStep` 模式下的區域變數提升**：每個動作被包在自己的 `test.step()` 閉包中，因此 `const` 宣告無法跨閉包可見。`generateSpec()` 會收集所有 `captureAs` 名稱，在 test 函式層級先發出 `let 變數名 = ''`，各步驟改為單純賦值。

**`assertText` 的區域變數 locator 修正**：若 `assertText` 的值是純區域變數引用且該變數已定義，會改用 `page.locator(selector).filter({ hasText: 值 })`，避免使用錄製當下已內嵌舊文字的過期 locator。

---

## 7. 環境配置（Profile）系統

每個 Flow 可有多組 `FlowProfile`（命名的變數集合），例如「管理員」「一般使用者」「客戶 A」。

- **關鍵不變量**：同一 Flow 內所有 Profile **共用同一組變數 key**，只有 `value` / `description` / `envValues` 因 Profile 而異。Store 以三個跨配置的變異操作強制此規則：`addVarToAllProfiles()`、`updateVarKeyInAllProfiles()`、`deleteVarFromAllProfiles()`。
- 每個變數可帶 `envValues: Record<環境ID, string>`，解析規則為 `envValues[當前環境] ?? value`。
- 配置變數的值本身也可以引用專案環境變數（`{{key}}`）。
- **UI**：
  - 工具列 `⚙` 配置選擇器（顯示每組配置的變數數量），非第一組時以琥珀色高亮表示「正在覆寫」
  - 「管理配置…」開啟 `ProfileEditorModal` — 左側配置清單（新增 / 改名 / 刪除），右側變數表格
  - 右側邊欄 `ProfileVarList`（琥珀色），點擊即複製 `{{key}}`
- **程式碼產生**：配置變數輸出為 spec 頂部的 `const _ftProf_key = '...'`。

---

## 8. 專案與環境（Project / Environment）系統

在 Flow 之上再加一層，用於管理跨環境的值。

### 8.1 概念

- **Project** = 一組具名 `environments`（如 DEV / UAT / PRD）+ 專案層級 `envVars`
- **每個 Flow 都屬於某個專案**；未指定或指向已刪除專案者，一律歸入保留的預設專案 **`未分類`**（`__default__`，不可刪除、不可改名，在流程清單固定置底）
- **每個專案至少有一個環境**；新建專案時自動種入一個環境（預設 `DEV`）與一個 `domain` 變數

### 8.2 保留的 `domain` 環境變數

- 每個專案都會種入，且**不可刪除、不可改名**（在編輯器中以 🔒 標示）
- 其「每環境的值」驅動 goto URL 的 origin 替換（重播與匯出皆然，尾斜線會被去除）
- `flow.baseURL` 不由使用者填寫：建立流程時取自目標專案第一個環境的 `domain`，每次開始新錄製時再更新為當前環境的 `domain`

### 8.3 專案環境變數（`ProjectEnvVar`）

- 結構：`{ key, values: Record<環境ID, string>, description? }` — 一個 key，每個環境一個值
- 由 `flattenProjectEnvVars()` 針對當前環境攤平成 key-value map
- **限制（v1）**：環境變數引用只在「流程隸屬於當前專案」時才解析，尚不支援跨專案引用

### 8.4 管理功能

| 對象 | 支援操作 |
|------|----------|
| 專案 | 新增 / 改名 / **複製** / 刪除（連同其中所有流程） |
| 環境 | 新增 / 改名 / **複製** / 刪除（至少保留一個） |
| 環境變數 | 新增 / 改名 key / 刪除 / 逐環境設值（`domain` 除外） |
| 流程 | 移至其他專案 / 改名 / 刪除 |

### 8.5 UI

- `FlowList` 依專案分組（📁 標題，`未分類` 置底），每組內再分出可收合的「子流程」小節
- 「新增專案」對話框收集：專案名稱 + 環境名稱 + domain
- 「新增流程」對話框收集：歸類至專案 + 流程名稱（**無目標 URL 欄位**）
- 工具列 🌐 環境選擇器（可直接新增環境）+「🔧 管理環境變數…」開啟 `ProjectEnvVarModal`
- 右側邊欄 `ProjectEnvVarList` 列出當前環境的專案變數

---

## 9. 程式碼節點（Code Node）

給錄製無法表達的情境（迴圈、條件、動態清單處理、自訂等待）一個逃生口。

- 在畫布空白處右鍵 →「加入節點」→ 選「程式碼 Code」
- 編輯器中可直接撰寫道地的 Playwright 程式碼，作用域內有三個物件：
  - **`page`** — 當前 Playwright Page
  - **`expect`** — Playwright 的 expect
  - **`vars`** — 所有可用變數（優先序：專案環境變數 < 配置變數 < 區域變數；內建變數以**函式**形式提供，每次呼叫取得新值，如 `vars.randomText()`）
- 對話框右側列出所有可用變數並標註來源（內建 / 環境配置 / 專案環境 / 區域），點擊即複製
- **重播**：以 `AsyncFunction` 原樣執行
- **匯出**：程式碼原樣內嵌進 spec，並自動產生對應的 `const vars = { ... }` 前置宣告

---

## 10. 腳本匯出與測試執行

### 10.1 匯出（`ScriptExporter`）

- 計算所有 root→leaf 路徑，**每條路徑產生一個 `test()` 區塊**，寫入 `exports/{flowId}.spec.ts`
- `useTestStep` 模式：每個動作包一層 `test.step('描述', async () => {...})`，HTML 報告中步驟一目了然
- **共用前綴抽取**：當 ≥2 條路徑共享 ≥3 個前導節點時，抽成 `exports/helpers/{flowId}-helpers.ts` 的共用函式
- **子流程遞迴展開**：逐層解析配置，子流程節點以 `inlineVars: true` 展開 — 其配置變數在產碼階段就烘焙成字面值，不會誤引用父流程的 `_ftProf_*`
- **環境專屬匯出**：goto 的網域直接烘焙成當前環境的字面值（`await page.goto('<domain>/path')`），匯出結果對應特定環境
- popup 產生官方 `waitForEvent('popup')` 樣板；iframe 產生 `.contentFrame()` 鏈；雙擊產生 `dblclick`

### 10.2 執行測試

1. 工具列「▶ 執行所有測試」→ 先匯出 spec
2. 以子行程 spawn `npx playwright test <file> --reporter=list,html`
3. stdout / stderr **逐行串流**回渲染程序，`TestOutputModal` 即時顯示執行輸出
4. 結束時回報離開碼與通過與否
5. HTML 報告另由 `SHOW_REPORT` 開啟（會先清掉佔用 9323 埠的行程）

執行設定見 `playwright.config.ts`：`testDir: './exports'`、`headless: false`、HTML reporter。

---

## 11. 資料儲存

全部是純 JSON 檔案，開發模式放在專案目錄，打包後放在 Electron 的 `userData`：

| 路徑 | 內容 |
|------|------|
| `flows/{flowId}.json` | 流程（節點、座標、群組、配置、專案歸屬） |
| `projects/{projectId}.json` | 專案（環境清單、專案環境變數） |
| `fixtures/` | 上傳測試用的檔案副本（同名衝突加內容雜湊後綴） |
| `exports/{flowId}.spec.ts` | 產生的 Playwright 測試 |
| `exports/helpers/{flowId}-helpers.ts` | 抽取出的共用前綴函式 |

- `FlowStorage.list()` 會掃描所有流程的 callFlow 節點以計算 `refCount`，並依 `updatedAt` 排序
- `ProjectStorage.ensureDefault()` 會實體化保留的 `未分類` 專案（DEV 環境 + `domain`），讓它擁有穩定的環境 ID
- 錄製過程中每捕獲一個動作就**自動存檔**

---

## 12. 使用者介面總覽

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 工具列：新增流程 │ ↶↷ │ ▶錄製 │ 🧹整理 │ 匯出 │ ▶執行 │ 狀態 │ 速度 │ 🌐環境 │ ⚙配置 │
├────────────┬──────────────────────────────────────────┬──────────────────┤
│            │                                          │  內建變數        │
│  流程清單  │            React Flow 畫布               │  配置變數        │
│  📁 專案A  │      （節點 / 分支 / 群組 / MiniMap）    │  專案環境變數    │
│    └ 子流程│                                          │  區域變數        │
│  📁 未分類 ├──────────────────────────────────────────┤  （點擊即複製）  │
│            │  屬性面板：描述 / Selector / Locator /   │                  │
│            │            值 / 配置對應                 │                  │
└────────────┴──────────────────────────────────────────┴──────────────────┘
```

### 主要視窗與對話框

| 元件 | 用途 |
|------|------|
| `Toolbar` | 主要動作列、狀態徽章、環境與配置選擇器 |
| `FlowList` | 依專案分組的流程清單、右鍵選單、新增專案 / 改名對話框 |
| `FlowCanvas` | React Flow 畫布，含節點衍生、拖曳、連接、多選、右鍵選單 |
| `ActionNode` | 節點外觀：類型圖示與顏色、描述、selector、重播狀態邊框、頁面導覽邊框、配置徽章、缺檔警告 |
| `GroupNode` / `GroupBox` | 折疊態群組膠囊 / 展開態群組外框（含收合與解散控制） |
| `NodeContextMenu` | 節點右鍵選單（重播、分支錄製、群組、抽取子流程、插入子流程、設區域變數、斷連、刪除） |
| `PropertyPanel` | 編輯選取節點的描述 / selector / locator / 值；上傳節點的檔案選擇；callFlow 的配置對應表 |
| `ProfileEditorModal` | 雙欄配置編輯器 |
| `ProjectEnvVarModal` | 專案環境變數編輯器（每列一個 key，每個環境一欄值；`domain` 鎖定） |
| `CallFlowModal` | 2–3 步的子流程嵌入精靈 |
| `AddNodeModal` | 新增獨立節點（程式碼節點）+ 可用變數速查 |
| `ExtractSubflowModal` / `GroupNameModal` | 抽取子流程 / 建立群組的命名對話框 |
| `TestOutputModal` | 測試執行的即時輸出串流 |
| `CanvasStatusBar` | 多選狀態橫幅 |

---

## 13. 系統架構

### 三個獨立打包的 bundle（由 electron-vite 建置）

```
主行程 (Node.js)              Preload 橋接           渲染程序 (React)
──────────────────            ──────────────         ────────────────
ipcHandlers.ts                preload/index.ts       App.tsx
  ├── BrowserController         contextBridge          Zustand store (flowStore)
  ├── Recorder                  window.electronAPI     React Flow 畫布
  ├── Replayer                                         Hooks
  ├── CodegenCapture                                   Canvas utils
  ├── FlowStorage
  ├── ProjectStorage
  ├── FixtureStorage
  └── ScriptExporter
```

- **安全設定**：`contextIsolation: true`、`nodeIntegration: false`，所有能力透過 preload 的 `contextBridge` 明確暴露
- **IPC 為唯一接縫**：`ipcHandlers.ts` 是唯一協調主行程模組的檔案；所有通道常數集中在 `src/shared/types.ts` 的 `IPC_CHANNELS`
  - 渲染 → 主：**22 個通道**（瀏覽器、錄製、重播、流程 CRUD、專案 CRUD、匯出、執行、報告、斷言拾取、Locator 拾取、檔案選擇）
  - 主 → 渲染：**11 個通道**（動作捕獲 / 更新 / 移除、重播進度與結果、測試輸出與結束、拾取取消等）
- **路徑別名**：`@shared/*` → `src/shared/*`，`@renderer/*` → `src/renderer/*`

### 指令

```bash
npm run dev       # 熱重載開發（electron-vite dev）
npm run build     # 建置三個 bundle
npm run preview   # 預覽正式建置
npm run dist      # 建置 + 產生安裝檔（electron-builder）
```

---

## 14. 功能速查表

| 分類 | 功能 |
|------|------|
| **錄製** | 14 種動作類型 · 官方等級 locator · Shadow DOM 穿透 · 導覽抑制 · 輸入點擊抑制 · 雙擊合併 · popup/新分頁 · iframe · 檔案上傳（CDP 取真實路徑） · 瀏覽器內斷言 dock · 瀏覽器內 Locator 選擇器 |
| **分支錄製** | 從任一節點靜默重播後續錄 · 可調靜默重播速度 · 自動接續錄製游標 |
| **重播** | 重播到任意節點 · 游標高亮 · 三段速度 · 節點狀態徽章 · 4 型斷言 · 變數解析 · 網域替換 · 子流程遞迴 · 多頁面 / iframe |
| **編輯** | 拖曳定位 · 拖曳連接 / 斷開 · 多選 · 中斷連線 · 刪除（含 / 不含子樹） · 自動樹狀佈局 · 一鍵整理 · 視覺群組（折疊 / 展開 / 解散） · 復原重做（**僅限節點操作**，50 步 + 快捷鍵） · 按儲存才寫入的編輯模式 · 破壞性刪除二次確認 |
| **子流程** | 引用既有流程 · 從選取抽取 · 循環引用檢查 · 出口節點選擇 · N 層巢狀 · 配置對應 · 引用計數分類 |
| **變數** | 5 個內建變數 · 區域變數（captureAs） · 配置變數 · 專案環境變數 · 四層優先序 · locator 內變數改寫 · `useTestStep` 變數提升 |
| **環境管理** | 多組 Profile（key 跨配置同步） · 專案 / 環境 / 環境變數的完整 CRUD + 複製 · 保留的 `domain` 變數驅動網域切換 · 每環境值覆寫 |
| **匯出執行** | 路徑展開為多個 test · `test.step` 包裝 · 共用前綴抽 helper · 子流程內嵌展開 · 環境專屬烘焙 · 一鍵執行 + 即時輸出 · HTML 報告 |
| **儲存** | 純 JSON · 錄製即時自動存檔 · fixtures 相對路徑（可攜） · 開發 / 打包雙路徑 |

---

*本文件由分析 `src/` 原始碼產生，反映 `develop` 分支於 2026-07-26 的實際實作狀態。*
