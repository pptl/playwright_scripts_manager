# PRD：FlowTest — 視覺化 Playwright 錄製與執行工具

## 1. 產品概述

### 1.1 一句話描述

一個桌面工具，讓錄製和執行 Playwright 測試腳本看起來像在編輯流程圖。

### 1.2 核心場景

使用者打開工具 → 開始錄製 → 操作瀏覽器 → 每個動作自動變成畫布上的一個節點 → 停止錄製 → 點擊任意節點 → 瀏覽器自動重播到該節點 → 從該節點繼續錄製新分支 → 匯出所有路徑為 `.spec.ts` 檔案。

### 1.3 解決什麼問題

ERP 等複雜系統的測試流程很深（要點很多步才到達真正想測的地方），每次從頭錄製浪費大量時間。現有工具的痛點：

- **Playwright Codegen**：只能從頭錄到尾，沒有分支概念，想測不同分支要重新錄
- **BugBug**：有 Component 重用但沒有「跳到某個節點繼續錄」的能力
- **兩者都缺少**：流程的視覺化全局視圖

### 1.4 核心價值

**「跳到任意節點繼續錄」**——把「到達操作起點」變成一鍵完成，只錄差異的部分。錄製過程自然產生流程的樹狀結構圖。

---

## 2. 技術選型

| 項目 | 技術 | 理由 |
|------|------|------|
| 桌面框架 | Electron | 可同時控制 UI 和 Playwright 瀏覽器 |
| 前端 UI | React + TypeScript | 熟悉的技術棧 |
| 節點編輯器 | React Flow | 開源免費，節點拖拉、連線、縮放、平移都內建 |
| 瀏覽器自動化 | Playwright API（非 Codegen CLI） | 直接用 API 才能控制錄製、重播、暫停 |
| 資料儲存 | JSON 檔案（每個流程一個 .json） | 簡單，不需要資料庫 |
| 腳本匯出 | 字串模板生成 .spec.ts | 純文字處理，不需要 AST |

### 2.1 dependencies

```json
{
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "reactflow": "^11.11.0",
    "electron": "^30.0.0",
    "playwright-core": "^1.44.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vite": "^5.2.0",
    "electron-builder": "^24.0.0"
  }
}
```

---

## 3. 系統架構

```
┌────────────────────────────────────────────────────────┐
│                    Electron App                         │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │              Renderer Process（React）             │  │
│  │                                                    │  │
│  │  ┌──────────────┐  ┌───────────────────────────┐  │  │
│  │  │   工具列      │  │    React Flow 畫布         │  │  │
│  │  │              │  │                           │  │  │
│  │  │ [新增流程]    │  │   [登入] → [進入頁面]      │  │  │
│  │  │ [開始錄製]    │  │               ↓           │  │  │
│  │  │ [停止錄製]    │  │          [點新增]          │  │  │
│  │  │ [匯出腳本]    │  │           ↙    ↘         │  │  │
│  │  │              │  │    [表單A]    [表單B]      │  │  │
│  │  │              │  │       ↓          ↓        │  │  │
│  │  │              │  │    [送出]      [送出]      │  │  │
│  │  └──────────────┘  └───────────────────────────┘  │  │
│  │                                                    │  │
│  │  ┌────────────────────────────────────────────┐    │  │
│  │  │           節點屬性面板（點選節點時顯示）      │    │  │
│  │  │  動作：click                                │    │  │
│  │  │  Selector：[data-testid="submit-btn"]       │    │  │
│  │  │  驗證：找到「送出成功」文字                   │    │  │
│  │  └────────────────────────────────────────────┘    │  │
│  └──────────────────────────────────────────────────┘  │
│                          │                              │
│                     IPC 通訊                            │
│                          │                              │
│  ┌──────────────────────────────────────────────────┐  │
│  │              Main Process（Node.js）               │  │
│  │                                                    │  │
│  │  ┌──────────────┐  ┌──────────────┐               │  │
│  │  │ Playwright   │  │  檔案系統     │               │  │
│  │  │ Controller   │  │  (JSON/TS)   │               │  │
│  │  │              │  │              │               │  │
│  │  │ - 啟動瀏覽器  │  │ - 讀寫流程   │               │  │
│  │  │ - 錄製動作    │  │ - 匯出腳本   │               │  │
│  │  │ - 重播動作    │  │              │               │  │
│  │  └──────────────┘  └──────────────┘               │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
         │
         │ Playwright CDP
         ▼
┌──────────────────┐
│   Chromium 瀏覽器  │
│   (被測試的 ERP)   │
└──────────────────┘
```

