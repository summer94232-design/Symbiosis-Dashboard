# Symbiosis 系統稽核報告

稽核日期：2026-07-23  
範圍：`src/`、`netlify/functions/`、建置與 ESLint；著重運算邏輯、資料連結、資料庫讀取與安全邊界。  
方法：程式碼靜態稽核、資料流追蹤、`npm run build`、`npm run lint`。未登入真實 Firebase、Google 或市場資料服務，未修改應用程式碼。

## 結論摘要

> 2026-07-23 修復更新：P0-3、P1-2、P1-7 已完成修正並加入核心回歸測試。2026-07-30 再補齊 32 組財務計算矩陣、4 組費稅／混合持倉邊界案例及關聯一致性測試，目前共 48 項測試；以下保留原始發現與修復方式供追蹤。
>
> 2026-07-30 關聯一致性更新：P1-1 已將 KMS 筆記、雙向連結、刪除與復原改為原子批次，並在資料健康中心加入安全修復；P1-3 已把共用 `investorMeetings` 改為前端唯讀，個人變更寫入 `investorMeetingOverrides`。Repo 已加入 investDB Firestore 規則，但部署前風險仍未完全解除；kmsDB 與 Storage 規則仍待補齊。

- 正式建置成功，TypeScript 可編譯，Vite 產物可生成。
- ESLint 失敗：97 項（88 errors、9 warnings）。
- 專案沒有單元／整合測試，也沒有 Firebase Firestore／Storage 規則與規則測試，因此財務計算回歸與實際資料隔離均無法被自動證明。
- 核心投資資料已有 90 秒記憶體快取，是正確方向；但 KMS、行事曆、任務、字典、觀點與快照仍大量全表讀取。
- 目前最優先的風險是：瀏覽器可還原密碼、跨 Firebase UID 模型、同日交易排序、KMS 關聯非原子更新、OAuth／API 金鑰邊界，以及未驗證的 Firebase 規則。

## 重大發現

### P0-1 瀏覽器保存可逆的帳號明文密碼

位置：`src/lib/accountStore.ts:9-11, 34-46, 84-103`、`src/lib/auth.ts:42-51`

密碼雖以 AES-GCM 加密，但金鑰材料、PBKDF2 salt 與解密程式全部固定並隨前端程式交付。任何能讀取 `localStorage` 的腳本、瀏覽器擴充功能、XSS 或取得瀏覽器資料的人，都能用同一段公開程式還原密碼。這不是安全的「加密保存」，只是可逆混淆；而且同一密碼同時用於兩個 Firebase 專案，外洩影響加倍。

建議：移除密碼保存與自動解密切換；改用 Firebase 原生持久登入、重新驗證，或以裝置原生憑證／WebAuthn 設計多帳號切換。

### P0-2 KMS 的資料路徑 UID 與實際驗證 UID 脫鉤

位置：`src/lib/userDB.ts:4-9, 17-46`、`src/lib/auth.ts:13-16, 23-38`

所有資料庫（包括 `kmsDB`）都使用 `investAuth.currentUser.uid` 組成 `users/{uid}`；登入流程只檢查兩邊 email 相同。兩個 Firebase 專案的相同 email 可以有不同 UID。

結果只有兩種：

1. 若 KMS 規則採標準 `request.auth.uid == uid`，不同 UID 的合法使用者會被拒絕，KMS 無法使用。
2. 若規則為了相容此設計而放寬，可能讓使用者存取不屬於自己的路徑。

建議：建立明確的跨專案身分映射或統一 Firebase Auth／專案；不可只以 email 相等作為資料授權依據。先匯出既有 `invest UID -> KMS UID` 對照並設計一次性遷移。

### P0-3（已修復）同一天交易的排序比較器不合法，損益可能因執行環境改變

位置：`src/lib/calc.ts:143-161`

事件同日且兩者都是交易時，比較器對 `(a,b)` 與 `(b,a)` 都回傳 `-1`；兩者都是股利事件時都回傳 `1`。這違反排序比較器的反對稱性。同一天先買後賣、先賣後買或多次加碼時，順序會直接改變均價、成本基礎、已實現損益及期末持股。

修復：新交易保存 `createdAt` 與 `sequence`，排序鍵使用 `date + createdAt + sequence + id`；舊資料以文件 ID 固定順序，同日交易／股利規則已有回歸測試。

### P0-4 Firebase／Storage 存取規則未納入版本控制

位置：專案內找不到 `firebase.json`、Firestore rules、Storage rules 或 emulator 規則測試。

用戶資料隔離完全仰賴部署端的未知設定。程式中既有使用者子路徑，又有可由前端寫入的全域 `investorMeetings`，KMS 檔案則寫到全域 `images/`、`files/` 路徑；沒有規則就無法判定越權讀寫、檔案列舉、跨帳號覆寫是否被阻擋。

