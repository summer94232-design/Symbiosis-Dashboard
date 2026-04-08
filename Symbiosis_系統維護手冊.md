# 個人投資理財 & 知識管理系統 — 技術文件

版本 1.0 · 2026 年 4 月

---

## 1. 系統概覽

本系統是一套整合「投資追蹤」與「個人知識管理」的全端 Web 應用，採用 React + TypeScript 前端、Firebase 後端（Firestore + Storage），並串接 Fugle 行情 API 及 Google Gemini AI。整體介面採深色主題，主要分為三大模組：

| 模組 | 子功能數 | 主要技術 | 說明 |
|------|----------|----------|------|
| 投資理財（Invest） | 9 個頁面 | Firebase / Fugle / Recharts | 股票持倉、交易、損益、現金流、行事曆 |
| 知識管理（KMS） | 5 個頁面 | Firebase / Gemini AI / mammoth | 筆記、標籤、知識圖譜、垃圾桶 |
| 行事曆（Calendar） | 2 個頁面 | Firebase / MOPS Proxy | 財經事件、待辦任務 |

---

## 2. 技術架構

### 2.1 前端框架

- React 18 + TypeScript — 所有頁面皆為函式元件（Function Component），使用 Hooks 管理狀態
- React Router v6 — SPA 路由，路徑規則見第 3 節
- Recharts — 折線圖、圓餅圖（資產走勢、持倉比例）
- lucide-react — 統一圖示庫
- mammoth — 瀏覽器端 .docx 文字萃取（KMS 文件上傳）

### 2.2 後端服務（Firebase）

系統使用兩組 Firebase 實例，透過 `lib/firebase.ts` 分別初始化：

| 實例變數 | 用途 | 包含服務 |
|----------|------|----------|
| investDB | 投資模組資料庫 | Firestore（trades, dividends, cashflow, settings, calendarEvents, tasks, calendarWatchList, assetSnapshots） |
| kmsDB | KMS 模組資料庫 | Firestore（notes） |
| kmsStorage | KMS 檔案儲存 | Firebase Storage（images/, files/ 目錄） |

### 2.3 外部 API

| API | 用途 | 呼叫位置 |
|-----|------|----------|
| Fugle 行情 API | 取得台股即時報價（getMultipleQuotes） | Holdings.tsx, Dashboard.tsx, Watchlist.tsx |
| Google Gemini AI | AI 自動標籤（generateHashtags）+ AI 找相關筆記（findRelatedNotes） | KMSHome.tsx |
| MOPS Proxy（Netlify Function） | 查詢法人說明會日期，路徑：/.netlify/functions/mops-proxy | CalendarHome.tsx |

---

## 3. 路由結構

| 路徑 | 元件檔案 | 說明 |
|------|----------|------|
| /dashboard | Dashboard.tsx | 投資總覽儀表板（首頁） |
| /invest/holdings | Holdings.tsx | 股票持倉明細 |
| /invest/trades | Trades.tsx | 買賣交易紀錄 |
| /invest/dividends | Dividend.tsx | 股息 / 配股紀錄 |
| /invest/cashflow | CashFlow.tsx | 現金流入出紀錄 |
| /invest/asset-trend | AssetTrend.tsx | 資產走勢快照 |
| /invest/history-pnl | HistoryPnL.tsx | 歷史損益查詢 |
| /invest/watchlist | Watchlist.tsx | 觀察名單 |
| /invest/settings | InvestSettings.tsx | 投資模組設定 |
| /invest/year-review | YearReview.tsx | 年度投資回顧 |
| /calendar | CalendarHome.tsx | 財經行事曆 |
| /calendar/tasks | TaskManager.tsx | 待辦任務管理 |
| /calendar/daily-brief | DailyBrief.tsx | 每日簡報 |
| /kms | KMSHome.tsx | KMS 筆記主頁 |
| /kms/graph | KMSGraph.tsx | 知識圖譜視覺化 |
| /kms/tags | KMSTags.tsx | 標籤管理 |
| /kms/export | KMSExport.tsx | 匯出筆記 |
| /kms/trash | KMSTrash.tsx | 筆記回收桶 |

