# Symbiosis 個人管理系統

Symbiosis 是以 React、TypeScript、Firebase 與 Netlify 建置的個人管理系統，整合投資帳務、知識庫與行事曆。正式站點為 [symbiosis-jiawei.netlify.app](https://symbiosis-jiawei.netlify.app/)。

## 主要功能

### 投資管理

- 買賣、股利、出入金、持倉、歷史損益與年度復盤。
- 台股現股、零股、ETF 與融資交易的費稅、成本及收付計算。
- 同帳戶、同日、同股票的現股整張交易自動判定當沖；支援部分當沖、先賣後買與人工例外處理。
- 券商月結單 PDF／圖片本機辨識，核對股數、現金、融資償還與費稅差異。
- 資料健康中心、JSON 備份還原、CSV 匯入匯出與組合水位試算。

### 知識庫

- 富文字筆記、階層標籤、反向連結、知識圖譜、垃圾桶及匯出。
- Firestore／Storage 規則、UID 遷移與附件稽核工具。

### 行事曆與任務

- 行事曆、任務與專案管理、每日重點及法說會關注清單。
- Google Calendar 同步與 Netlify Functions proxy。

詳細操作方式請參考 [系統操作手冊](docs/SYSTEM_MANUAL.md)，現股當沖規則請參考 [現股自動沖抵](docs/DAY_TRADES.md)。

## 本機開發

需求：Node.js 20.19 以上或 22.12 以上、npm，以及需要部署 Firebase 規則時使用的 Firebase CLI。

```bash
npm ci
npm run dev
```

若要同時測試 Netlify Functions，請改用：

```bash
npx netlify dev
```

## 環境變數

前端 Firebase 設定：

```text
VITE_INVEST_API_KEY
VITE_INVEST_AUTH_DOMAIN
VITE_INVEST_PROJECT_ID
VITE_INVEST_STORAGE_BUCKET
VITE_INVEST_MESSAGING_SENDER_ID
VITE_INVEST_APP_ID
VITE_KMS_API_KEY
VITE_KMS_AUTH_DOMAIN
VITE_KMS_PROJECT_ID
VITE_KMS_STORAGE_BUCKET
VITE_KMS_MESSAGING_SENDER_ID
VITE_KMS_APP_ID
```

目前部分前端功能另讀取 `VITE_FUGLE_API_KEY`、`VITE_GEMINI_API_KEY` 與 `VITE_GOOGLE_CLIENT_ID`。所有 `VITE_` 變數都會進入瀏覽器 bundle，不應存放可授予管理權限的秘密；將額度型 API 完整改為驗證後端 proxy 仍列在安全路線圖中。

Netlify Functions 使用：

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
NEWS_API_KEY
```

請將實際值設在本機 `.env` 或部署平台的環境變數中，不要提交憑證檔與金鑰。

## 驗證

```bash
npm test
npm run build
npm run lint
npm run test:kms-rules
```

- `npm test` 目前執行 122 項核心、財務矩陣、當沖與交易列表測試。
- `npm run build` 執行 TypeScript project build 與 Vite production build。
- 完整 ESLint 在 2026-09-01 的基線為 73 errors、10 warnings，尚未達到發布門檻；不要把 build 通過誤認為 lint 已通過。
- KMS rules 測試需要 Firebase emulator；正式資料遷移前另依 [KMS 遷移手冊](docs/KMS_MIGRATION.md) 操作。

## 部署

前端與 Netlify Functions：

```bash
npm run build
npx netlify deploy --prod --dir=dist
```

投資 Firestore 規則：

```bash
firebase deploy --only firestore:rules --config firebase.invest.json --project <invest-project-id>
```

KMS 規則與函式涉及跨 Firebase UID、正式資料遷移及計費方案。部署前必須完成備份、dry run 與 emulator 驗證，詳細順序請依 [KMS 遷移手冊](docs/KMS_MIGRATION.md) 與 [系統操作手冊](docs/SYSTEM_MANUAL.md) 執行。

## 文件索引

- [系統操作手冊](docs/SYSTEM_MANUAL.md)
- [現股自動沖抵](docs/DAY_TRADES.md)
- [KMS 遷移手冊](docs/KMS_MIGRATION.md)
- [優化路線圖](docs/OPTIMIZATION_ROADMAP.md)
- [系統稽核報告](docs/SYSTEM_AUDIT_2026-07-23.md)
- [版本紀錄](CHANGELOG.md)

## 目前已知待辦

- 停止在瀏覽器保存可解密的帳號密碼，並清除既有 `saved_accounts`。
- 確認投資與 KMS 正式環境規則、UID 遷移及排程函式部署狀態。
- 修正完整 ESLint 基線並建立自動執行 typecheck、lint、tests、rules tests 與 build 的 CI。
- 將額度型第三方 API 與 Google OAuth token 完整移到驗證後端。

完整優先順序以 [優化路線圖](docs/OPTIMIZATION_ROADMAP.md) 為準。