---

## 4. 專案結構

```
flowtest/
├── src/
│   ├── main/                          ← Electron Main Process
│   │   ├── index.ts                   ← Electron 入口
│   │   ├── ipc/                       ← IPC 通訊處理
│   │   │   ├── ipcHandlers.ts
│   │   │   └── ipcChannels.ts
│   │   ├── playwright/                ← Playwright 控制器
│   │   │   ├── browserController.ts   ← 啟動/關閉瀏覽器
│   │   │   ├── recorder.ts            ← 錄製動作
│   │   │   ├── replayer.ts            ← 重播動作
│   │   │   └── actionCapture.ts       ← 攔截瀏覽器事件轉成 Action
│   │   ├── storage/                   ← 檔案讀寫
│   │   │   ├── flowStorage.ts         ← 流程 JSON 讀寫
│   │   │   └── scriptExporter.ts      ← 匯出 .spec.ts
│   │   └── preload.ts                 ← Electron preload
│   │
│   ├── renderer/                      ← React 前端
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── Canvas/                ← React Flow 畫布
│   │   │   │   ├── FlowCanvas.tsx     ← 主畫布
│   │   │   │   ├── ActionNode.tsx     ← 動作節點元件
│   │   │   │   └── BranchEdge.tsx     ← 連線元件
│   │   │   ├── Toolbar/               ← 工具列
│   │   │   │   └── Toolbar.tsx
│   │   │   ├── PropertyPanel/         ← 節點屬性面板
│   │   │   │   └── PropertyPanel.tsx
│   │   │   └── FlowList/              ← 流程列表（側邊欄）
│   │   │       └── FlowList.tsx
│   │   ├── hooks/
│   │   │   ├── usePlaywright.ts       ← Playwright IPC 封裝
│   │   │   ├── useFlowStore.ts        ← 流程狀態管理
│   │   │   └── useRecording.ts        ← 錄製狀態管理
│   │   ├── stores/
│   │   │   └── flowStore.ts           ← Zustand 狀態管理
│   │   ├── types/
│   │   │   └── flow.ts               ← 型別定義
│   │   └── utils/
│   │       └── exportTemplate.ts      ← .spec.ts 模板
│   │
│   └── shared/                        ← Main 和 Renderer 共用
│       └── types.ts
│
├── flows/                             ← 使用者的流程檔案（JSON）
├── exports/                           ← 匯出的 .spec.ts 檔案
├── electron-builder.yml
├── vite.config.ts
├── package.json
└── tsconfig.json
```

---

## 5. 資料結構

### 5.1 核心型別