---

## 4. 模組功能詳細說明

### 4.1 Dashboard — 投資總覽儀表板

檔案：`Dashboard.tsx` 路由：`/dashboard`

**功能說明**

- 從 Firestore 讀取 trades、dividends、cashflow 三個 collection，計算持倉與可用現金
- 從 `settings/lastPrices` 讀取快取股價，計算各股未實現損益與市值佔比
- 圓餅圖（Recharts PieChart）顯示資產配置，含股票持倉 + 現金
- 「更新現價」按鈕呼叫 Fugle API，將結果寫回 `settings/lastPrices`（全系統共用）
- 下方卡片顯示「近 14 天行程」（來源：calendarEvents collection）
- 下方卡片顯示「待辦任務」（來源：tasks collection），依逾期 / 今日 / 未來分群，可直接勾選完成

**Firestore Collections 使用**

| Collection | 操作 | 說明 |
|------------|------|------|
| trades | 讀取（orderBy date） | 計算持倉成本與股數 |
| dividends | 讀取（orderBy date） | 計算已實現損益（含股利） |
| cashflow | 讀取 | 計算可用現金 |
| settings/lastPrices | 讀取 + 寫入 | 快取股票現價，鍵值 = 股票代號，_updatedAt = 更新時間 |
| calendarEvents | 讀取 | 個人行程（篩選今日 +14 天） |
| tasks | 讀取 + 更新 done 欄位 | 待辦任務 |

**資料計算邏輯**

- 持倉計算：`calcPositions(trades, dividends)` — 來自 `lib/calc.ts`
- 可用現金：`calcAvailableCash(trades, cashflow)` — 賣出所得 + 現金流入 - 買入支出 - 現金流出
- 未實現損益：（現價 × 股數）- 總成本；現價為 null 時顯示「—」
- 市值佔比（ratio）：各股市值 / 總市值 × 100%，現金單獨計算

---

### 4.2 Holdings — 股票持倉明細

檔案：`Holdings.tsx` 路由：`/invest/holdings`

- 顯示所有未賣出股票的持倉明細，欄位：代號、名稱、股數、均價（含手續費）、現價、成本、市值、未實現損益、報酬率
- 股票股利（配股）會增加股數並攤薄均價，成本保持不變
- 頂部四格統計卡：總市值、總成本、未實現損益、整體報酬率
- 「更新現價」按鈕：呼叫 getMultipleQuotes，寫入 `settings/lastPrices`，與 Dashboard 共享快取
- 現價顏色：高於均價顯示綠色（#00c896），低於均價顯示紅色（#ff5757）
- 持倉按市值降冪排序

---

### 4.3 Trades — 買賣交易紀錄

檔案：`Trades.tsx` 路由：`/invest/trades`

**資料結構（Trade）**

| 欄位 | 型別 | 說明 |
|------|------|------|
| date | string (YYYY-MM-DD) | 交易日期 |
| type | 'buy' \| 'sell' | 買入或賣出 |
| code | string | 股票代號 |
| name | string | 股票名稱 |
| price | number | 成交均價 |
| shares | number | 股數（零股支援，< 1000 視為零股） |
| fee | number | 手續費（自動計算，零股時不打折） |
| tax | number | 證交稅（賣出才有，ETF 稅率 0.1%） |
| total | number | 實際支出 / 入帳金額 |
| note | string | 備註 |

**主要功能**

- 新增 / 編輯 / 刪除交易紀錄，手續費與稅金自動計算
- CSV 批次匯入：支援引號包裹欄位、欄位內含逗號（如 "1,000"），解析後自動帶入表單確認
- 搜尋：支援代號 / 名稱 / 備註關鍵字篩選
- 收合 / 展開個別股票的交易明細（AccordionRow 元件）
- 費用計算：`calcFee()`、`calcTax()`、`isETF()` — 來自 `lib/calc.ts`

