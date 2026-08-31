# Symbiosis 後續優化路線圖

本路線圖依「先避免帳號／資料／金錢計算出錯，再降低成本，最後擴充體驗」排序。P0 完成前不建議擴大使用者或保存更敏感資料。

## 2026-09-01 現況基線

- [已完成] 現股當沖第一版：依同帳戶、同日、同股票與成交類別自動沖抵，支援部分當沖、先賣後買、人工指定、排除、成本分攤、備份／CSV 往返與資料健康提醒。
- [已完成] 買賣紀錄第一版 UI 收斂：表單改為兩列桌面版配置，例外處理降低視覺權重，正常當沖卡片不常駐，交易列顯示當沖標籤並採日期、代號、新增時間排序。
- [已完成] `npm test` 擴充為 122 項並通過；production build 通過。
- [待完成] 完整 ESLint 基線為 73 errors、10 warnings；目前只有法說會同步 workflow，尚未建立完整 CI 發布門檻。
- [待確認正式環境] 投資 Firestore 規則，以及 KMS UID 遷移、規則與排程函式的實際部署狀態。

## P0：立即處理

### 1. 身分與密鑰安全

- 移除 `accountStore` 密碼保存、解密與無密碼切換；清除既有 `saved_accounts`。
- 統一 Auth 身分來源，或建立可信的跨 Firebase UID mapping 與 KMS 資料遷移。
- 建立 Firestore／Storage rules、indexes、emulator tests；規則隨程式版控。
- Fugle、Gemini、News 等帶額度服務移到驗證過的後端 proxy；加入每 UID／IP 限流與快取，輪替舊金鑰。
- Google OAuth 加上後端 state／PKCE 流程、Firebase ID token 驗證、後端加密 token vault 與最小 scope。

驗收：瀏覽器 storage 與 bundle 中沒有密碼或私人 API key；兩個帳號互相讀寫皆被規則拒絕；KMS 合法帳號在 UID 不同時仍按設計運作。

### 2. 財務計算正確性

- [已完成第一版] 現股當沖依穩定規則自動／人工配對，從一般庫存移出沖抵股數；持倉、儀表板、已實現損益、年度統計與日末成本共用同一計算結果。
- [已完成] 新交易增加 `createdAt` 與 `sequence`，舊資料以文件 ID fallback，修正同日排序比較器。
- [已完成] 一般多頭交易禁止超賣，核心計算對既有非法超賣採防污染處理；若需放空，仍須新增獨立 position side 與成本模型。
- [已完成] 財務回歸測試包含同日排序、超賣、交易當下股數，以及現股／融資、整股／零股、ETF／股票、部分賣出／全數平倉、同年度／跨年度的 32 組完整矩陣；另含最低手續費、`.TW` ETF 稅率與現股／融資混合持倉案例。
- [已完成第一版] 以元大 2026-05／06 真實月對帳單建立去識別化 golden fixtures，固定核對零股成交金額、ETF 稅、融資本金／利息與淨收付；後續月份可持續補入特殊案例。
- [已完成第一版] 投資資料寫入共用 schema validation；手動新增與 CSV 匯入會拒絕 NaN、負數、無效日期、非法 type、非整數股數、融資拆分與收付金額不一致。

驗收：固定 fixtures 在 CI 逐筆對帳一致；同一資料在不同瀏覽器／重跑下結果完全相同。

### 3. 關聯一致性

- [已完成] KMS 筆記與反向連結使用 batch 原子寫入，避免部分成功留下斷鏈。
- [已完成] 復原 note 與刪除 trash 使用同一 batch。
- [已完成第一版] 資料健康中心可檢查並安全修復孤兒、單向及自我連結、note/trash 重複與過期垃圾；無效日期保留人工確認。
- [已完成程式與規則] `investorMeetings` 共用資料改為前端唯讀；個人新增、刪除及匯入結果另存 user override。正式環境仍需部署 `firestore.invest.rules`。

驗收：任一步驟故意失敗都不會留下半套關聯；修復工具可列出並修正既有異常。

## P1：降低讀取、延遲與營運成本

### 4. 共用資料層與請求去重