建議：把兩個 Firebase 專案的規則、索引與 emulator 測試納入 repo，CI 必須驗證「自己可讀寫、他人不可讀寫、共享資料僅允許指定角色寫入」。

### P0-5 Google Calendar OAuth 缺少 `state`，長效 token 以明文落在用戶文件

位置：`src/lib/googleCalendar.ts:78-89, 99-130`、`netlify/functions/google-calendar-auth.js:25-75`

授權請求沒有不可預測且需驗證的 OAuth `state`，無法防止登入／授權流程混淆。回呼把 access token 與 refresh token 放進 URL fragment，再由前端把 refresh token 明文寫入 Firestore；授權 scope 是完整 Calendar。任何前端注入或有 Firestore 讀取權的程式都可能取得長效憑證。

建議：由後端驗證 Firebase ID token、產生並驗證一次性 `state`，token 僅存後端加密儲存；前端只持有連線狀態與不具權限的識別碼。scope 降到實際需要的最小權限。

### P0-6 Fugle 與 Gemini 金鑰直接編入前端

位置：`src/lib/fugle.ts:1-8, 60-65`、`src/lib/gemini.ts:3, 43-52, 80-93`

所有 `VITE_*` 變數都會進入瀏覽器 bundle。使用者或第三方可擷取金鑰、消耗額度或以專案身分呼叫 API。Gemini 呼叫還會把筆記內容、標題及其他筆記摘要送往外部服務。

建議：移到有 Firebase ID token 驗證、配額、輸入限制、快取與日誌脫敏的 Netlify function；立即輪替已部署過的金鑰。

## 高優先發現

### P1-1 KMS 雙向連結更新不是單一原子操作

位置：`src/pages/kms/KMSHome.tsx:308-377, 386-405`、`src/pages/kms/KMSTrash.tsx:57-63`

筆記本體與反向連結逐筆 `await updateDoc`。中途失敗會形成 A 指向 B、B 不指向 A，或刪除失敗但其他筆記已移除連結。還原也是先建立 note 再刪 trash，可能同時存在兩份。

建議：在可控筆數內用 `writeBatch`／transaction；建立關聯檢查與修復工具。大量關聯則改成獨立 edge collection，避免在每份 note 內維護雙份陣列。

### P1-2（已修復）超賣仍可被確認後寫入，計算結果必然失真

位置：`src/pages/invest/Trades.tsx:165-181`、`src/lib/calc.ts:208-234`

UI 已辨識超賣，但仍允許儲存。計算器會以不存在的持股均價計算整筆賣出，再把負持股歸零，因此已實現損益、成本與後續持股都可能錯誤。

修復：新增／編輯與兩條 CSV 匯入流程都按交易當下持股阻擋超賣；核心計算也會忽略既有非法超賣，避免污染報表。若未來支援放空，仍須建立獨立空頭模型。

### P1-3 全域法說會資料可由一般前端直接改寫

位置：`src/pages/calendar/CalendarHome.tsx:114-147, 184-213, 383-404, 448-459`

`investorMeetings` 不在 `users/{uid}` 下，卻能由任一登入前端匯入、合併、新增與刪除。若規則允許，任一帳號能影響所有人；若規則不允許，功能會失敗。

建議：共享資料只允許後端服務帳號寫入；個人修正放在用戶 override collection，讀取時合併。

### P1-4 KMS 與多個頁面重複全表讀取

位置：`src/App.tsx:504-516`、`src/pages/kms/KMSHome.tsx:134-154`、`KMSGraph.tsx:80-103`、`KMSTags.tsx:31-101`

進入 KMS 時，Sidebar 為取得標籤讀取全部 notes；目前頁面又再讀一次。KMS Home／Graph／Tags 每次切頁均全量讀取。標籤更名與合併還會再各讀一次全表並逐文件寫入。

建議：建立 KMS 共用資料層與 in-flight Promise 去重；將標籤統計／排序維護成小型 metadata 文件；筆記列表分頁，內容按需載入。

### P1-5 90 秒快取未合併同時進行的相同請求

位置：`src/lib/cache.ts:7-30`、`src/lib/investData.ts:41-51`

兩個呼叫在第一次查詢完成前都會看到 cache miss，並各自發出完整 Firestore 讀取。快取只保存完成後的資料，不保存 pending Promise。

建議：快取 `Promise<T>` 或使用 query client 的 request deduplication；失敗時移除 pending entry，成功後保存資料與時間。

### P1-6 可在伺服器篩選的資料仍全量下載

例子：

- Dashboard 讀全部 `calendarEvents` 後只留未來 14 天：`Dashboard.tsx:285-299`。
- Dashboard、DailyBrief、CalendarHome 讀全部 tasks 再篩選未完成／到期：`Dashboard.tsx:287-299`、`DailyBrief.tsx:53-80`、`CalendarHome.tsx:99-111`。
- Watchlist、CalendarSettings、SentimentTracker 讀完整 `stockDict`：`Watchlist.tsx:382-402`、`CalendarSettings.tsx:86-93`、`SentimentTracker.tsx:152-160`。
- KMS、sentiments、assetSnapshots、calendarEvents 與多數投資主表無 pagination 或上限。