**CSV 匯入格式**

標準欄位順序（逗號分隔，第一行為標題行，會自動略過）：
```
日期, 類型(buy/sell), 代號, 名稱, 價格, 股數, 手續費, 稅金, 合計, 備註
```

---

### 4.4 Dividend — 股息 / 配股紀錄

檔案：`Dividend.tsx` 路由：`/invest/dividends`

| 欄位 | 型別 | 說明 |
|------|------|------|
| date | string | 除權息日（YYYY-MM-DD） |
| code | string | 股票代號 |
| name | string | 股票名稱（自動從 trades 建立字典） |
| cashDividend | number | 現金股利（元） |
| stockDividend | number | 股票股利（股數） |
| note | string | 備註 |

- `stockDividend > 0` 時，Holdings 頁面會自動加入股數並攤薄均價
- `cashDividend` 計入 `calcPositions` 的已實現損益
- 股票名稱字典從 trades collection 自動建立，新增時自動填入名稱

---

### 4.5 CashFlow — 現金流紀錄

檔案：`CashFlow.tsx` 路由：`/invest/cashflow`

- 紀錄現金流入（入金）/ 流出（出金），例如：薪資轉入帳戶、提領現金
- type 欄位：`in`（流入）/ `out`（流出）
- 可用現金 = 所有 in 金額 - 所有 out 金額 + 賣出所得 - 買入支出
- 在 Dashboard 透過 `calcAvailableCash()` 函式統一計算

---

### 4.6 AssetTrend — 資產走勢

檔案：`AssetTrend.tsx` 路由：`/invest/asset-trend`

**快照（Snapshot）機制**

- 使用者手動或自動儲存某一日的資產快照（totalAssets、marketValue、cash）
- 快照存入 Firestore `assetSnapshots` collection，以 date 為文件 ID
- 折線圖（LineChart）呈現資產走勢，X 軸為日期，Y 軸為金額
- 「一鍵快照」功能：自動從當前持倉計算 marketValue + cash，填入表單
- 可手動新增、編輯（Pencil 圖示）、刪除快照資料點

**Firestore Collection：assetSnapshots**

| 欄位 | 型別 | 說明 |
|------|------|------|
| date | string (YYYY-MM-DD) | 快照日期（文件 ID） |
| totalAssets | number | 總資產 = marketValue + cash |
| marketValue | number | 股票市值 |
| cash | number | 現金 |

---

### 4.7 HistoryPnL — 歷史損益

檔案：`HistoryPnL.tsx` 路由：`/invest/history-pnl`

- 顯示所有已實現損益紀錄（完整賣出後結算）
- 來源：`calcPositions()` 回傳的 realized 陣列，每筆包含：股票代號、名稱、實現損益金額
- 統計總已實現損益（含股利），提供年度 / 個股篩選

---

### 4.8 Watchlist — 觀察名單

檔案：`Watchlist.tsx` 路由：`/invest/watchlist`

- 管理「尚未持有但有興趣追蹤」的股票
- Firestore collection：`calendarWatchList`，欄位 `code`（股票代號）
- 觀察名單的股票會出現在行事曆的「法說會」查詢範圍中（CalendarHome）
- 可呼叫 Fugle API 更新觀察股票的現價，僅顯示不寫入持倉

---

### 4.9 InvestSettings — 投資設定

檔案：`InvestSettings.tsx` 路由：`/invest/settings`

- 設定 Fugle API Key 等個人化參數，儲存於 Firestore `settings` collection
- 可清除快取股價（刪除 `settings/lastPrices`）

---

### 4.10 YearReview — 年度回顧

檔案：`YearReview.tsx` 路由：`/invest/year-review`

- 彙整指定年度的所有投資數據：已實現損益、現金股利、股票股利
- 計算年度總報酬、交易次數、股息收入等摘要統計

---

