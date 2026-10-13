# 已確認券商資料更正與正式發布 v26.9.13.1

使用者明確要求「將已經驗證過的數據修正，並且將現在最新的系統版本部署上線」，本批次已有正式寫入及部署授權。此授權不延伸至後續新批次。

## 正式帳務更正完成

投資專案 stocksserver-45482，以原始使用者備份的 UID 精確限定帳戶。所有待更正文件在正式資料中的交易身分、其他財務欄位及指定原值均通過比對；正式帳本套用草案後，25 組直接憑證損益全部一致。

已備份正式投資資料及待更正文件的 Firestore 原始欄位型別與 updateTime，之後在單一 Firestore transaction 更新 18 筆交易（14 筆金額、4 筆沖抵），並移除使用者明確確認的 19,025 元虛擬入金。交易內重新比對 trades、cashflow、dividends 的文件版本，並行變更時中止，避免覆蓋新資料。

寫入後重新讀取所有投資 collections，與預期複本逐欄比較通過；117 筆資產快照、12 筆股利及所有非更正資料保持原樣。原始下載 JSON 的 SHA-256 不變。再執行唯讀核對顯示 19 項均已套用、待更正數 0，25/25 組損益仍一致。

本機私有稽核資料：

- `output/reconciliation/production-2026-09-12T19-15-13-156Z/investment-before.json`
- 同目錄 `target-documents-before.firestore.json`、`commit-receipt.json`、`investment-after.json`、`verification.json`
- 再次核對：`output/reconciliation/production-2026-09-12T19-19-27-275Z/preflight.json`

以上含個人資料的備份與稽核檔位於 Git 忽略目錄，也未包含在前端發布目錄中。

## 程式驗證及發布

版本保持同一持續批次 v26.9.13.1。377 項測試、正式建置及 lint 通過；建置僅有既有大型 chunk 提示。Firestore 規則與正式環境一致，本次無須重新部署規則。Netlify 發布包含前端及 Functions，沿用既有正式環境設定。

Netlify 正式發布完成：`6aa5a5eac5c59a0578dc1dbc`，正式網址 https://symbiosis-jiawei.netlify.app 。前一版 `6aa4cb308dda57a9f1139c77` 仍保留可供回復。

正式 HTML 指向新版入口，入口 JavaScript 及 Firebase 設定分割檔的 SHA-256 均與本機建置一致，入口含版本 v26.9.13.1。97 個前端產物已掃描，未含後端私鑰標記。news-proxy、foreign-quote、market-cap-proxy、mops-proxy、yahoo-calendar-proxy、google-calendar-series 的匿名與無效憑證請求皆回覆 401，共 12 項通過；此驗證不等同所有外部資料供應商的登入後完整流程驗收。

發布後再讀 Netlify 狀態為 ready，正式發布識別碼正確，原有部署鎖已恢復為 locked=true。部署與驗證紀錄保存於 `.codex-tmp/accounting-production-deploy.json`、`.codex-tmp/accounting-production-release.json`。本次沒有變更後端機密、付費方案或 Firebase 規則。

## 範圍

損益一致限於已提供的 25 組按日期與股票代號彙總樣本。出借股票仍納入所有權市值；零股最低費用採 1 元，不模仿券商畫面最低 20 元的預估差異。股利實收、出借收入與利息仍暫緩，前期現金差額不因本次資料更正而宣稱已核實；原始歷史快照保留，未重算覆寫。
