# 第一階段修正紀錄（2026-09-07）

範圍：F01、F02、F06、F13、F14。未部署、未操作正式資料。

- F01：JSON v2 納入 noteBodies、KMS settings（含 tagOrder），附 binariesIncluded=false。還原前檢查正文；舊版內嵌正文轉為 noteBodies，避免沿用較新的正文。只有摘要而缺正文時，在任何寫入前拒絕還原。metadata/tagStats 是衍生索引，仍由既有筆記寫入觸發器維護，不覆蓋匯出時的舊統計。
- F02：以伺服器完整 calendarEvents 集合核對存在性。只有明確 manual sourceKind、已選 sourceType 且文件不存在才同步刪除。generated 不參與反向修改與刪除。既有缺少 sourceKind 的事件保守保留；之後正常更新時會補標記。前端及兩個 Google functions 必須一起發布。
- F06：清理查伺服器 notes、noteBodies、trash；任一讀取失敗即停止，不刪圖。帳號切換中止清理。
- F13：備份／還原固定起始 invest UID 與兩個 Auth user session，批次前後核對。已提交的批次無法回滾，但後續批次不會改寫新帳號。
- F14：Admin 清理驗證精確圖片路徑、noteId、assetId／草稿 ID，並透過 KMS Auth 的 Admin 管理 investUid claim 核對擁有者。未驗證、跨使用者、任意或舊路徑、帶縮圖的舊草稿保留。預設清理開關仍為 false。

驗證：npm test 共 146 項（含新增 23 項），全數通過。安全測試使用真實函式搭配記憶體 Firestore／Storage mock，涵蓋 JSON 往返、400/401 批次切帳號、Google 範圍／類型／生成事件、正文引用及後端清理路徑。修改的核心與 function 檔案通過 ESLint。

限制：未執行 emulator、正式 Storage 二進位備份復原或 Google API 實測。JSON 無法還原已遺失的媒體檔。跨集合備份與跨批次還原不是全域交易；建議在停止其他裝置編輯的維護時段進行。F08 的衍生標籤統計冪等性及 F17 的 OAuth／token 問題仍屬後續範圍。