### 4.11 CalendarHome — 財經行事曆

檔案：`CalendarHome.tsx` 路由：`/calendar`

**事件類型（type）**

| 類型 | 顏色 | 來源 |
|------|------|------|
| fomc | 紅色 #ff5757 | 硬編碼常數 FOMC_DATES（lib/calendarData.ts） |
| futures | 橘色 #f5a623 | getFuturesSettlementDates()，每月第三週三計算 |
| tech | 藍色 #4f8ef7 | 硬編碼常數 TECH_EVENTS（蘋果、Google、Meta 等財報日） |
| investor | 綠色 #00c896 | MOPS Proxy API 即時查詢，依持倉 + 觀察名單 |
| personal | 紫色 #a78bfa | 使用者自行新增，存入 calendarEvents collection |
| dividend | 黃色 #f5a623 | 從 dividends collection 轉換，自動顯示除權息日 |

**功能**

- 月曆格 — 每格最多顯示 3 個事件，多餘顯示「+N 更多」
- 點擊日期 — 右側滑出事件詳情面板，個人行程可刪除
- 篩選器 — 可切換各類事件的顯示 / 隱藏
- 「更新法說會」按鈕 — 重新呼叫 MOPS Proxy，按月份查詢
- 待辦任務（有截止日且未完成）也會顯示在行事曆上

---

### 4.12 TaskManager — 待辦任務

檔案：`TaskManager.tsx` 路由：`/calendar/tasks`

**資料結構（Task）**

| 欄位 | 型別 | 說明 |
|------|------|------|
| id | string | Firestore 文件 ID |
| title | string | 任務標題 |
| done | boolean | 是否完成 |
| dueDate | string (optional) | 截止日（YYYY-MM-DD） |
| priority | 'high' \| 'medium' \| 'low' | 優先級（高 / 中 / 低） |
| order | number | 自訂排序序號 |

- 支援拖曳排序（order 欄位），或手動上下移動
- 優先級色碼：高 = 紅色（#ff5757），中 = 橘色（#f5a623），低 = 綠色（#00c896）
- Dashboard 與 CalendarHome 共同讀取此 collection
- 完成的任務可在 TaskManager 中恢復或永久刪除

---

### 4.13 DailyBrief — 每日簡報

檔案：`DailyBrief.tsx` 路由：`/calendar/daily-brief`

- 整合今日行事曆事件 + 今日到期任務 + 持倉損益摘要，生成每日一頁簡報視圖
- 適合每日開盤前快速瀏覽當日重點

---

### 4.14 KMSHome — 知識管理筆記主頁

檔案：`KMSHome.tsx` 路由：`/kms`

**筆記資料結構（Note）**

| 欄位 | 型別 | 說明 |
|------|------|------|
| id | string | Firestore 文件 ID |
| title | string | 筆記標題（必填） |
| content | string | 文字內容 |
| type | 'note' \| 'url' \| 'image' \| 'file' | 筆記類型 |
| url | string (optional) | URL 類型的網址 |
| imageUrl | string (optional) | 圖片 Storage URL |
| fileUrl | string (optional) | 文件 Storage URL |
| fileName | string (optional) | 原始檔名 |
| hashtags | string[] | AI 或手動標籤陣列 |
| links | string[] | 雙向連結的筆記 ID 陣列 |
| createdAt | string (ISO) | 建立時間 |
| updatedAt | string (ISO) | 最後更新時間 |

**主要功能**

- 四種筆記類型：文字筆記、URL 收藏、圖片、文件（支援 .docx 自動解析文字）
- AI 自動標籤（generateHashtags）：呼叫 Google Gemini，根據內容建議 hashtag，並參考既有標籤保持一致性
- AI 自動找相關筆記（findRelatedNotes）：Gemini 分析所有筆記，找出語意相關的筆記 ID
- 雙向連結（Bidirectional Links）：A → B 時，B 也會儲存反向連結至 A，保持一致性
- 搜尋：標題 + 內容 + hashtag 全文模糊搜尋
- 排序：建立時間 / 更新時間 / 標題，支援升降冪切換
- 內容展開 / 收合：超過 150 字元自動截斷，點選「展開全文」顯示完整
- URL 導向參數（`?note=ID`）：支援從其他頁面直接跳轉並自動捲動至指定筆記