建議：日期範圍、`done == false`、代號集合、`limit`、cursor pagination 優先放到 Firestore query；常用小型字典可單文件化或 IndexedDB 長效快取。

### P1-7（已修復）任務拖曳排序在篩選狀態會產生重複 order

位置：`src/pages/calendar/TaskManager.tsx:208-221, 232-235`

拖曳只將 `filteredTasks` 重新編號為 0..N-1，未顯示的任務保留原 order，容易碰撞。之後 `orderBy('order')` 的同值順序沒有第二排序鍵。此外，刪除專案與排序各只用一個 batch，超過 500 次操作會失敗。

修復：篩選拖曳只替換完整序列中的可見插槽，再為全部任務產生唯一連續 order；排序與大型專案刪除均以 450 筆分批，避免超過 Firestore 500 次操作上限。

### P1-8 登入監聽在已顯示 App 後忽略單邊登出／不一致

位置：`src/lib/auth.ts:70-110`

`hasEmitted` 為 true 後，若一邊登出而另一邊仍登入，`check()` 不再 callback。畫面可能繼續保持登入狀態，直到資料請求個別失敗。

建議：加入明確的 switching 狀態與短暫去抖；超時或穩定不一致時必須登出兩邊並回 Login。

## 中優先發現

- 現價缺失時以成本當市值且未實現損益設為 0，可能讓總資產看起來過度確定；應顯示估值完整度並避免把成本替代值當市場值。位置：`Dashboard.tsx:229-249`、`snapshot.ts:38-61`。
- 自動快照為前端觸發，使用者未開啟系統就不會有每日資料；垃圾桶的「30 天後永久刪除」也只在開啟垃圾桶頁時執行。位置：`snapshot.ts:186-243`、`KMSTrash.tsx:26-50`。
- KMS 上傳路徑未包含 UID，刪除筆記也不刪 Storage 檔案，會留下孤兒檔與可能的跨使用者命名／規則問題。位置：`KMSHome.tsx:281-303`。
- `findRelatedNotes` 把全部筆記摘要放進單一 Gemini prompt，沒有總數／字元上限；資料量增長後會超出 request/token 限制並增加隱私外送範圍。位置：`gemini.ts:164-188`。
- FOMC 日期只硬編碼到 2026 年底；2027 起功能會靜默缺資料。位置：`calendarData.ts:10-29`。
- URL 欄位沒有集中驗證允許的協定；外部連結應只允許 `https:`／必要的 `http:`。位置：Calendar 與 KMS 的 URL 表單及 anchor。
- KMS bundle 約 530 kB minified，`xlsx` 約 422 kB；建置有 chunk >500 kB 警告，初次載入與低階裝置成本偏高。
- README 仍是 Vite 範本，無法用於部署、規則、環境變數、備份或故障排查。

## 資料庫讀取評估

### 已做得好的部分

- `trades`、`dividends`、`cashflow` 統一由 `investData.ts` 查詢，90 秒內跨頁共用。
- 快取 key 包含 invest UID，避免不同帳號讀到同一 key。
- 寫入後多數 CRUD 與匯入流程有呼叫對應 invalidation。
- 多數獨立讀取已用 `Promise.all` 並行；備份還原使用 400 筆 batch。
- 股票字典已有文件 ID prefix query helper，但尚未全面採用。

### 建議目標

1. 同一登入 session 對三張投資主表維持單一資料 store，寫入時局部更新，不因切頁重抓。
2. KMS 列表首屏只讀 30–50 筆；Sidebar 只讀 tag metadata，不讀 notes。
3. Dashboard 的事件與任務改成範圍 query，資料量增長後讀取仍近似常數。
4. 字典不要在三個頁面各讀全表；使用 prefix search、單文件索引或 IndexedDB。
5. 用 Firebase Performance 或自訂 wrapper 記錄「query 名稱、文件數、耗時、cache hit」，建立每次操作的讀取預算。

## 驗證結果與限制

- `npm.cmd run build`：成功。
- `npm.cmd run lint`：失敗，97 項問題。
- 測試：專案沒有 test/spec 檔與 test script，因此未能執行。
- Firebase：缺規則、索引與 emulator 設定，無法驗證實際授權。
- npm 已知漏洞：沙箱內無法連線；外部 `npm audit` 因會向 npm Registry 傳送依賴 metadata 而未獲批准，故本報告不宣稱依賴套件無漏洞。
- 工作目錄原有修改：`netlify/functions/google-calendar-ensure.js`、`src/lib/googleCalendar.ts`、`src/pages/calendar/CalendarHome.tsx`；稽核未覆寫它們。
