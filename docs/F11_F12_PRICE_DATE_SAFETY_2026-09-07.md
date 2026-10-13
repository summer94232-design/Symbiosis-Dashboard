# F11／F12：逐檔報價與入帳日期（2026-09-07）

## 修正

F11：settings/lastPrices 保留原數字欄位，新增 _quotes，逐檔保存 requestedAt、fetchedAt、sourceDate、sourceUpdatedAt、priceType、status。PriceContext 以 transaction 合併；較早請求晚到或來源時間倒退，不得覆蓋較新價格。失敗保留舊數字供快取相容，但不作有效現價使用。_updatedAt 僅表示最後成功抓取時間，不能作全持股新鮮度證明。頁面初始化也保留逐檔 metadata，儀表板移除無條件填入當前時間的做法。

自動快照與「儲存今日快照」共用 buildTodaySnapshot，對同一份伺服器報價檢查全部有效持股。必須成功抓取、來源日期與本地今日相同、價格為成交價而非 referencePrice；缺價、舊版只有整表時間、失敗、過期或來源不明皆阻止寫入並回報代號。空持倉但有現金的帳戶不要求股票價格。假日或盤前只有前一交易日／參考價時也會略過，不偽裝成今日成交價。一般「手動新增」仍供使用者填寫經核對的資產數字。

Fugle 的 date、lastUpdated 與成交／參考價格欄位以官方 Intraday Quote 文件為依據：https://developer.fugle.tw/docs/data/http-api/intraday/quote/ 。沒有來源日期時不推測為今天。

F12：今日 portfolio 以本地日期作 asOf，交易、現金流、融資本金及已實現損益只包含截止日前資料；日期缺漏／無效的現金流不當成已入帳。歷史計算可顯式指定日期，底層計算保留原有不指定截止日的歷史用途。

股利新增 status（announced／confirmed）、cashPaymentDate、stockDistributionDate。新建預設為預告；預告即使日期已過也不入帳。確認後依各自日期入帳／配發，明確股票配發日當天可出售。既有未記錄狀態與新日期的資料，仍以原 date 為有效日並保留原同日排序。CSV／Excel 匯出及 CSV 匯入同步保留這三個欄位；JSON 備份原樣涵蓋。年度歷史快照的現金分解亦依實際付款日處理，總淨值仍沿用原快照。

## 驗證與限制

- npm test：184 項通過（本次新增 29 項）。涵蓋部分／全部失敗、只更新非持股、亂序回應、來源倒退、參考價、切帳號、真實更新 callback 與自動快照函式的 mock 整合、未來交易／現金／股利、分開付款與配發、配發日可賣股數及舊資料相容。
- npm run build：通過；既有大型 chunk 警告仍在。
- 本次修改的核心、PriceContext 與新增測試 ESLint 通過。修改頁面的既有 lint 問題未增加：與 HEAD 比較，CalendarHome 2 errors/1 warning、Dividend 1 error、InvestSettings 3 errors、AssetTrend 1 warning、Dashboard 4 errors、Holdings 1 error，PortfolioPlanner 0。
- 未部署、未讀寫正式資料；未執行正式行情 API 或 Firebase emulator 實測。新規則不回溯修改已保存的歷史快照。
- 舊股利紀錄若原日期其實只是除權息日，仍需人工補上真正入帳／配發日期；系統不推測。發布後須重新更新持股現價，才能取得逐檔來源資料。