```typescript
// src/shared/types.ts

/** 單一動作（一個節點） */
interface Action {
  id: string;                          // uuid
  type: ActionType;
  selector: string;                    // Playwright selector
  value?: string;                      // fill 時的值
  description: string;                 // 自動生成的可讀描述（例：「點擊 "送出" 按鈕」）
  timestamp: number;
  screenshot?: string;                 // 執行時的截圖路徑（可選）

  // 驗證：執行完這個動作後，頁面上應該要有什麼
  assertion?: {
    type: 'text' | 'visible' | 'url' | 'count';
    target?: string;                   // selector 或文字
    expected: string;                  // 預期值
  };

  // 頁面資訊
  url: string;                         // 執行此動作時的頁面 URL
  isPageNavigation: boolean;           // 這個動作有沒有造成頁面跳轉
}

type ActionType =
  | 'goto'           // 導航到 URL
  | 'click'          // 點擊
  | 'fill'           // 填入文字
  | 'selectOption'   // 下拉選單
  | 'check'          // 勾選
  | 'uncheck'        // 取消勾選
  | 'press'          // 按鍵（Enter、Tab 等）
  | 'upload'         // 上傳檔案
  | 'wait';          // 等待元素出現

/** 節點在畫布上的位置 */
interface NodePosition {
  x: number;
  y: number;
}

/** 流程中的一個節點（Action + 畫布資訊） */
interface FlowNode {
  id: string;                          // 同 Action.id
  action: Action;
  position: NodePosition;             // React Flow 座標
  parentId: string | null;             // 上一個節點的 id（null = 根節點）
  childIds: string[];                  // 下游節點的 id 列表（分支）
}

/** 一個完整的流程 */
interface Flow {
  id: string;                          // uuid
  name: string;                        // 流程名稱
  description?: string;
  createdAt: string;                   // ISO timestamp
  updatedAt: string;
  baseURL: string;                     // 測試目標的 base URL
  nodes: FlowNode[];                   // 所有節點
  rootNodeId: string;                  // 根節點 id
}

/** 匯出設定 */
interface ExportConfig {
  outputDir: string;                   // 匯出目錄
  helperFunctions: boolean;            // 是否提取共用前綴為 helper
  useTestStep: boolean;                // 是否用 test.step() 包裝
}

/** 一條路徑（根到葉）= 一個測試案例 */
interface TestPath {
  id: string;
  name: string;                        // 自動或手動命名
  nodeIds: string[];                   // 從根到葉的節點 id 序列
}
```

### 5.2 JSON 儲存格式

```json
// flows/signing-flow.json
{
  "id": "flow-001",
  "name": "簽核流程",
  "description": "簽核設定 → 申請 → 送審 → 審核",
  "createdAt": "2026-06-14T10:00:00Z",
  "updatedAt": "2026-06-14T12:30:00Z",
  "baseURL": "https://esd.genesys-tech.com",
  "rootNodeId": "node-001",
  "nodes": [
    {
      "id": "node-001",
      "action": {
        "id": "node-001",
        "type": "goto",
        "selector": "",
        "value": "https://esd.genesys-tech.com/Login",
        "description": "開啟登入頁面",
        "timestamp": 1718352000000,
        "url": "https://esd.genesys-tech.com/Login",
        "isPageNavigation": true
      },
      "position": { "x": 300, "y": 50 },
      "parentId": null,
      "childIds": ["node-002"]
    },
    {
      "id": "node-002",
      "action": {
        "id": "node-002",
        "type": "fill",
        "selector": "#account",
        "value": "emp-001",
        "description": "填寫帳號",
        "timestamp": 1718352001000,
        "url": "https://esd.genesys-tech.com/Login",
        "isPageNavigation": false
      },
      "position": { "x": 300, "y": 130 },
      "parentId": "node-001",
      "childIds": ["node-003"]
    }
  ]
}
```

---

## 6. 功能需求

### 6.1 流程管理

**6.1.1 新增流程**
- 點擊「新增流程」→ 輸入名稱和目標 URL → 開啟空白畫布
- 空白畫布中央顯示一個「開始」的虛擬節點

**6.1.2 流程列表**
- 左側邊欄顯示所有已儲存的流程（讀取 `flows/` 目錄）
- 點擊流程名稱 → 載入到畫布
- 顯示最後修改時間

**6.1.3 自動儲存**
- 每次錄製完成後自動儲存 JSON
- 每次手動編輯節點屬性後自動儲存

---

### 6.2 錄製

