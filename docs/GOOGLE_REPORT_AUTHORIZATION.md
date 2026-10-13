# Google 行事曆與報告來源共用授權

報告來源採用使用者選定的方案 A：Google Drive API 搜尋同名新表，再由 Sheets API 讀取報告。這批只處理共用授權；搜尋、報告解析及儀表板卡片另行實作。

## 授權與帳號

- 沿用原本 OAuth client、callback `/google-calendar-auth` 及行事曆設定頁。
- Google 帳號由 `netlify/lib/google-authorization.js` 的 `GOOGLE_ACCOUNT_EMAIL` 指定。
- 保留 `calendar` 權限，新增 `spreadsheets.readonly`、`drive.metadata.readonly`、`openid`、`email`。不請求 Drive 檔案內容讀取或試算表寫入。
- `login_hint` 只作為帳號提示；後端使用 Google userinfo 核對實際 Email、已驗證狀態與帳號 ID，並檢查實際授予的三項資料權限。
- Google OAuth 與系統 Firebase 登入是不同的身分。授權完成必須回到原本的 Firebase UID 與登入時段。

## 安全保存與升級

OAuth callback 不把 Google token 放在返回網址。驗證結果暫存於 Admin-only 的 `googleOAuthPending` 文件，由原瀏覽器以 Firebase 登入身分完成領取，後端才儲存至既有 `users/{uid}/settings/googleCalendarAuth`。

成功升級保留 `calendarId`、既有同步標籤及其他設定，並增加 `googleEmail`、`googleAccountId`、`grantedScopes`。拒絕權限、錯選帳號或授權失敗不取代原連線。舊連線仍可使用原有行事曆同步；新增的報告權限顯示「尚未授權」，須按「補充報告授權」。取消連結會停用共用連線。

## 正式使用步驟

1. 先取得本批部署同意，再發布程式。
2. 在同一 Google Cloud 專案確認 Google Sheets API、Google Drive API 已啟用，OAuth consent 設定允許上述 scopes。變更正式設定仍須遵守專案部署同意規則。
3. 開啟「行事曆 → 設定」，按「補充報告授權」或「連結 Google 帳號」。
4. 選擇指定帳號，允許行事曆、試算表唯讀及檔案中繼資料搜尋。
5. 返回頁面後核對「連結帳號」、「試算表唯讀：已授權」及「報告檔案搜尋：已授權」，並確認行事曆仍使用原有同步選項。

Google 同意畫面完成與程式測試通過是不同驗證。本機 fixture 不連線到 Google、不建立真實授權，也不能證明正式 Cloud API 設定已完成。

## 本機驗證

`tests/google-security.test.mjs` 覆蓋實際授權範圍、錯選帳號、權限缺漏、callback 防重播、授權途中另開請求、Firebase 帳號或登入時段切換、後端保存及原行事曆設定保留。

`tests/browser/google-authorization.html` 提供未連結、舊連線、已升級、callback 成功及拒絕權限的隔離測試頁，只由 browser-test Vite 設定載入；不包含在 production build。

參考：[Google OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)、[Google userinfo 與帳號識別](https://developers.google.com/identity/openid-connect/openid-connect)、[Drive 檔案搜尋](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)。
