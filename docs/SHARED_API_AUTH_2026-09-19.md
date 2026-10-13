# 新聞與法說會共用驗證故障 — v26.9.19.1（待部署）

## 已確認

- 正式版 v26.9.18.2、部署 `6aad3d61a66ab6d4a2ad15ef` 已發布且鎖定。
- 使用者回報 Yahoo 法說會 app/invalid-credential；unclassified；新聞與 Yahoo 法說會均在 authorizeApi / verifyIdToken(token, true) 失敗，尚未呼叫來源。
- 唯讀檢查：三個 API 環境變數均涵蓋 production + functions；服務帳號未停用，已記錄的 user-managed key 仍存在、未停用且在有效期內。
- Netlify secret 回傳值不可作為原始 JSON 讀取，因此無法由管理 API 直接驗證實際部署私鑰與公開金鑰是否配對。
- 讀取最近 24 小時新聞／法說會函式日誌，僅在記憶體中掃描並輸出固定模式計數：11 個 app/invalid-credential、3 個 unclassified；未取得更深層錯誤。沒有輸出原始日誌或儲存 token。
- 以本機臨時 RSA 測試金鑰，比較未打包 Firebase SDK 與 Netlify Dev 打包 SDK：模擬成功 token 回應均通過；實際 Google token 端點皆回預期 invalid_grant / account not found。這只排除了測試環境中的基本請求失敗，不能證明正式 Lambda 的執行環境或正式金鑰正常。

## 本機修改

補足既有診斷未涵蓋的安全分類：runtime-module-missing、runtime-module-incompatible、runtime-type-error、credential-key-format、credential-key-missing、oauth-token-response-invalid、network-tls；補辨識 fetch failed。

日誌另記錄固定允許清單內的錯誤類型與是否存在巢狀 cause，最多五層且防循環。不輸出任意類別名稱、原始訊息、堆疊、檔案路徑、私鑰、token 或 UID。未知原因仍維持 unclassified，不能猜測成已失效金鑰。

前端版本 v26.9.19.1，屬新待部署批次。保留 Firebase token 撤銷檢查、白名單及配額；未修正正式金鑰／IAM，沒有部署。這次追加診斷不等於修復新聞或法說會。

## 下一步

本機驗證：完整 npm test 448 項通過，npm run lint、npm run build 通過（既有大型 chunk 提示仍在）。測試涵蓋新分類、原因結構的允許清單／五層上限／循環防護、不洩漏訊息，以及新聞與 Yahoo 法說會均在驗證失敗時阻擋來源請求。

本機測試完成後，需使用者另行批准發布本批。部署後重現登入請求，依固定分類或受控日誌的錯誤類型定位。如果仍無法分類，不能以關閉驗證或擴大 IAM 權限繞過。只有確認憑證不匹配／失效時，才提出替換現有服務帳號金鑰與 Netlify secret 的具體方案供批准。