**圖片 / 文件上傳流程**

- 上傳至 Firebase Storage：`images/{timestamp}_{filename}` 或 `files/{timestamp}_{filename}`
- 取得 Download URL 後存入 imageUrl / fileUrl 欄位
- .docx 文件：使用 `mammoth.extractRawText()` 在瀏覽器端解析文字，存入 content 欄位

---

### 4.15 KMSGraph — 知識圖譜

檔案：`KMSGraph.tsx` 路由：`/kms/graph`

- 以 Canvas 繪製 Force-directed Graph，節點為筆記（藍色）與標籤（綠色/橘色）
- 邊（Edge）代表：筆記 ↔ 標籤（hashtag 關聯）、筆記 ↔ 筆記（雙向連結）
- 物理模擬：節點互斥（repulsion）+ 邊吸引（spring）+ 中心重力（gravity）
- 互動：拖曳節點、點擊節點顯示筆記摘要，點擊「前往筆記」跳轉至 `/kms?note=ID`
- 節點半徑依連結數量縮放（越多連結越大）

---

### 4.16 KMSTags — 標籤管理

檔案：`KMSTags.tsx` 路由：`/kms/tags`

- 顯示所有 hashtag 及其使用次數
- 點擊標籤可篩選 KMSHome 的筆記列表（透過 selectedTag Props 傳遞）
- 可重新命名標籤（批次更新所有含該標籤的筆記）
- 可刪除標籤（從所有筆記中移除）

---

### 4.17 KMSExport — 匯出

檔案：`KMSExport.tsx` 路由：`/kms/export`

- 匯出格式：Markdown（.md）或 JSON
- 可選擇匯出全部筆記或依標籤篩選
- Markdown 格式包含標題、內容、hashtag、連結、時間戳記

---

### 4.18 KMSTrash — 回收桶

檔案：`KMSTrash.tsx` 路由：`/kms/trash`

- 軟刪除機制：刪除的筆記標記 `deleted: true`，移入回收桶 collection 或以 deleted 欄位篩選
- 可還原筆記（restore）或永久刪除（permanent delete）
- 雙向連結在還原後自動重建

---

## 5. Firestore 資料庫結構

### 5.1 investDB — 投資資料庫

| Collection | 文件 ID 規則 | 主要欄位 | 說明 |
|------------|-------------|----------|------|
| trades | Firestore auto-ID | date, type, code, name, price, shares, fee, tax, total, note | 所有買賣交易紀錄 |
| dividends | Firestore auto-ID | date, code, name, cashDividend, stockDividend, note | 股息配股紀錄 |
| cashflow | Firestore auto-ID | type(in/out), amount, date, note | 現金流入出紀錄 |
| calendarEvents | Firestore auto-ID | title, date, type, description, url | 個人行程 |
| tasks | Firestore auto-ID | title, done, dueDate, priority, order, createdAt | 待辦任務 |
| calendarWatchList | Firestore auto-ID | code | 觀察名單股票代號 |
| assetSnapshots | date (YYYY-MM-DD) | date, totalAssets, marketValue, cash | 資產快照 |
| settings/lastPrices | 固定文件 ID: lastPrices | {股票代號: 現價, _updatedAt: 時間} | 快取股票現價 |

### 5.2 kmsDB — KMS 資料庫

| Collection | 文件 ID 規則 | 主要欄位 | 說明 |
|------------|-------------|----------|------|
| notes | Firestore auto-ID | title, content, type, url, imageUrl, fileUrl, fileName, hashtags, links, createdAt, updatedAt | 所有筆記 |

---

## 6. 共用函式庫（lib/）