- [已完成] `trades/dividends/cashflow/assetSnapshots` 快取升級為 in-flight Promise dedupe；失效版本防止舊請求回寫。
- [已完成] 手動更新現價不再受 08:00–22:00 背景時段限制；現價更新會等待當日快照結果，並在儀表板／持倉頁顯示成功、缺價、關閉或失敗原因。
- [已完成] 建立 KMS store，Sidebar、Home、Graph、Tags、Export 與 Trash 共用資料。
- [已完成] Calendar events、tasks、task projects 與 stock dictionary 建立 query key cache／請求去重；mutation 後精準失效相關 key。
- [已完成] 帳號切換與登出時清除 store 與 pending request；Context state 清理仍待統一。

預期：KMS 首次進入由 2 次 notes 全表讀取降到 1 次；切換 KMS 子頁不再重讀全部 notes。

### 5. 伺服器端篩選與分頁

- Dashboard：`calendarEvents` query 限今日到 +14 天；tasks query 限 `done == false`，必要時再按 dueDate 篩選。
- Daily Brief：只讀當日／相關日期事件與未完成任務。
- KMS／sentiments／watchlist／snapshots：cursor pagination + `limit(30~100)`。
- 字典：全面採 `documentId()` prefix query；不要為一個輸入框下載整張 stockDict。
- Google 同步的 6–7 個 `yearMonth` 查詢合併為 `in` query，或後端一次取得。
- KMS 標籤建立 metadata／counter，Sidebar 不再掃描所有 notes。

驗收：記錄每個頁面的 query 次數與 documents read；資料量增長 10 倍時，Dashboard 與列表首屏讀取量不應等比增長。

### 6. 後端排程與快取

- 資產每日快照改由 authenticated scheduled function 執行；保留前端手動補寫。
- 垃圾桶 30 天清理、孤兒附件清理改為排程。
- 市場報價以後端短 TTL cache 合併相同代號請求，前端只拿結果。
- 法說會與 FOMC 資料定期更新；移除硬編碼年度資料依賴。
- News proxy 加 CDN cache、method check、rate limit 與錯誤監控，避免每次呼叫消耗上游額度。

## P1：可靠性與品質門檻

### 7. 讓 CI 成為可發布門檻

- 修完目前 73 個 lint errors 與 10 warnings（2026-09-01 基線）。
- [部分完成] 已有 `test`、`build`、`lint` 與 `test:kms-rules`；仍需獨立 `typecheck`、統一 `check` 及投資規則測試指令。
- CI 順序：install locked dependencies → typecheck → lint → unit tests → rules tests → build。
- 對 Google sync、backup restore、CSV import 做 fixture integration tests。
- 加入錯誤邊界、toast 與 retry；目前多處只 `console.error` 或吞掉錯誤，使用者不知道資料是否成功。
- [部分完成] 已建立共用操作提示，先套用儀表板、股票持倉及買賣紀錄的重新載入、更新現價、交易寫入／刪除與族群儲存；其餘頁面、錯誤邊界與 retry 待後續補齊。

### 8. 交易與同步的冪等性

- CSV 匯入使用來源交易 ID／hash，但允許同日同價同量的真實多筆交易，以 broker order id 區分。
- Google sync 保存 sync cursor／etag，明確定義衝突策略；部分成功可重跑且不重複。
- 大型任務刪除、標籤更名、備份還原採分批 job，保存進度與失敗清單。
- [已完成正確性修復] filtered view 會合併回完整序列並產生唯一 order；資料量進一步增長時可再改 fractional rank，降低每次拖曳的寫入筆數。

## P2：功能與使用體驗

### 8.5 iPhone 網頁版