**6.2.1 開始錄製**
- 點擊「開始錄製」→ Main Process 啟動 Playwright 瀏覽器（headed）
- 瀏覽器自動導航到流程的 baseURL
- 工具列狀態變為「錄製中」（紅色指示燈）

**6.2.2 動作捕捉**
- 使用者在瀏覽器中操作，每個動作即時傳回 Renderer
- 每個動作自動建立一個新節點，附加在當前最後一個節點之後
- 畫布即時更新，新節點出現並自動排列
- 動作類型對應：
  - 點擊元素 → `click` 節點
  - 在輸入框打字 → `fill` 節點
  - 選擇下拉選單 → `selectOption` 節點
  - 頁面跳轉 → `goto` 節點（自動標記 `isPageNavigation: true`）
  - 按鍵盤（Enter/Tab）→ `press` 節點

**6.2.3 錄製中加入驗證**
- 錄製過程中，工具列有「加入驗證」按鈕
- 點擊後進入驗證模式：滑鼠移到瀏覽器元素上 → 高亮顯示 → 點擊 → 跳出選單：
  - 「驗證此元素可見」
  - 「驗證包含文字：___」
  - 「驗證 URL 包含：___」
- 選擇後，驗證資訊附加到當前最後一個節點的 `assertion` 欄位

**6.2.4 停止錄製**
- 點擊「停止錄製」→ 停止捕捉動作，瀏覽器保持開啟
- 節點鏈完成，畫布顯示完整的線性流程

---

### 6.3 重播到節點（核心功能）

**6.3.1 觸發方式**
- 在畫布上右鍵點擊任意節點 → 選擇「重播到此節點」
- 或雙擊節點

**6.3.2 重播行為**
- Main Process 收到指令
- 如果瀏覽器未開啟 → 啟動瀏覽器
- 從根節點開始，依序執行每個節點的 Action
- 每執行一個節點，畫布上對應節點高亮（綠色閃爍），表示正在執行
- 到達目標節點後停止
- 瀏覽器停留在該節點執行完畢的狀態

**6.3.3 重播中的驗證**
- 重播每個節點時，如果節點有 `assertion`，自動驗證
- 驗證方式：在頁面上尋找 assertion 指定的內容（文字或元素）
- 驗證成功 → 節點標記為綠色，繼續下一個
- 驗證失敗 → 節點標記為紅色，彈出提示，詢問是否繼續

**6.3.4 重播速度**
- 預設每個動作之間間隔 500ms（讓使用者看到過程）
- 可以調整速度（快速 100ms / 正常 500ms / 慢速 1000ms）

---

### 6.4 分支錄製（核心功能）

**6.4.1 觸發方式**
- 重播到某個節點後，點擊「從此繼續錄製」
- 或右鍵節點 → 選擇「從此分支」

**6.4.2 分支行為**
- 進入錄製模式，但新的節點不是附加在線性末端，而是作為被選節點的新 child
- 畫布上出現分支（被選節點有兩條以上的輸出連線）
- 分支的視覺呈現：

```
    [點新增]
     ↙    ↘
[填表單A]  [填表單B]   ← 分支，兩條路線
    ↓          ↓
  [送出]     [送出]
```

**6.4.3 分支命名**
- 建立分支時，彈出輸入框讓使用者命名分支（例：「選擇特休」「選擇病假」）
- 名稱顯示在分支連線上

---

### 6.5 節點屬性編輯

**6.5.1 屬性面板**
- 點擊畫布上的節點 → 底部（或右側）出現屬性面板
- 可編輯欄位：
  - 描述（自動生成，可手動修改）
  - Selector（可手動修改）
  - 值（fill/selectOption 的值）
  - 驗證條件（新增/編輯/刪除 assertion）

**6.5.2 節點刪除**
- 右鍵節點 → 「刪除此節點」
- 如果節點有下游 → 確認是否連帶刪除所有下游節點