### 6.1 lib/calc.ts — 計算核心

| 函式 / 型別 | 說明 |
|-------------|------|
| TradeRecord | 交易紀錄 interface（date, type, code, name, price, shares, fee, tax, total, note） |
| DividendRecord | 股息紀錄 interface（date, code, name, cashDividend, stockDividend） |
| calcPositions(trades, dividends?) | 計算持倉 Map 與已實現損益陣列；FIFO 成本法 |
| calcAvailableCash(trades, cashflow) | 計算可用現金 = 流入 - 流出 + 賣出 - 買入 |
| calcFee(price, shares, isOdd) | 計算手續費（0.1425%，最低 1 元，整股打折） |
| calcTax(price, shares, isETF) | 計算證交稅（賣出，ETF 0.1%，一般 0.3%） |
| isETF(code) | 判斷股票代號是否為 ETF（依命名規則） |

### 6.2 lib/firebase.ts — Firebase 初始化

- 初始化 investDB（投資 Firestore）、kmsDB（KMS Firestore）、kmsStorage（Storage）
- 分兩組 Firebase App 實例，各自獨立設定

### 6.3 lib/fugle.ts — 股票行情

- `getMultipleQuotes(symbols: string[])` — 批次查詢 Fugle API，回傳 `Record<string, number | null>`
- API Key 從 Firestore settings 讀取（或環境變數）

### 6.4 lib/gemini.ts — AI 功能

- `generateHashtags(content, title, existingTags)` — 呼叫 Gemini，回傳建議 hashtag 陣列（參考既有標籤）
- `findRelatedNotes(title, content, otherNotes)` — 呼叫 Gemini，回傳相關筆記 ID 陣列

### 6.5 lib/calendarData.ts — 財經日曆資料

- `FOMC_DATES` — FOMC 決議日期常數陣列（type: fomc）
- `TECH_EVENTS` — 科技公司財報 / 發表會日期（type: tech）
- `getFuturesSettlementDates(year, month)` — 計算期貨結算日（每月第三週三）
- `EVENT_COLORS` — 各 type 對應顏色 Map
- `EVENT_LABELS` — 各 type 對應中文標籤 Map
- `CalendarEvent` interface — `{ id, date, title, type, stockCode?, description?, url? }`

---

## 7. 樣式設計規範

### 7.1 色系

| 用途 | 顏色代碼 | 說明 |
|------|----------|------|
| 主色（藍） | #4f8ef7 | 按鈕、連結、股票代號、圖示 |
| 獲利（綠） | #00c896 | 正損益、低優先級、KMS URL 類型 |
| 警告（橘） | #f5a623 | 中優先級、今日行程、期貨結算日 |
| 虧損（紅） | #ff5757 | 負損益、高優先級、FOMC |
| 強調（紫） | #a78bfa | KMS 文件類型、個人行程 |
| 卡片背景 | #1a1d27 | 所有卡片元件背景 |
| 頁面背景 | #0f1117 | 整體頁面深色背景 |
| 邊框 | #2e3349 | 卡片、輸入框邊框 |
| 文字主色 | #e2e8f0 | 主要文字 |
| 文字次色 | #8892a4 | 說明文字、標籤 |

### 7.2 通用 CSS 樣式物件（各元件複製使用）

```typescript
const card: React.CSSProperties = {
  backgroundColor: '#1a1d27',
  border: '1px solid #2e3349',
  borderRadius: '12px',
  padding: '20px'
}

const inp: React.CSSProperties = {
  backgroundColor: '#0f1117',
  border: '1px solid #2e3349',
  borderRadius: '8px',
  padding: '8px 12px',
  color: '#e2e8f0',
  fontSize: '14px',
  width: '100%',
  outline: 'none',
  boxSizing: 'border-box'
}

const lbl: React.CSSProperties = {
  fontSize: '12px',
  color: '#8892a4',
  display: 'block',
  marginBottom: '4px'
}

const btn = (color: string): React.CSSProperties => ({
  backgroundColor: color,
  border: 'none',
  borderRadius: '8px',
  padding: '8px 16px',
  color: '#fff',
  fontSize: '14px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '6px'
})
```

