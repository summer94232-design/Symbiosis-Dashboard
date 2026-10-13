# 法說會優先恢復 — v26.9.19.1（已部署，正式登入驗收通過）

使用者要求暫緩市場新聞，優先修復抓取法說會。本批延續同日待部署修改，版本不再遞增。

## 修改

- 僅 `authorizeApi(..., 'meetings')` 使用獨立 Firebase app `protected-meetings-api`。
- 保留既有 `API_FIREBASE_SERVICE_ACCOUNT` 與專案設定，由 Node crypto 簽 RS256 JWT，使用原生 fetch 向固定的 Google OAuth token URL 交換 access token。使用 identitytoolkit scope，JWT 一小時內有效，交換有 10 秒逾時、禁止 redirect。
- 成功 token 仍由 FirebaseApp 管理快取／刷新；同時交換共用請求，失敗可重試。回應必須有有效 token、Bearer type 及合理期限。
- 保留 `verifyIdToken(token, true)`、白名單與 Firestore quota，沒有允許匿名存取、停用撤銷檢查或修改 IAM。
- 使用原 certificate 的獨立衍生物件，保留 Firestore 辨識所需的 certificate identity 與欄位；不修改 Firebase 快取的 cert 物件。新聞和其他 route 維持原憑證交換路徑。
- 固定錯誤分類透過既有安全診斷回傳，不附原始 Google 回應、簽名 JWT、私鑰或 access token。

## 驗證與限制

- RSA fixture 測試驗證 JWT 簽章、issuer、scope、audience、有效期、交換參數、併發／SDK 快取、失敗可重試及敏感資料不外洩。
- 真正 Firebase SDK 可接受此 credential、取得快取 token，Firestore client 初始化正常。這些測試使用合成 OAuth 回應，不代表正式憑證已可使用。
- 路由測試確認只有 meetings 改走新路徑，新聞保持原路徑；撤銷 token 為 401、非白名單為 403，失敗不扣配額。
- 唯讀測試 Yahoo 公開頁面：HTTP 200，解析出 69 筆、代號／日期格式有效。測試授權為 fixture，不寫入任何使用者資料。
- 用臨時產生、沒有權限的測試帳號連接實際 Google token URL，得到預期的 oauth-grant-rejected，證明新交換流程可到達 Google。
- 正式故障的最底層原因仍未知。本次是替換失敗路徑的修正方案，不宣稱已證明原 SDK 有缺陷；若正式私鑰本身不匹配或正式執行環境另有故障，部署後仍可能需要處理。沒有以未知原因為由直接換金鑰或擴權。

參考 Google 官方服務帳號 OAuth 規格：https://developers.google.com/identity/protocols/oauth2/service-account

## 發布

本機完成結果：npm test 452 項通過；npm run lint、npm run build、兩個後端檔案的 node --check 均通過。build 僅保留既有大型 chunk 提示。

使用者於本批明確批准後，已部署至正式站。部署 ID：6aad8126bef698564654e725；上一版：6aad3d61a66ab6d4a2ad15ef。正式入口與版本一致，12 項匿名／無效 token 檢查均回傳 401，原有 production lock 已恢復。正式站已登入帳號執行「抓取法說會」成功：畫面顯示「Yahoo 法說會更新完成：抓到 69 筆，更新 46 組個人資料；全域資料未被修改」。已完成來源讀取與個人資料寫入的線上驗收。市場新聞依使用者指示暫緩，本機空白預覽也維持暫緩。


