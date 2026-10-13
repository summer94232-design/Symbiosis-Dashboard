# Netlify 正式發布完成 — v26.9.11.3

目標站台：symbiosis-jiawei（92efe5a3-95a3-40fa-b7a1-8699cad458ef）。正式網址 https://symbiosis-jiawei.netlify.app 。

已發布正式部署 6aa400eff4b5f528bf5f233b，網址 https://symbiosis-jiawei.netlify.app 。部署包含前端及 Netlify Functions，正式入口 JavaScript 已確認包含 v26.9.11.3。原有部署鎖暫時解除以完成發布，完成後已恢復鎖定。

新版預覽部署 6aa3ffd5bd3e6d1ae6629228 未取得 production 機密，因此帶憑證的 API 請求會回覆 503；正式站台已確認可載入設定，無此缺少設定情形。

## 已完成 Firestore 設定

- tw-kms-jiawei：正式規則與本機一致。106 筆與 21 筆帳號索引皆 ready，分別有 16 與 13 份內容頁；壓縮 data 欄位的索引為空。
- stocksserver-45482：使用者明確批准將共用 investorMeetings 改為登入可讀、僅後端可寫後，已發布 firestore.invest.rules。個人 /users/{uid} 資料仍僅本人可讀寫。舊版直接寫共用法說會的流程將被拒絕；新版使用個人覆寫資料。

## 後端 API 設定

Netlify 已設定 API_FIREBASE_PROJECT_ID、API_ALLOWED_UIDS、API_FIREBASE_SERVICE_ACCOUNT，部署環境為 production，金鑰標記 is_secret=true。新版已發布並完成設定載入驗證。

使用者已批准新增專用服務帳號與後端機密設定。已建立 symbiosis-netlify-api 服務帳號及專用角色，僅含：datastore.databases.get、datastore.databases.getMetadata、datastore.entities.create、datastore.entities.get、datastore.entities.update、firebaseauth.users.get。不含部署、管理帳號或刪除權限；Firestore 權限作用於投資資料庫，並非只靠 IAM 限制單一計數文件。

Netlify 帳號 capabilities 確認 env_var_secrets=true、env_var_scopes=false。正式帳號白名單已唯讀確認兩個既有 UID 都存在於投資 Auth。先前失敗嘗試產生的金鑰均撤銷，成功設定使用新建金鑰。

使用者已另外明確批准 production 站台機密變數範圍，建置程序也能存取，程式僅在後端讀取且不得進入前端產物。按照官方 CLI 的格式，機密變數範圍為 builds、functions、runtime（排除 post_processing），已成功設定。未升級或變更付費方案。

驗證：336 項測試、lint、build 通過。98 個前端產物與正式入口未發現私鑰標記。news-proxy、foreign-quote（symbols=AAPL）、market-cap-proxy、mops-proxy、yahoo-calendar-proxy、google-calendar-series（POST），各自匿名與無效 Bearer 憑證測試均為 401，共 12 項通過。

上述驗證確認後端可解析金鑰設定且拒絕未授權請求；尚未以真實使用者登入驗收完整外部供應商與 Google 同步流程，不能視為已驗證實際配額交易或所有上游服務。