**6.5.3 節點視覺樣式**
- 不同 ActionType 用不同顏色區分：
  - `goto`（頁面跳轉）：藍色
  - `click`：灰色
  - `fill` / `selectOption`：紫色
  - 有 `assertion` 的節點：右上角小勾勾圖示
  - `isPageNavigation: true` 的節點：邊框加粗

---

### 6.6 匯出 Playwright 腳本

**6.6.1 觸發方式**
- 工具列「匯出腳本」按鈕
- 或右鍵流程名稱 → 「匯出」

**6.6.2 路徑計算**
- 自動計算所有從根節點到葉節點的路徑
- 每條路徑 = 一個 test case
- 顯示路徑列表讓使用者確認

**6.6.3 匯出格式**

每條路徑生成一個 test block，包在同一個 .spec.ts 檔案裡：

```typescript
// exports/signing-flow.spec.ts
import { test, expect } from '@playwright/test';

test.describe('簽核流程', () => {

  test('簽核 - 表單A', async ({ page }) => {
    await test.step('開啟登入頁面', async () => {
      await page.goto('https://esd.genesys-tech.com/Login');
    });

    await test.step('填寫帳號', async () => {
      await page.locator('#account').fill('emp-001');
    });

    await test.step('填寫密碼', async () => {
      await page.locator('#password').fill('Test1234!');
    });

    await test.step('點擊確認', async () => {
      await page.locator('#login-btn').click();
    });

    await test.step('驗證登入成功', async () => {
      await expect(page).toHaveURL(/Dashboard/);
    });

    await test.step('進入簽核頁面', async () => {
      await page.locator('text=簽核管理').click();
    });

    await test.step('點擊新增', async () => {
      await page.locator('#new-btn').click();
    });

    await test.step('填寫表單A', async () => {
      await page.locator('#type-select').selectOption('特休');
      // ... 表單A的具體操作
    });

    await test.step('送出', async () => {
      await page.locator('#submit-btn').click();
    });

    await test.step('驗證送出成功', async () => {
      await expect(page.locator('.success-toast')).toContainText('送出成功');
    });
  });

  test('簽核 - 表單B', async ({ page }) => {
    // 共用前綴（登入 → 進入頁面 → 點新增）
    await test.step('開啟登入頁面', async () => {
      await page.goto('https://esd.genesys-tech.com/Login');
    });

    // ... 相同的前綴步驟 ...

    // 分支點開始不同
    await test.step('填寫表單B', async () => {
      await page.locator('#type-select').selectOption('病假');
      // ... 表單B的具體操作
    });

    await test.step('送出', async () => {
      await page.locator('#submit-btn').click();
    });

    await test.step('驗證送出成功', async () => {
      await expect(page.locator('.success-toast')).toContainText('送出成功');
    });
  });

});
```

**6.6.4 共用前綴提取為 helper（可選功能）**

如果使用者開啟「提取 helper」選項，共用前綴自動提取：

```typescript
// exports/helpers/signing-helpers.ts
export async function loginAsEmployee(page: Page) {
  await page.goto('https://esd.genesys-tech.com/Login');
  await page.locator('#account').fill('emp-001');
  await page.locator('#password').fill('Test1234!');
  await page.locator('#login-btn').click();
  await expect(page).toHaveURL(/Dashboard/);
}

export async function navigateToApprovalAndClickNew(page: Page) {
  await page.locator('text=簽核管理').click();
  await page.locator('#new-btn').click();
}
```