### 7.3 響應式設計

- 使用 CSS Grid + @media query 實現響應式佈局
- 統計卡片：4 欄 → 2 欄（< 900px）→ 1 欄（< 480px）
- 字體大小使用 `clamp(min, vw, max)` 流體排版
- Padding 使用 `clamp(16px, 3vw, 32px)` 適應不同螢幕

---

## 8. 維護與擴充指南

### 8.1 新增頁面標準流程

1. 在對應模組目錄建立 `ComponentName.tsx`，匯出 `default function`
2. 在 `App.tsx`（或路由設定檔）新增 `<Route path="..." element={<ComponentName />} />`
3. 若需要 Firebase 讀取，從 `lib/firebase.ts` 匯入 `investDB` 或 `kmsDB`
4. 遵循 `card / inp / lbl / btn` 樣式規範，保持介面一致性
5. 統計型頁面先呼叫 `calcPositions()` 取得持倉，再組合其他資料

### 8.2 新增 Firestore Collection

- 直接在 Firebase Console 建立，或在元件中使用 `addDoc` / `setDoc` 自動建立
- 若為投資相關，使用 `investDB`；KMS 相關使用 `kmsDB`
- Collection 命名採 camelCase（如 `assetSnapshots`）
- 若有排序需求，記得在 Firebase Console 建立複合索引（orderBy 多欄位時需要）

### 8.3 更新行事曆財經事件

- FOMC 日期 / 科技事件：修改 `lib/calendarData.ts` 的 `FOMC_DATES` 和 `TECH_EVENTS` 陣列
- 格式：`{ id: "fomc-YYYYMMDD", date: "YYYY-MM-DD", title: "事件名稱", type: "fomc" }`
- 期貨結算日由 `getFuturesSettlementDates()` 自動計算，無需手動更新

### 8.4 現價快取機制說明

- 所有元件共用 `settings/lastPrices` 文件，不同頁面不會各自呼叫 API
- 只有 Holdings 和 Dashboard 的「更新現價」按鈕會寫入 `settings/lastPrices`
- `_updatedAt` 欄位為字串格式（zh-TW Locale），用於 UI 顯示
- 如需清除快取，刪除或覆蓋 `settings/lastPrices` 文件即可

### 8.5 雙向連結維護邏輯

- 新增筆記時：對每個被連結的筆記，更新其 links 陣列加入新筆記 ID
- 編輯筆記時：計算 `addedLinks` / `removedLinks` 差異，分別更新被影響筆記
- 刪除筆記時：遍歷所有連結，從對方的 links 陣列中移除此筆記 ID
- 此邏輯集中在 `KMSHome.tsx` 的 `handleSave()` 和 `handleDelete()` 函式

### 8.6 常見問題排查

| 問題 | 可能原因 | 解法 |
|------|----------|------|
| 現價顯示「—」 | settings/lastPrices 無此股票或未更新 | 點「更新現價」按鈕 |
| 法說會不更新 | MOPS Proxy Netlify Function 未部署 | 確認 .netlify/functions/mops-proxy 存在 |
| AI 標籤功能失敗 | Gemini API Key 未設定 | 確認 lib/gemini.ts 中的 API Key |
| Firebase 寫入失敗 | Firestore 安全規則拒絕 | 確認 Firebase Console 中的 Rules |
| 圖片上傳失敗 | Storage CORS 或權限問題 | 確認 Firebase Storage Rules 與 CORS 設定 |
| CSV 匯入解析錯誤 | 欄位順序不符或編碼問題 | 確認檔案為 UTF-8，欄位順序符合第 4.3 節規格 |

---

## 9. 給 AI 助理的溝通提示（快速導引）

### 9.1 每次對話建議附上的系統說明

