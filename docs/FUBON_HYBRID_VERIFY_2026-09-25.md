# 富邦／富果混合更新驗證

沿用同一整合批次 `v26.9.24.3`。正式網站及雲端富邦啟用旗標未變更。

## 本機驗證

- 新增 `tests/hybrid-flow.test.mjs` 並納入一般 test script，以實際 sharedQuotes／hybridQuotes／快照正規化／合併／每日報價政策及更新協調器串接測試。
- 四個新增案例：全系統與外股／指數分流、直接查價與關閉旗標、富邦失敗的有界補查與舊價格隔離、不同日期成交價不能覆蓋同輪參考價。
- 與原有 hybrid-quotes、global-prices、price-date-safety 合計 51 項通過，新增測試 lint 通過。涵蓋實際 PriceProvider 的共用更新、跨帳號中止，以及 auto-snapshot 的資料安全分支。
- 未變更正式程式邏輯；只新增整合測試及忽略的 QA 工具，不重跑沒有新疑慮的全套測試。

## 真實資料只讀驗證

- QA 使用實際 `loadGlobalQuoteCodes`、`loadPortfolioSnapshot`、`getSharedQuoteObservations`、`mergeQuoteObservations` 與 `buildPortfolioSnapshot`。測試 bundle 的富邦旗標為 true，但不改任何 Netlify 旗標或正式 dist。
- 讀取目前使用者全部代號與持股，先跑目前時段規則，再明確傳入持股代號測試成交價補查。後者是補查路徑驗證，不能把盤中價格宣稱成已驗證收盤價。
- 結果只在記憶體合併計算；不呼叫 PriceProvider 寫入、資產快照儲存或儀表板法說會同步。Firebase Auth 自身會維護登入狀態，既有後端 API 會記錄配額。
- 部署 `6ab5ecda70bdf4f887a5361b`，https://6ab5ecda70bdf4f887a5361b--symbiosis-jiawei.netlify.app 。Deploy Preview ready，正式部署仍為 `6aad8126bef698564654e725`。
- 已開啟測試頁並請使用者登入；真實混合結果尚待取得。不要把先前兩檔純富邦成功或本機測試通過，當成全系統混合驗收完成。

### 首次實測發現 QA 建置問題

- 真實使用者清單為 81 檔、持股 13 檔。第一次 current-time 耗時 61.93 秒，79 成功且全部 trade，2456／NVDA 失敗。13 檔持股皆被今日快照報價檢查擋下（來源 9/24、當日 9/25）。
- 這輪**不是混合驗證成功**：檢查實際 bundle 發現富邦 flag function 為 `return !1`。Vite 對個別 `import.meta.env.*` 的替換覆蓋了 QA 原本定義的整個 env 物件，使其走全富果路徑。81 檔也跨過前端程式每 61 秒 55 次的節流門檻，約一分鐘耗時與此一致，不能據此宣稱券商伺服器必定回過 429。
- 已重新載入頁面停止後续查詢；單獨富邦兩檔查詢仍成功，10.57 秒，兩筆均 reference，確認問題是 QA 開關而非將真實富邦資料全部判成 trade。
- 修正 QA build 為逐一 define `import.meta.env.KEY`；新增輸出 bundle AST 檢查，追蹤真正 sharedQuotes 分流所呼叫的 flag 函式，只有編譯結果為 true 才允許完成建置。QA 執行入口也在 flag 關閉時直接停止，結果會顯示 fubonEnabled。
- 修正後重新打包、秘密標記與實際 flag AST 檢查均通過。尚待新的 Preview 部署與真實混合結果；不重跑未改動的業務單元測試。
- 修正後部署為 `6ab5ee617c58cb0cf29e67fb`，https://6ab5ee617c58cb0cf29e67fb--symbiosis-jiawei.netlify.app ，正式 deployment 未變；已開啟並請使用者重新登入。
- 首輪缺價清單中的 `NVDA` 沒有 `US:` 前綴，依 sharedQuotes 的路由會當台股查詢。這是實際 universe 的市場標記問題，尚未定位是哪個資料表，也未自行修改使用者資料。2456 的缺價原因尚未調查。

## 修正後真實混合驗證完成

- 使用者重新登入後，助理按下「混合行情只讀驗證」。頁面確認 `fubonEnabled: true`、`today: 2026-09-25`、`afterCloseNow: true`。因此此次 current-time 模式本身已包含持股成交價補查；第二輪為相同持股補查路徑的後續請求，不是盤中與盤後的比較。
- 全系統 81 檔、持股 13 檔。兩輪皆成功 79 檔，其中 reference 61、trade 18；缺價 2456 與 NVDA，全部持股都有價格。這些是結果價格類型數量，不等同於各供應商的 HTTP 請求數。
- 首輪 12.21 秒、後續輪 4.58 秒。先前全富果誤配置測試為 61.93 秒；可作此次環境觀察，不能保證每次相同耗時或精確量化冷啟動／快取貢獻。
- 來源日期為 2026-09-24（失敗項目為空日期），與 9/25 不同。13 檔持股皆被報價日期檢查列為 stale，`todaySnapshotBlockedByQuotes: true`，正確阻擋以舊來源建立今日快照。
- `writesPerformed: false`；未修改 lastPrices、資產快照、交易／現金資料，未同步法說會。安全實測紀錄為 `.local-tools/fubon-hybrid-cloud-verified.json`。
- 結論：實際共用混合查價、持股补查、資料合併與資產快照報價阻擋的**只讀驗證完成**，保留兩筆缺價問題；不能宣稱正式儀表板寫入與完整按鈕操作已做雲端驗收。

## 尚未覆蓋（驗證完成後仍保留）

- 正式儀表板按鈕的線上寫入與法說會同步，此次只讀測試不執行。
- 真正盤後來源／成交价語意和冷啟動的長期表現，不能靠單次查詢承諾。
- 部分市場失敗的詳細 UI 提示與手動全富果重試介面仍是待完成項目；sharedQuotes 目前只回傳 quotes，尚未把 hybrid result 的 snapshotError／unattempted 提升到 UI。
