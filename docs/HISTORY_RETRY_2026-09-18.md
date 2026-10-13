# 歷史行情與授權修正 — v26.9.18.2（尚未部署）

本次是同一批待部署修正的延續，維持 v26.9.18.2。

- Google 授權入口由後端 GOOGLE_CLIENT_ID 建立網址；前端不再需要 VITE_GOOGLE_CLIENT_ID。重新授權保留 calendarId 與使用者選擇的同步類別。
- 歷史行情最多 4 個進行中的工作，相同代號與日期區間的進行中查詢共用請求。所有歷史呼叫與現價保守共用本分頁的 55 次／61 秒窗口；這不是跨分頁或跨裝置的全域限流，也不代表已確認供應商跨端點共用額度。
- 每次網路請求 10 秒逾時；網路錯誤／5xx 最多重試一次，429 依 Retry-After 或 61 秒等待，超過兩分鐘的等待直接提示額度不足。401／403／404 不自動重試。
- 回應格式異常與真正空資料分開；結果依日期排序，失敗不快取為空資料。
- 觀察清單 MA／線圖各使用 3 個 worker，顯示失敗代號與原因、空資料及排隊提示；finally 解除 loading，防止同一操作重複觸發。
- 賣出卡片提供重試，失敗後收合再展開也會重查；顯示歷史行情的具體錯誤。
- 沒有改用 TWSE 日資料冒充完整歷史 K 線，沒有修改帳務或績效快照。

## 新聞診斷

使用者提供正式版 v26.9.18.1 截圖：news-proxy HTTP 503，安全錯誤碼 app/invalid-credential。
此錯誤由 authorizeApi 的 verifyIdToken(token, true) 捕捉，發生在抓取新聞前。
本機 firebase-admin/lib/app/firebase-app.js 顯示：服務帳號換取 Google OAuth2 access token 失敗會被包裝為此錯誤；底層原因可能是金鑰、OAuth 回應、連線等，不能僅以此碼認定必須新增 IAM 權限或更換金鑰。

目前沒有正式服務帳號原始憑證或該次 SDK cause，尚未證實根因與修復。下一步應在受控的正式環境檢查現有 API_FIREBASE_SERVICE_ACCOUNT 能否取得 access token，僅記錄允許的錯誤分類、不输出私鑰、token 或完整 OAuth 回應。若確認需更新設定／金鑰，先提出明確變更供使用者批准。保留撤銷檢查、白名單及用量檢查。

## 驗證範圍

回歸案例涵蓋歷史查詢併發、共用窗口、去重、429 等待、長時間額度拒絕、永久錯誤、逾時、缺金鑰、資料驗證、排序、重試以及 MA／線圖部分失敗的 UI 狀態。Google 真實帳號 OAuth 與正式新聞恢復仍需部署後驗證。

本機結果：npm test 411 項通過、npm run lint 與 npm run build 通過；build 僅有既有大型 chunk 提示。本次修改檔案的 diff whitespace 檢查通過。尚未部署，未調整正式環境設定。

## 同批追加：新聞憑證安全診斷（待部署）

`netlify/lib/api-access.js` 的 authenticationDiagnostic 檢視最多 5 層 SDK cause，優先辨識底層錯誤。只讀取受限長度的訊息、錯誤碼與 OAuth 錯誤欄位；不序列化原始 SDK 錯誤、不輸出 response／request config／私鑰／token／UID。回傳與日誌的 SDK code、原因均為固定允許清單，未知值輸出 unknown／unclassified。

503 的文字格式為 `驗證服務憑證無法使用，請聯絡管理者（app/invalid-credential；jwt-signature-invalid）`；既有 authenticatedFetch 與新聞錯誤畫面可直接呈現，不需新增公開診斷端點。

| 原因代碼 | 後續檢查方向（不代表已修復） |
| --- | --- |
| jwt-signature-invalid | 核對服務帳號與金鑰配對、金鑰是否有效 |
| jwt-time-invalid | 檢查 JWT 時間與執行環境時間 |
| service-account-disabled | 核對服務帳號是否停用 |
| oauth-client-disabled / oauth-client-deleted / oauth-client-invalid | 核對 OAuth 憑證狀態及設定 |
| oauth-client-unauthorized / oauth-scope-invalid | 核對 OAuth 授權方式及 scope |
| oauth-grant-rejected | Google 拒絕 grant，但原因仍不夠具體；不能直接斷言金鑰失效 |
| network-dns / network-timeout / network-connection | 檢查 Google token 服務的 DNS、連線與逾時 |
| upstream-unavailable | 上游回傳 5xx |
| permission-denied | SDK 明確回傳 auth/insufficient-permission |
| unclassified | 尚不能分類；不把原始敏感錯誤直接公開 |

Firebase 對 invalid_grant 附加的通用排錯說明不會被判為已確定的時間或撤銷問題。登入 token 失效仍回 401；撤銷檢查、白名單、配額和 API 快取順序維持原狀。驗證失敗不讀新聞快取、不扣配額、不呼叫新聞來源。

這是診斷能力更新，尚未取得正式環境的上述分類結果，並非宣告新聞已修復。版本維持同批 v26.9.18.2；待使用者批准部署後再用真實登入重現。

追加驗證：完整 npm test 433 項通過，npm run lint、npm run build 與後端 JS 語法檢查通過。新增 22 項測試涵蓋固定分類、SDK 原因優先序／通用提示不誤判、循環 cause、防洩漏、401 維持、前端訊息傳遞及 news handler 在驗證失敗時不存取來源或快取。build 保留既有大型 chunk 提示。未部署或修改正式設定。

## 本機預覽修正

純 Vite preview 的 SPA fallback 將 /.netlify/functions/news-proxy 回傳為 HTML，造成 Unexpected token '<'。authenticatedFetch 現在辨識 HTML content type，改顯示需啟動 Netlify 後端的明確訊息。已啟動離線 Netlify Dev（dist + 本機 Functions，port 8888）；只載入本機設定，未讀取或修改正式憑證。

本機 news-proxy 實測：未登入為 JSON 401；測試 Bearer 因本機缺 API 安全設定回 JSON 503，皆不再回 HTML。預覽能驗證路由，但不能證明正式新聞恢復。完整測試增加至 434 項通過，前端建置通過。

## 使用者批准後部署

v26.9.18.2 已部署至 https://symbiosis-jiawei.netlify.app ，deploy ID `6aad3d61a66ab6d4a2ad15ef`。正式首頁版本與本機入口一致，96 個前端檔案通過憑證標記掃描，六個受保護 API 的未登入／無效 token 共 12 項均為 401。Google 授權入口回 302 至 Google、含有效的 client_id 與預期 callback。每日重點路由 HTTP 200，JS 入口與本機建置一致（平台處理後 HTML 全文不完全相同）。原部署鎖定已恢復。未修改正式環境變數、IAM 或 Firebase。

使用者後續回報 Yahoo 法說會 `app/invalid-credential；unclassified`，說明新診斷已生效但正式驗證故障仍在，不能認定新聞／法說會恢復。使用者要求暫緩本機空白預覽，保留此項未解決。
