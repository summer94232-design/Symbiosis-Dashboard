# 後續：跨帳號、失敗復原與發布檢查（2026-09-08）

F16（密碼保存）與 F17（OAuth／token）依使用者指示繼續暫緩。本次沒有修改登入或 token 保存設計，沒有部署，也沒有操作正式 Google／Firebase 資料。

## 已補上的行為

- Google 完整同步固定原登入 session。確認行事曆、pull、每批 push、Firestore 更新與連結回填均檢查身分；切帳號後停止後續步驟。已送出的 HTTP 批次及已提交寫入無法撤回，並非遠端交易回滾。
- Google 原生事件以 calendarId＋Google event ID 的 SHA-256 對應穩定本機 ID，transaction 僅在不存在時建立。連結回填失敗後重試不再新增第二筆，也不覆蓋現有本機編輯。
- 出入金／股利／任務／專案共用同步防重入鎖與 finally；新增失敗保留表單及重試 ID。股利及股票名稱字典放在同一 batch。股票名稱查詢與跨批次任務操作也固定原帳號。
- 任務／專案／行事曆加入共用訂閱的快取失效來源；任務頁隨 syncVersion 更新清單。其他頁面的完整跨裝置 UI 刷新仍需各入口驗收。
- 永久清理先以 transaction 確認沒有有效筆記，再在 trash 留下 purgeState 與附件清單。中途失敗保留清單供重試；已開始清理的項目禁止復原。全部附件處理完後才以 transaction 一起移除正文與垃圾桶文件。
- 垃圾桶及健康中心使用相同永久清理程序。健康中心關聯修復比對讀取版本，變更時停止，不以舊結果蓋過新資料；單次安全修復最多 449 項。舊版程式或 Admin 工具不遵循清理狀態的競爭仍需另外防範。
- 圖片草稿的遠端刪除失敗時保留本機紀錄，切帳號時停止後續草稿清理；圖片處理與上傳也保留原 session。

## 隔離驗證

- 一般回歸測試 259 項全部通過：本次新增 13 項，涵蓋同步各階段切帳號、重試去重、清理中断與續跑、表單回應遺失、草稿刪除失敗、歷史核對。
- TypeScript 與 Vite 正式建置通過；本次核心／表單修改的 ESLint 通過，原有 CalendarHome／KMSTrash 等頁面 lint 債務仍待處理。
- Firebase Emulator 8 項測試已通過：原有 5 項 KMS Firestore／Storage 規則，加上投資規則、備份往返、清理復原互斥。
- 備份演練使用實際 buildFullBackup／parseBackup／restoreFullBackup，在隔離來源帳號與空目標帳號比對正文、富文字、附件引用、連結、設定及帳務欄位。JSON 不含媒體二進位，本次不宣稱附件檔案已跨帳號搬移。
- Emulator 使用 demo 專案；測試中出現 PERMISSION_DENIED 是預期的跨帳號／匿名拒絕案例。
- 官方 Temurin Java 21 下載後核對 SHA-256，保留於專案忽略目錄與暫存目錄；沒有修改系統 PATH 或安裝全域 Java。Windows 多語路徑導致 Java 啟動／規則檔讀取失敗，改由 ASCII 暫存 runtime 與設定目錄執行。
- 可重跑：Java 21 在 PATH 時執行 `npm run test:emulators`。腳本會複製規則至暫存目錄，隔離 Firebase CLI 設定並自行停止模擬器。

## CI 與歷史核對

`.github/workflows/data-safety-checks.yml` 加入一般測試、正式建置及 emulator 檢查。全專案 lint 目前有既有錯誤，仍以非阻擋方式列報，尚未宣稱 lint 品質門檻完成；CI 尚未推送至遠端執行。

`npm run audit:history -- <新版JSON備份路徑>` 只讀備份，輸出各日期現金／融資負債差異及淨值組成錯誤，不覆寫任何檔案或正式快照。缺少歷史股票價格，因此不能證明歷史市值或帳戶淨值正確，也不替代券商對帳。尚待使用者提供實際備份路徑。

## 仍待完成

- 實際備份的歷史帳務差異核對及必要的人工確認；目前只驗證測試資料。
- 全專案 lint 清零、完整瀏覽器／弱網驗收、CI 遠端實跑與部署版本核對。
- F16、F17 仍暫緩；正式上線前應再次評估。