```
我有一套 React + TypeScript + Firebase 的個人投資理財與知識管理系統。
前端使用 Recharts 圖表、lucide-react 圖示。
後端為兩組 Firebase 實例（investDB 投資資料、kmsDB 筆記資料）。
路由以 React Router v6 管理。
以下是我要請你協助的任務：
```

### 9.2 修改既有功能

- 「請修改 `Trades.tsx`，在 CSV 匯入時額外支援第 N 欄為手續費備註」
- 「請幫 `Holdings.tsx` 新增一個「市值 / 資產比」欄位，計算方式是 marketValue / totalAssets」
- 「`CalendarHome.tsx` 的法說會事件顏色改為紫色」

### 9.3 新增功能

- 「請在 `/invest/` 新增一個 `Rebalance.tsx` 頁面，根據各股目標比例計算需買賣數量」
- 「`KMSHome` 新增「釘選」功能，釘選筆記永遠顯示在列表頂部，Firestore 新增 `pinned` 欄位」

### 9.4 資料查詢

- 「Dashboard 是從哪些 Firestore collection 讀取資料的？」→ 參考第 4.1 節
- 「`settings/lastPrices` 的資料格式是什麼？」→ 參考第 5.1 節
- 「`calcPositions` 函式在哪個檔案？輸入輸出是什麼？」→ 參考第 6.1 節

---

## 10. 附錄

### 10.1 元件快速索引（含 Firestore 操作）

R = 讀取，W = 寫入，D = 刪除

| 元件 | 檔案 | 模組 | Firestore 操作 |
|------|------|------|----------------|
| Dashboard | Dashboard.tsx | 投資 | trades(R), dividends(R), cashflow(R), settings/lastPrices(R/W), calendarEvents(R), tasks(R/W) |
| Holdings | Holdings.tsx | 投資 | trades(R), dividends(R), settings/lastPrices(R/W) |
| Trades | Trades.tsx | 投資 | trades(R/W/D) |
| Dividend | Dividend.tsx | 投資 | dividends(R/W/D), trades(R) |
| CashFlow | CashFlow.tsx | 投資 | cashflow(R/W/D) |
| AssetTrend | AssetTrend.tsx | 投資 | assetSnapshots(R/W/D), trades(R), cashflow(R), settings/lastPrices(R) |
| HistoryPnL | HistoryPnL.tsx | 投資 | trades(R), dividends(R) |
| Watchlist | Watchlist.tsx | 投資 | calendarWatchList(R/W/D) |
| InvestSettings | InvestSettings.tsx | 投資 | settings(R/W/D) |
| YearReview | YearReview.tsx | 投資 | trades(R), dividends(R) |
| CalendarHome | CalendarHome.tsx | 行事曆 | calendarEvents(R/W/D), dividends(R), tasks(R), trades(R), calendarWatchList(R) |
| TaskManager | TaskManager.tsx | 行事曆 | tasks(R/W/D) |
| DailyBrief | DailyBrief.tsx | 行事曆 | calendarEvents(R), tasks(R), trades(R) |
| KMSHome | KMSHome.tsx | KMS | notes(R/W/D), Storage(W) |
| KMSGraph | KMSGraph.tsx | KMS | notes(R) |
| KMSTags | KMSTags.tsx | KMS | notes(R/W/D) |
| KMSExport | KMSExport.tsx | KMS | notes(R) |
| KMSTrash | KMSTrash.tsx | KMS | notes(R/W/D) |

### 10.2 依賴套件清單

| 套件 | 用途 |
|------|------|
| react ^18 | 核心框架 |
| react-router-dom v6 | SPA 路由 |
| firebase ^10 | Firestore + Storage |
| recharts ^2 | 折線圖、圓餅圖 |
| lucide-react | 圖示庫 |
| mammoth ^1 | .docx 文字萃取 |
| @google/generative-ai | Gemini AI（lib/gemini.ts） |

---

*文件結束 · 如需更新請重新生成*