```typescript
// exports/signing-flow.spec.ts
import { test, expect } from '@playwright/test';
import { loginAsEmployee, navigateToApprovalAndClickNew } from './helpers/signing-helpers';

test.describe('簽核流程', () => {

  test('簽核 - 表單A', async ({ page }) => {
    await test.step('登入', () => loginAsEmployee(page));
    await test.step('進入簽核並新增', () => navigateToApprovalAndClickNew(page));
    await test.step('填寫表單A', async () => {
      // ... 表單A
    });
    await test.step('送出並驗證', async () => {
      await page.locator('#submit-btn').click();
      await expect(page.locator('.success-toast')).toContainText('送出成功');
    });
  });

  test('簽核 - 表單B', async ({ page }) => {
    await test.step('登入', () => loginAsEmployee(page));
    await test.step('進入簽核並新增', () => navigateToApprovalAndClickNew(page));
    await test.step('填寫表單B', async () => {
      // ... 表單B
    });
    await test.step('送出並驗證', async () => {
      await page.locator('#submit-btn').click();
      await expect(page.locator('.success-toast')).toContainText('送出成功');
    });
  });

});
```

**6.6.5 helper 提取邏輯**

- 找出所有路徑的共用前綴（最長公共前綴）
- 共用前綴長度 >= 3 個節點時才提取（太短不值得）
- 自動生成 helper 函式名稱：取前綴中第一個和最後一個節點的描述組合
- 使用者可以在匯出前手動修改 helper 名稱

---

## 7. UI 設計要點

### 7.1 整體佈局

```
┌────────┬──────────────────────────────────────┐
│        │          工具列                       │
│ 流程   ├──────────────────────────────────────┤
│ 列表   │                                      │
│        │                                      │
│ Flow1  │           React Flow 畫布             │
│ Flow2  │         （節點 + 連線）                │
│ Flow3  │                                      │
│        │                                      │
│        ├──────────────────────────────────────┤
│        │        節點屬性面板（可收合）           │
└────────┴──────────────────────────────────────┘
```

### 7.2 節點樣式

每個節點顯示：
- 圖標（根據 ActionType）
- 描述文字（一行，超出截斷）
- 有 assertion 時右上角顯示勾勾圖標

節點狀態色：
- 預設：根據 ActionType 的顏色
- 錄製中新增：邊框脈動動畫
- 重播中：綠色閃爍
- 重播驗證失敗：紅色
- 被選取：藍色邊框

### 7.3 工具列按鈕

| 按鈕 | 狀態 | 行為 |
|------|------|------|
| 新增流程 | 隨時可用 | 建立空白流程 |
| 開始錄製 | 未錄製時可用 | 啟動瀏覽器，開始捕捉 |
| 停止錄製 | 錄製中可用 | 停止捕捉，保持瀏覽器開啟 |
| 加入驗證 | 錄製中可用 | 切換為驗證模式 |
| 重播全部 | 有節點時可用 | 從頭重播到最後一個葉節點 |
| 匯出腳本 | 有節點時可用 | 開啟匯出設定 Dialog |
| 速度調節 | 重播中可用 | 快速/正常/慢速 |

---

## 8. 技術細節

### 8.1 動作捕捉機制

Playwright 沒有內建的「錄製 API」，Codegen 的錄製功能是透過注入 JavaScript 到頁面來實現的。我們需要用類似的方式：

