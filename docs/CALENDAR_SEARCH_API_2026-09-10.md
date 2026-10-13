# 月曆、全文搜尋與 API 邊界（2026-09-10）

版本 `v26.9.10.1`。本批工作由 9/9 延續至 9/10，依實際修改日期更新版本；同一批的測試與重試不另加版次。本次沒有部署、沒有變更遠端設定、沒有存取正式帳務或使用正式 token。

## 月曆

- 各資料來源有獨立請求序號；過時月份的回應、已卸載頁面及已切換帳號的讀取不得覆蓋目前資料。
- 讀取失敗保留上次成功資料，按來源顯示錯誤與更新狀態，提供「重新讀取月曆」。視窗回到前景／網路恢復時重讀。
- 月曆接收 InvestSync 的更新；新增 calendarWatchList 與 investorMeetingOverrides 訂閱。當月共用法說會單獨訂閱，不因其他集合變更反覆拆裝監聽。
- 手動重讀同時重建失敗的訂閱。切帳號時清除尚未發送的刷新計時器，忽略已取消的舊監聽回呼。
- 訂閱會觀察 Firestore metadata。僅快取資料或有未確認寫入時不宣稱已即時同步；metadata-only 更新不重載整頁，避免形成刷新迴圈。

## 全文搜尋

- 搜尋仍涵蓋完整正文及富文字，不截斷文字以換取速度。
- 正規化文字預先整理，後續搜尋不再每次遍歷富文字 JSON。90 秒搜尋資料集快取加上最長 5 分鐘的逐筆文字索引，依摘要 updatedAt／graphRevision／舊正文版本判斷哪些筆記需重讀。
- 一般修改使搜尋資料集失效後，只重讀版本有變更的正文。缺少版本的舊資料保守重讀；已刪除筆記移出索引。
- 逐筆索引最多保留 4096 筆／8M 個 UTF-16 字元；只在記憶體中，沿用登入／登出快取清除機制。搜尋資料集仍需容納本次全體可搜尋文字，不宣稱整個頁面的記憶體有固定上限。
- 「重新搜尋全文」會連逐筆索引一起清除，可用於舊工具只修改正文、未更新摘要版本的情況。這类外部修改可能暫時受 5 分鐘逐筆快取及 90 秒資料集快取影響。
- 初次搜尋仍需讀取全部有效摘要與正文，每組最多 20 筆併發；本次沒有引入第三方索引服務或讀取附件二進位／OCR。大量資料首次搜尋成本仍存在。

## API 保護範圍與用量

已套用新聞、海外報價、股本、Yahoo 法說會、MOPS 查詢五個 Netlify 入口。Google OAuth 設計（F17）、直接於前端使用的其他供應商 API 憑證遷移，未列入本次完成範圍。

- 前端送出目前 investment Firebase 使用者的 ID token，後端使用 Admin SDK 驗證（包含撤銷／停用檢查），並比對伺服器端 UID 白名單。固定目的地且全程檢查起始登入 session。
- 不再把 CORS 當授權。受保護入口僅支援 GET；未登入 401、未授權 403、超額 429 並帶 Retry-After、設定／驗證／額度儲存不可用時 503。前端不自動重送額度請求。
- 用量以 investment Firestore 根集合 `apiUsage` 的 transaction 計算，每個路由有每使用者及全域計數；跨 serverless 執行個體共用。前端安全規則既有的預設拒絕會阻擋讀寫此集合，已用 emulator 驗證。每個使用者／路由固定一個文件，不逐日新增文件。
- 每日額度以 UTC 00:00 重置，即台北時間 08:00；分鐘採固定窗口，邊界前後可能各使用一份額度。失敗及快取命中的已授權請求也計數，不宣稱是供應商帳單的精確統計或免費限流。

| 路由 | 每使用者／分鐘 | 每使用者／日 | 全域／日 | 單位 |
|---|---:|---:|---:|---|
| news-proxy | 6 | 100 | 300 | 請求 |
| foreign-quote | 120 | 5000 | 10000 | 去重後股票代號數 |
| market-cap-proxy | 300 | 5000 | 10000 | 請求 |
| yahoo-calendar-proxy | 6 | 100 | 300 | 請求 |
| mops-proxy | 20 | 500 | 1000 | 請求 |

海外報價每請求最多 20 個代號、4 路併發、單個上游 5 秒逾時；股本最多 100 個代號。前端依上限分批並固定帳號。新增 type=chart 處理，修正原先選股走勢呼叫與後端只支援 quote 的不一致。新聞共用 5 分鐘、海外報價共用 1 分鐘的暖執行個體快取並合併同時請求；快取非跨個體共享，額度則跨個體共享。股本維持原有快取。

## 部署前必要設定

在 Netlify Functions 的伺服器環境設定下列欄位；不可使用 `VITE_` 前綴，不可放進 Git、前端或聊天訊息：

| 變數 | 內容 |
|---|---|
| `API_FIREBASE_PROJECT_ID` | investment Firebase 的專案 ID |
| `API_FIREBASE_SERVICE_ACCOUNT` | 同專案服務帳號 JSON（包括 project_id、client_email、private_key）；須具有使用者狀態查詢與 apiUsage 交易寫入所需權限 |
| `API_ALLOWED_UIDS` | 允許使用的 investment Auth UID，多個以逗號分隔；不是 KMS 專案 UID，也不是電子郵件 |

沿用原 `NEWS_API_KEY`；未設定該欄位時仍可使用另外兩個新聞來源。firebase-admin 已移入正式 dependencies，鎖定檔已同步。

可用 `node scripts/check-api-config.mjs` 對目前程序環境做只讀格式檢查；不會印出秘密或 UID。它不連線、不檢查 IAM、不證明遠端已部署。本次未檢查／設定遠端秘密；若遠端未具備上述設定，升級後 API 會明確拒絕請求，部署前須完成此設定及測試帳號驗收。

正式發布後需以專用測試帳號驗證允許／不允許 UID、失效 token、429 重試秒數、實際 provider 回應及 Firestore 權限。此次不以 mock 或 emulator 宣稱這些遠端驗收已完成。F16、F17、歷史帳務核對仍依使用者指示暫緩。

## 本次驗證

- 一般回歸測試：302 項通過，含新加入的讀取競爭、同步 metadata、索引重用、驗證拒絕、共用額度及 proxy 入口載入案例。
- Firestore／Storage Emulator：11 項通過，含 8 個並發 quota 請求只允許 6 個、其餘拒絕，以及前端無法讀取／清零計數。
- 隔離瀏覽器：已開月曆顯示模擬另一裝置新增資料；四類讀取故障保留舊行程，重試清除錯誤；正文關鍵字仍可命中。未操作正式帳號或網路。
- 正式建置與 lint 檢查通過；建置仍有原有大型 bundle 提示。

實作依據：[Firebase ID token 驗證](https://firebase.google.com/docs/auth/admin/verify-id-tokens)、[Admin SDK 設定](https://firebase.google.com/docs/admin/setup)、[Firestore 交易](https://firebase.google.com/docs/firestore/manage-data/transactions)。