- [已完成第一輪] 支援動態視窗高度、瀏海／Home Indicator 安全區域、16px 手機輸入、44px 觸控目標、底部快速導覽與完整側欄。
- [已完成第一輪] 手機表格滑動、月曆／任務單欄排列、任務篩選橫向滑動、表單彈窗底部展開及登入頁鍵盤體驗。
- [已完成第二輪] 月曆事件色點與更多操作、儀表板 KPI 壓縮、手機持倉展開卡片、交易／筆記／任務固定儲存列。
- [已完成第三輪] 儀表板持倉明細手機卡片化；統一儀表板／持倉／交易頁首與操作按鈕層級，提高手機字級並加入操作結果提示。
- [已完成第四輪] 知識庫固定搜尋／排序列、結果數量、清除搜尋與鍵盤操作；手機行事曆篩選橫向滑動，日期／月份／事件按鈕補齊觸控與輔助操作。
- [已完成第四輪] Word 與 Excel 解析套件改為匯入時才載入，降低知識庫與行事曆首次開啟成本。
- 後續可依真機使用回饋，針對個別圖表與知識圖譜做細部調整。

### 8.6 桌面網頁版

- [已完成第一輪] 交易紀錄每頁 50 筆，固定操作／搜尋列與表頭；保留依交易時間最新在前，以及「日期、類型、代號、名稱、價格、股數、手續費、交易稅、收付金額、備註」的原始表格順序。
- [已完成第一輪] 儀表板加入四區快速跳轉；依使用回饋取消區塊收合，所有內容固定展開，手機版既有卡片與財務邏輯不變。
- 後續可加入使用者自訂儀表板區塊順序、桌面側邊欄圖示模式與圖表全螢幕。

### 9. 投資資料品質

- [已完成第一版與安全修復] 帳戶管理新增「資料健康中心」：診斷交易／現金流／股利／快照格式、時間軸超賣、融資償還與重複交易；KMS 失效／非對稱／自我連結、note/trash 衝突與有效逾期垃圾可自動修復。
- [已完成] 儀表板與持倉頁顯示估值完整度、缺價代號及成本暫估口徑；完整時維持單行精簡提示。
- [已完成第一版] 對帳模式：上傳券商月結單，對比系統股數、現金、融資償還／利息與費稅；一致資料收合，僅對差異提出修正建議。
- 交易總額改為輸入欄位與推導欄位分離，保存 `calculationVersion`，日後公式變更可追溯。
- [已完成第一版] 融資維持率門檻可由使用者設定，儀表板與融資管理共用設定值，不再把 130／120 寫死為唯一制度。

### 10. 知識系統擴充

- AI 搜尋改用 embedding／向量索引或先本地候選縮小，不把全部筆記送入單一 prompt。
- AI 前先顯示將外送的內容範圍，允許敏感筆記 opt-out。
- 附件保存 UID、note ID、mime、size、hash；刪除／復原與附件生命週期連動。
- 支援版本歷史、衝突提示、反向連結檢查與孤兒筆記視圖。
- KMS Export 可選擇是否包含 URL、日期、標籤、附件文字，並提供匯出 manifest。

### 11. 行事曆與任務擴充

- 任務加入 recurring、提醒、完成時間、優先矩陣與依專案的看板。
- Google sync 增加 dry run／差異預覽，讓使用者先確認新增、更新、刪除數量。
- 法說會共享資料顯示來源與最後更新時間，個人 override 不污染全域資料。
- FOMC／市場休市／財報日期改用可靠資料源並定期同步。

### 12. 文件與營運

- [已完成第一版] 已用專案 README 取代 Vite 範本，整理環境變數、驗證、部署、規則與文件入口；更完整的備份還原與故障排查仍由系統手冊補充。
- [部分完成] 已建立 changelog 與 KMS 遷移工具；schema version、通用 migration runner 與 rollback 說明仍待補齊。
- 加入監控：Netlify function error rate、Firestore read/write、API quota、同步失敗、快照缺漏、前端錯誤。

## 建議執行順序

1. 第 1 週：停用密碼保存、輪替金鑰、補 rules 與 emulator tests。
2. 第 2 週：交易排序／超賣／財務 golden tests。
3. 第 3 週：KMS 關聯原子化、Google token 後端化、全域法說會唯後端寫入。
4. 第 4 週：KMS store、in-flight dedupe、Dashboard／Daily Brief 範圍 query。
5. 後續：分頁、排程、資料健康中心、AI 隱私與進階功能。

每一階段都先建立量測基線，再比較「documents read、API 次數、首屏時間、錯誤率、計算 fixture 通過率」，避免只做結構重寫卻無法證明改善。