```typescript
// src/main/playwright/actionCapture.ts
import { Page } from 'playwright-core';

export class ActionCapture {
  private page: Page;
  private onAction: (action: Action) => void;

  constructor(page: Page, onAction: (action: Action) => void) {
    this.page = page;
    this.onAction = onAction;
  }

  async startCapturing() {
    // 方式：監聽 CDP 事件
    const cdpSession = await this.page.context().newCDPSession(this.page);

    // 監聽 DOM 事件
    await this.page.exposeFunction('__flowtest_report', (event: any) => {
      this.onAction(this.eventToAction(event));
    });

    // 注入監聽腳本到頁面
    await this.page.addInitScript(() => {
      document.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        (window as any).__flowtest_report({
          type: 'click',
          selector: generateSelector(target),
          timestamp: Date.now(),
          url: window.location.href,
        });
      }, true);

      document.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement;
        (window as any).__flowtest_report({
          type: 'fill',
          selector: generateSelector(target),
          value: target.value,
          timestamp: Date.now(),
          url: window.location.href,
        });
      }, true);

      // ... 更多事件監聽

      function generateSelector(el: HTMLElement): string {
        // 優先順序：data-testid > id > aria-label > CSS path
        if (el.dataset.testid) return `[data-testid="${el.dataset.testid}"]`;
        if (el.id) return `#${el.id}`;
        if (el.getAttribute('aria-label')) return `[aria-label="${el.getAttribute('aria-label')}"]`;
        // fallback: 生成 CSS path
        return generateCSSPath(el);
      }
    });

    // 監聽頁面跳轉
    this.page.on('framenavigated', (frame) => {
      if (frame === this.page.mainFrame()) {
        this.onAction({
          id: crypto.randomUUID(),
          type: 'goto',
          selector: '',
          value: frame.url(),
          description: `跳轉到 ${frame.url()}`,
          timestamp: Date.now(),
          url: frame.url(),
          isPageNavigation: true,
        });
      }
    });
  }
}
```

### 8.2 重播機制

```typescript
// src/main/playwright/replayer.ts
import { Page } from 'playwright-core';

export class Replayer {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async replayToNode(
    nodes: FlowNode[],
    targetNodeId: string,
    onNodeStart: (nodeId: string) => void,
    onNodeComplete: (nodeId: string, success: boolean) => void,
    speed: number = 500
  ) {
    // 計算從根到目標節點的路徑
    const path = this.findPath(nodes, targetNodeId);

    for (const node of path) {
      onNodeStart(node.id);

      try {
        await this.executeAction(node.action);

        // 如果有 assertion，執行驗證
        if (node.action.assertion) {
          await this.executeAssertion(node.action.assertion);
        }

        onNodeComplete(node.id, true);
      } catch (error) {
        onNodeComplete(node.id, false);
        throw error;
      }

      // 動作之間的間隔
      await new Promise(resolve => setTimeout(resolve, speed));
    }
  }

  private async executeAction(action: Action) {
    switch (action.type) {
      case 'goto':
        await this.page.goto(action.value!);
        break;
      case 'click':
        await this.page.locator(action.selector).click();
        break;
      case 'fill':
        await this.page.locator(action.selector).fill(action.value!);
        break;
      case 'selectOption':
        await this.page.locator(action.selector).selectOption(action.value!);
        break;
      case 'check':
        await this.page.locator(action.selector).check();
        break;
      case 'uncheck':
        await this.page.locator(action.selector).uncheck();
        break;
      case 'press':
        await this.page.keyboard.press(action.value!);
        break;
    }
  }

  private async executeAssertion(assertion: Action['assertion']) {
    if (!assertion) return;
    switch (assertion.type) {
      case 'text':
        await expect(this.page.locator(assertion.target!))
          .toContainText(assertion.expected);
        break;
      case 'visible':
        await expect(this.page.locator(assertion.target!))
          .toBeVisible();
        break;
      case 'url':
        await expect(this.page)
          .toHaveURL(new RegExp(assertion.expected));
        break;
    }
  }

