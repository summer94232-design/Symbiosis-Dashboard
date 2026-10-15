# Symbiosis 個人管理系統

Symbiosis 是以 React、TypeScript、Firebase 與 Netlify 建置的個人管理系統，整合投資帳務、知識庫與行事曆。正式站點為 [symbiosis-jiawei.netlify.app](https://symbiosis-jiawei.netlify.app/)。

## 主要功能

### 投資管理

- 買賣、股利、出入金、持倉、歷史損益與年度復盤。
- 更新現價時在背景更新官方除權息預告；依持股試算資格，確認實領後入帳。現價採跨裝置額度控管，附加同步不阻塞報價結果。
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

`v26.10.16.1` 本機批次加入持股逐檔先顯示、跨頁背景快照及共用歷史快取／跨年分段；尚未部署。富邦歷史主源預設停用，待真實帳號權限與資料一致性驗證後才啟用，詳見 [本批設計與驗證](docs/QUOTE_PROGRESS_2026-10-16.md)。

目前正式版本：`v26.10.6.2`。已發布報價代理等待時間修正、每日快照趨勢模式及新帳號授權；一般趨勢不再要求收盤確認，新保存的報價仍須當日有效。已核對正式資產、三個帳號的後端授權及十檔報價，詳見 [最新發布紀錄](docs/RELEASE_2026-10-06_v26.10.6.2.md)、[備份與還原](docs/SYSTEM_MANUAL.md#413-json-備份與還原操作)及 [故障處理](docs/SYSTEM_MANUAL.md#13-故障處理)。年度日程維持 Netlify 每週日台灣時間 08:00 自動檢查，除權息沒有新增排程。

年度資料最後成功時間及 A1–A11 UI 文字精簡已於先前發布上線。詳見 [更新時間顯示](docs/ANNUAL_STATUS_2026-09-30.md)與 [文字精簡修改紀錄](docs/UI_TEXT_CHANGES_2026-09-30.md)。B1–B7 維持原樣。

10/04–10/05 帳務與 AI 修正已隨前次 `v26.10.5.1` 上線，本次沿用。包含八項稽核問題、年度報酬分母，以及融資配股 FIFO 成本、舊分類修復受阻、全損回撤漏值、未來快照和重複期末快照等修正。保留原版配色、緊湊手機排版及隱藏的手動精確 TWR；詳見 [前次發布](docs/RELEASE_2026-10-06.md)、[八項修正複查報告](docs/AUDIT_RECHECK_2026-10-05.md)與 [10/04 修正報告](docs/AUDIT_FIXES_2026-10-04.md)。

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

前端另讀取公開 OAuth client ID `VITE_GOOGLE_CLIENT_ID`。所有 `VITE_` 變數都會進入瀏覽器 bundle；Fugle 與 Gemini 用量金鑰使用驗證後端，請勿再設為 `VITE_FUGLE_API_KEY` 或 `VITE_GEMINI_API_KEY`。

Netlify Functions 使用：

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
NEWS_API_KEY
FUGLE_API_KEY
GEMINI_API_KEY
API_FIREBASE_PROJECT_ID
API_ALLOWED_UIDS
API_FIREBASE_SERVICE_ACCOUNT
```

請將實際值設在本機 `.env` 或部署平台的環境變數中，不要提交憑證檔與金鑰。`API_*` 為共用身分驗證與額度設定；Fugle 報價及歷史資料需要伺服器端 `FUGLE_API_KEY`。本批只調整本機設定；正式環境須在取得部署同意後配置，並先輪替曾放入前端的舊 Fugle 金鑰。

正式發布使用 `npm run deploy:production -- --cli <官方 Netlify CLI 27.12.1 的 bin/run.js 路徑>` 先做唯讀預檢；取得本批同意後，再加入 `--publish --expected-deploy <目前正式部署 ID>`。固定程序自動附帶 Fugle 及其餘 19 項既有 Functions 覆寫，三個機密值使用 `--secret-env`，缺任何設定就停止；也核對 CLI 實際解析範圍、前端金鑰掃描、部署前狀態及部署鎖。不要使用省略覆寫的裸 `netlify deploy`。發布後仍須實際驗證登入後現價及 `IX0001` 歷史行情。

目前方案不支援持久設定自訂為 Functions-only，因此沿用單次 Functions 覆寫；不擴大到 builds／runtime、不升級方案。`npm run check:quote-deployment` 僅核對持久站台設定，不包含單次部署覆寫，故仍可能列出缺 Fugle；它不能單獨判定已部署函式是否缺金鑰。固定發布程序會合併其實際送出的覆寫後驗證，並僅輸出名稱／狀態。詳見 [2026-10-15 報價 503 查核](docs/QUOTE_DEPLOYMENT_2026-10-15.md)。

## 驗證

```bash
npm test
npm run build
npm run lint
npm run test:kms-rules
```

- `npm test` 涵蓋帳務、匯入還原、帳號隔離、KMS、行事曆、報價與函式測試，結束後另執行函式執行環境檢查；測試筆數以當次輸出為準。
- `npm run build` 先檢查函式執行環境，再執行 TypeScript project build 與 Vite production build。
- 2026-10-05 複查主要測試 804 項及 posttest 3／5／6 項全部通過；最後表單空值修正後，35 項聚焦測試、build 及 lint 再次通過，lint 零警告。build 的大型 chunk 提示仍需後續效能改善。測試範圍重疊，詳見複查報告。
- `npm run test:emulators` 檢查資料與規則的整合情境；本批 17 項全部通過，涵蓋帳號隔離、帳本、舊融資配股修復與超賣拒絕、KMS／Storage 及備份還原。`npm run test:kms-rules` 另提供 KMS 規則檢查。需要 Java 21 與 Firebase emulator；本批使用官方可攜式 JRE 加入該次命令的 PATH，沒有改全機設定。此結果不表示正式規則已部署。
- 正式資料遷移前另依 [KMS 遷移手冊](docs/KMS_MIGRATION.md) 操作；CI 定義見 `.github/workflows/data-safety-checks.yml`，workflow 存在不代表遠端執行已通過。

## 部署

每批修改先完成本機驗證，再取得使用者對該批的明確部署同意；以下是部署參考指令，不會自動執行。先前同意不授權後續批次。

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
- [2026-10-04 系統檢查與功能說明](docs/SYSTEM_REPORT_2026-10-04.md)
- [2026-10-04 修正與驗證結果](docs/AUDIT_FIXES_2026-10-04.md)
- [2026-10-05 八項修正的回歸複查](docs/AUDIT_RECHECK_2026-10-05.md)
- [現股自動沖抵](docs/DAY_TRADES.md)
- [KMS 遷移手冊](docs/KMS_MIGRATION.md)
- [優化路線圖](docs/OPTIMIZATION_ROADMAP.md)
- [系統稽核報告](docs/SYSTEM_AUDIT_2026-07-23.md)
- [版本紀錄](CHANGELOG.md)

## 目前已知待辦

- 停止在瀏覽器保存可解密的帳號密碼，並清除既有 `saved_accounts`。
- 確認投資與 KMS 正式環境規則、UID 遷移及排程函式部署狀態。
- 確認 CI 在遠端的執行結果，並完成正式環境驗證；本批本機 emulator 已通過。
- 在核准部署時配置 Fugle 後端金鑰、輪替舊金鑰，並完成真實行情／Google／AI 服務驗收。
- 追蹤尚無相容修補的上游依賴公告；正式依賴剩 4 個 moderate 相依項目，包含開發工具時另有 3 個 high 相依項目。詳見本批修正報告與原始 audit 結果。
- JSON 備份仍只有 Storage 圖片／附件引用；原檔需另外保存。每日快照仍依賴開啟系統。年度 FOMC／交割休假改由 Netlify 排程維護；尚未公布、來源格式改變或失敗時保留前次資料與缺年提醒。

完整優先順序以 [優化路線圖](docs/OPTIMIZATION_ROADMAP.md) 為準。