  private findPath(nodes: FlowNode[], targetId: string): FlowNode[] {
    // 從目標節點往上找到根節點，然後反轉
    const path: FlowNode[] = [];
    let current = nodes.find(n => n.id === targetId);

    while (current) {
      path.unshift(current);
      current = current.parentId
        ? nodes.find(n => n.id === current!.parentId)
        : undefined;
    }

    return path;
  }
}
```

### 8.3 IPC 通訊

```typescript
// src/shared/types.ts — IPC 通道定義
export const IPC_CHANNELS = {
  // Renderer → Main
  BROWSER_LAUNCH: 'browser:launch',
  BROWSER_CLOSE: 'browser:close',
  RECORDING_START: 'recording:start',
  RECORDING_STOP: 'recording:stop',
  REPLAY_TO_NODE: 'replay:toNode',
  REPLAY_STOP: 'replay:stop',
  FLOW_SAVE: 'flow:save',
  FLOW_LOAD: 'flow:load',
  FLOW_LIST: 'flow:list',
  EXPORT_SCRIPTS: 'export:scripts',

  // Main → Renderer
  ACTION_CAPTURED: 'action:captured',
  REPLAY_NODE_START: 'replay:nodeStart',
  REPLAY_NODE_COMPLETE: 'replay:nodeComplete',
  REPLAY_FINISHED: 'replay:finished',
  REPLAY_ERROR: 'replay:error',
} as const;
```

---

## 9. 實施計畫

### Phase 1：骨架（第 1 週）

- [ ] 初始化 Electron + React + Vite 專案
- [ ] 建立基本視窗佈局（工具列 + 畫布 + 側邊欄）
- [ ] 整合 React Flow，能顯示靜態的測試節點
- [ ] 建立 IPC 通訊骨架
- [ ] Main Process 能啟動和關閉 Playwright 瀏覽器

### Phase 2：錄製（第 2 週）

- [ ] 實作 ActionCapture（注入頁面腳本，捕捉操作）
- [ ] 捕捉的 Action 即時傳回 Renderer，建立節點
- [ ] 畫布即時更新（新節點出現 + 自動排列）
- [ ] 實作「加入驗證」模式
- [ ] 流程自動儲存為 JSON

### Phase 3：重播 + 分支（第 3 週）

- [ ] 實作 Replayer（從根到指定節點依序執行）
- [ ] 重播時畫布節點高亮回饋
- [ ] 重播到節點後可以「從此繼續錄製」→ 產生分支
- [ ] 分支在畫布上正確顯示（樹狀結構）
- [ ] 節點屬性面板：點擊節點可編輯

### Phase 4：匯出（第 4 週）

- [ ] 自動計算所有根到葉的路徑
- [ ] 路徑 → .spec.ts 模板轉換
- [ ] 匯出設定 Dialog（輸出目錄、是否提取 helper）
- [ ] 共用前綴提取為 helper function（可選）
- [ ] 匯出的腳本可以用 `npx playwright test` 直接跑

### Phase 5：打磨（第 5 週）

- [ ] 節點視覺樣式（ActionType 顏色、assertion 圖示）
- [ ] 重播速度控制
- [ ] 節點刪除（含下游連帶刪除）
- [ ] 錯誤處理（瀏覽器關閉、頁面超時）
- [ ] 基本的鍵盤快捷鍵（Space = 開始/停止錄製，Delete = 刪除節點）

---

## 10. MVP 成功標準

| 標準 | 目標 |
|------|------|
| 能錄製一條完整的登入 → 操作 → 驗證流程 | ✓ |
| 能在畫布上看到完整的節點鏈 | ✓ |
| 能點擊任意節點重播到該位置 | ✓ |
| 能從任意節點繼續錄製產生分支 | ✓ |
| 匯出的 .spec.ts 能用 `npx playwright test` 跑過 | ✓ |
| 整個錄製 + 分支 + 匯出流程在 10 分鐘內完成 | ✓ |

---

## 11. 不做（MVP 之後再考慮）

| 功能 | 為什麼暫時不做 |
|------|--------------|
| 節點群組（合併小節點為大節點） | 增加 UI 複雜度，先確認基本流程可用 |
| AI 輔助生成 | 核心價值是「錄製 + 分支」，AI 是加分項 |
| Storage State 優化 | 先讓每個測試從頭跑，確認正確性 |
| CI/CD 整合 | 匯出的 .spec.ts 本身就能接 CI，不需要工具處理 |
| 多瀏覽器支援 | 先只做 Chromium |
| 雲端同步 | 本地 JSON 檔案就夠 |
| 自動識別重複子流程 | 太複雜，先讓使用者自己判斷 |
