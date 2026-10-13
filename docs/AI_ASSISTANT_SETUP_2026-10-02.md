# 共生 AI 助理設定與驗收

目前使用全站 AI 浮動視窗，包含跨頁與重新整理的本機目前對話、雲端互動偏好、文字筆記摘錄檢索與手動建立新筆記。依 2026-10-03 最新要求，已移除獨立 AI 頁面與展開入口，舊 `/ai` 連結轉到投資首頁。換帳號、登出與新對話都會攔截舊請求的回覆。沒有歷史聊天列表或每則對話的 Firestore 存檔。顯示版本統一使用 `src/lib/appVersion.ts`；保留工作區其他更新已遞增的最新版本，不倒退覆寫。

## 本次帳號範圍

目前使用使用者於 2026-10-03 在原專案建立的新授權金鑰，舊金鑰已由使用者刪除。已核對登入帳號 **summer94232@gmail.com**，專案名稱 **Symbiosis Dashboard**，專案 ID **gen-lang-client-0155504975**，專案號碼 **320963190309**，Google 頁面目前顯示 **Tier 1 · Prepay**。新金鑰的兩個模型生成與聯網均已實測成功；本批次未改 Google 帳務、未充值、未建立帳號或金鑰。

依使用者最新要求，本次僅啟用 Gemini，預設 **gemini-3.8-flash**，手動省成本選項 **gemini-3.5-flash-lite**。兩者使用同一把已核對的新金鑰。GPT／Claude 僅保留未啟用的介面與介接程式，沒有連接或使用其他供應商帳號。Gemini 4 尚未加入。

本機 `.env` 已將既有 `VITE_GEMINI_API_KEY` 移至伺服器專用 `GEMINI_API_KEY`，不再透過前端變數呼叫模型。原本的標籤／關聯／摘要功能也改走登入保護的後端與同一費用預算；不再自動重試或切換模型。驗證過的金鑰指紋鎖定帳號標示與 Gemini 可用狀態，金鑰變動需重新核對，不能繼續顯示舊帳號。

## 正式後端設定

這份文件不含金鑰。使用者於 2026-10-03 明確批准完整部署；`v26.10.3.8` 已發布為正式部署 `6abffdc45a2b121688f0bba2`，正式狀態、生成、知識庫索引存取及聯網驗收均通過。現有 Netlify 方案不允許新增指定範圍的專案環境變數，因此這 16 項新增設定採 CLI `--env`／`--secret-env` 的 **Functions 專用部署覆寫**，不是全範圍的專案變數；Gemini 金鑰與知識庫憑證保留秘密標記，既有登入設定沿用。

**後續每次部署仍須附上這 16 項 Functions 設定。** 部署覆寫只屬於該部署，不會自動變成可供下一次發布沿用的專案環境變數；不能省略設定包而直接建立新版。設定包仍存於被 Git 忽略的 `local-secrets/ai-netlify-functions.env`。正式部署鎖已恢复，後續更新仍須取得新批次批准。詳見 [正式發布紀錄](RELEASE_2026-10-03.md)。

| 變數 | 用途 |
| --- | --- |
| `API_FIREBASE_PROJECT_ID`、`API_FIREBASE_SERVICE_ACCOUNT`、`API_ALLOWED_UIDS` | 沿用現有登入驗證；僅允許指定的投資系統 UID |
| `GEMINI_API_KEY` | 已核對的同一把 Google 專案金鑰；只放後端 Functions 環境 |
| `AI_ENABLED=true` | 啟用 AI 後端 |
| `AI_ALLOWED_PROVIDERS=gemini` | 本批次只使用這個 Google 帳號的 Gemini |
| `AI_GEMINI_PAID=true` | 已確認為付費 API 專案，不採用將提交內容作產品改進的免費方案 |
| `AI_GEMINI_ACCOUNT`、`AI_GEMINI_PROJECT`、`AI_GEMINI_KEY_SHA256` | 帳號／專案標示與比對指紋，本機已準備；指紋不是 API 金鑰 |
| `AI_KMS_PROJECT_ID`、`AI_KMS_SERVICE_ACCOUNT` | 現有知識庫專案的後端讀取與使用者手動新增筆記；不改原本使用者資料路徑 |
| `AI_MONTHLY_TWD=300`、`AI_USD_TWD=35` | 各模型及工具合併的月費目標、保守換算匯率，並非即時匯率或帳單保證 |
| `AI_INVEST_DAILY_READS`／`WRITES`、`AI_KMS_DAILY_READS`／`WRITES` | 分專案的 AI 子額度，預設每日讀 1000、寫 400；正式配置應不超過實際額度的各 20%，並扣除原功能需求 |
| `AI_DB_QUOTAS_CONFIRMED=true` | 已核對兩專案的方案、實際額度與近期原功能用量，本機已設為 true |

本機上述設定已補齊，預檢沒有缺項。原 Netlify 投資系統專案與允許 UID 已沿用；私鑰被平台遮罩，本機沿用下載資料夾內已確認有效、專案相符的既有 Firebase 服務帳號憑證，沒有建立新權限。正式 Netlify 的新增 AI 設定已隨本批部署生效。憑證只放於被 Git 忽略的本機 `.env`、設定包及正式後端秘密設定，不放入文件或前端。不可把系統登入帳號、Firebase 服務帳號或 Google 訂閱當成 Gemini 金鑰擁有者證據。

執行 `node --env-file=.env scripts/check-ai-config.mjs` 只輸出安全設定狀態與缺少的變數名稱。加 `--models` 僅查詢 Google 模型中繼資料，不執行付費生成或讀寫 Firebase。本批次已用核對過的同一把金鑰查詢清單，確認 `gemini-3.8-flash` 與 `gemini-3.5-flash-lite` 都有列出；這項結果不代表實際生成與聯網已驗證。

## 用量與時效

後端先以共享 Firestore 交易預留月費與各資料庫的讀寫，再呼叫模型；同一請求不會重複執行已結算的生成。完成後依供應商回報的 token、思考 token、搜尋次數結算，不假定免費搜尋或快取優惠。尚未開始模型請求便失敗時釋放未使用的費用預留；已開始請求後的未知用量、失敗、逾時或結算失敗則保留費用預留，需要核對供應商帳單，不自動重試。

Gemini 3.8 Flash 的費率依請求日期在 2027-01-01 切換。匯差、稅、供應商計量差異與未回報的搜尋用量可能使帳單不同。Google Search 工具沒有本介面可強制設定的查詢次數上限，因此本批次採較大的搜尋預留與實際回報後核對，**不能承諾 NT$300 零誤差硬上限**；應另設定 Google 帳務上限。此帳務操作尚未執行。

每日資料庫統計為保守預留，包含額度交易、偏好及檢索的文件上界。被拒絕請求仍可能產生交易讀取；平台或觸發器的重試也可能增加用量，並非 Firebase 帳單計量器。原筆記的新增會觸發整批標籤統計與全文索引，因此手動存成新筆記前會依全文索引的總筆記數預留衍生讀寫；超出子額度即不新增，結論仍可複製。正式每日額度及原功能用量確認前，不宣稱已精確達成 20% 限制。

開啟浮窗僅載入助理程式及偏好／額度，不掃描整個知識庫。提問需要筆記時，後端讀取已有的壓縮全文索引，最多 32 頁、最多提供 6 則相關文字筆記的原始段落；索引短暫快取，引用前再檢查筆記仍存在。模型只收到相關摘錄，不收到整份索引。依文字關鍵字匹配，可能漏掉同義詞，可手動指定搜尋詞；介面顯示搜尋數、提供數及原始段落。

筆記儲存／修改日期不當成原始來源／預測時間／查證時間。逐段理解 2025 筆記的 2028 題材與已過期 2024 題材；未知日期保留未知。一般整理不每輪聯網，現況問題才提供聯網工具；沒有可核對網頁來源時，介面明示待查證。投資資料只在問題需要時讀取有上限的集合，不以部分交易紀錄計算或宣稱完整持倉。

Gemini Interactions 與 OpenAI Responses 設 `store:false`，不建立供應商端聊天鏈；不代表供應商安全／營運紀錄完全不保存。長期僅自動保存明確要求的互動偏好；推測偏好是待選候選，投資結論不當成互動記憶。

## 驗證

自動測試覆蓋金鑰鎖定、供應商限制、日期費率、併發預留、重複請求、未知計量、偏好版本衝突、段落與已刪除筆記、模型請求／回應解析、失敗不重試、帳號與新對話的延遲回覆隔離。瀏覽器驗收只用隔離資料，無正式 Firebase／Google 生成請求。

- AI 專項測試：19／19 通過；既有主測試 707 項、介面測試 8 項、Functions 執行環境測試 6 項通過。
- TypeScript、全專案 lint 與正式建置通過；最後修改的 AI 程式另完成專項 lint。建置保留既有大型區塊提示。
- 最新建置的 94 個前端 JavaScript 檔案中，已核對的 Gemini 金鑰出現次數為 0。
- 瀏覽器驗證桌機 1366×900、窄手機 320×568、直向手機 390×844、橫向手機 844×390，包含原有明暗配色、模型文字、設定／新增筆記捲動與輸入區。
- 浮窗縮小／開啟保留原畫面草稿；獨立頁重新整理保留對話、模型與草稿；失敗保留問題供手動重試；切換隔離帳號或開始新對話後不接收舊請求的延遲回覆。視窗測試完成後還原瀏覽器尺寸。

本機已完成真實 Firebase 憑證、登入驗證、原始筆記段落檢索及兩個 Gemini 模型的生成／聯網驗證。真實瀏覽器浮窗也已完成登入狀態、用量預留、模型生成與回覆顯示的完整流程。偏好儲存與新增筆記的實際內容變更未對正式資料執行；正式網站的設定與部署仍需本批次批准，不能把本機驗證宣稱為正式網站已上線。

## 2026-10-03：融入原系統的介面預覽

`v26.10.3.1` 將本機 AI 預覽改為直接呈現正式 `App`、側欄、儀表板、知識庫及原有 `ThemeProvider`／主題色，取消先前簡化測試頁的自訂配色和測試控制列。資料服務仍使用記憶體中的示範資料，AI 回答為固定範例；Firebase／Google 請求不會送出，預覽頁也加入只允許本機連線的 CSP。

AI 獨立頁沿用既有的頁面標題、邊距和卡片樣式，控制項沿用共用圓角與配色。聊天區依原頁面可用高度伸縮；修正窄手機展開設定時輸入區被擠出面板，以及獨立頁的層級遮住手機導覽的問題。已檢查桌機 1366×900、直向手機 390×844、窄手機 320×568、橫向手機 740×390 的原有明暗主題與輸入區，原本對話保留。TypeScript、此次修改的專項 lint、建置及建置前的 6 項 Functions 執行環境測試通過。

本機預覽：`npx vite --config tests/browser/ai.vite.config.mjs --host 127.0.0.1 --port 5186 --strictPort`，開啟 `http://127.0.0.1:5186/invest` 或 `/ai`。只綁定本機、不進行部署；示範數字和回覆不能用來評估真實 AI 的分析能力。

官方參考：[Gemini Interactions](https://ai.google.dev/gemini-api/docs/interactions-overview)、[費率](https://ai.google.dev/gemini-api/docs/pricing)、[計費](https://ai.google.dev/gemini-api/docs/billing)、[OpenAI Responses／聯網](https://developers.openai.com/api/docs/guides/tools-web-search)、[Claude 聯網](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)。

## 2026-10-03：浮窗入口簡化

`v26.10.3.2` 將開啟按鈕文字改成「AI」，浮窗頂部只保留「新對話」及「縮小」。移除側欄 AI 專屬頁面與展開功能，舊 `/ai` 路徑轉到 `/invest`。模型選擇仍在浮窗內，偏好設定改由浮窗底部的「設定」開啟。

已驗證桌機 1366×900、直向手機 390×844、窄手機 320×568、橫向手機 740×390：設定可捲動，輸入區及底部控制項留在視窗內，沒有水平溢出。縮小再開啟保留目前對話。此次修改的 lint、TypeScript、正式建置及建置前 6 項 Functions 執行環境測試通過。本批次僅更新本機預覽，未部署。

## 2026-10-03：設定移至頂部

`v26.10.3.3` 依最新要求，將「設定」移到右上方「新對話」左側，移除底部「換頁保留討論 · 新對話清除內容」及整個底部控制列，讓聊天區使用釋出的高度。底部只保留輸入區；設定的開啟與收合功能保持原樣。模型列移除「本月估算」、「可用額度」與未載入時的每月費用目標提示；後端預算計算和限制保留，使用者可自行從後台查看費用。

已確認桌機 1366×900、直向手機 390×844、窄手機 320×568、橫向手機 740×390 的頂部按鈕對齊、設定展開和輸入區，沒有水平溢出。此次修改的 lint、TypeScript、正式建置及建置前 6 項 Functions 執行環境測試通過，未部署。

## 2026-10-03：模型選單與標題並排

`v26.10.3.4` 將模型選單移到左上方「AI 助理」右側，移除原本獨立的模型列。桌機與一般手機將模型和右側操作放在同一列；窄手機保留標題與模型並排，將操作按鈕換到下一列右側，避免擠壓或水平溢出。模型選單保留可存取名稱與完整模型名稱提示，原有模型切換及生成期間停用行為保留。

已驗證桌機 1366×900、直向手機 390×844、窄手機 320×568、橫向手機 740×390，並確認 Flash-Lite 較長名稱、模型切換及設定展開。此次修改的 lint、TypeScript、正式建置及建置前 6 項 Functions 執行環境測試通過，未部署。

## 2026-10-03：點擊外側自動縮小

`v26.10.3.5` 在 AI 浮窗開啟時監聽外側的主要指標按下事件，點擊背景頁面會自動縮小。浮窗、載入提示及 AI 開啟按鈕屬於同一範圍，不會因內部操作誤縮小；系統確認視窗開啟時暫停外側縮小，避免確認或取消時關閉 AI。縮小不清除目前對話及輸入草稿，原有背景頁面的點擊仍可使用。

已在本機預覽驗證外側點擊、內部點擊、AI 按鈕開關、新對話確認取消，以及縮小後對話與草稿保留。手機外側點擊及直向、窄手機、橫向版面一併確認。此次修改的 lint、TypeScript、正式建置及建置前 6 項 Functions 執行環境測試通過，未部署。

## 2026-10-03：部署前真實連線核對

`v26.10.3.6` 將 Gemini Interactions 路徑改為官方文件列出的 `/v1beta/interactions`，並讓 HTTP 402 顯示付款設定／餘額提示，不自動重試或切換帳號。新增 `scripts/check-ai-connectivity.mjs`，僅輸出設定缺項與安全診斷；有缺項、生成失敗或回應無法解析即回傳失敗結束碼，不能以模型清單查詢成功宣稱可部署。

已使用原本核對的同一把 Google 金鑰實測：模型清單包含 `gemini-3.8-flash` 與 `gemini-3.5-flash-lite`；以無個人資料的「只回覆 OK」測試真正生成，原路徑及修正後路徑均回傳 HTTP 402。修正後測試遇到付款阻擋即停止，未繼續測試第二個模型或聯網，未送出任何筆記。這表示金鑰可以取得模型中繼資料，但目前仍不能生成，需先在原 Google 專案處理帳務／預付餘額。未改帳務或購買額度。

正式 Netlify 網站 `symbiosis-jiawei` 已唯讀核對，未修改環境變數或部署：

- production 的 Functions 範圍已有 `API_FIREBASE_PROJECT_ID`、`API_FIREBASE_SERVICE_ACCOUNT`、`API_ALLOWED_UIDS`；目前只確認存在，尚未以真實登入驗證其遠端權限。
- 尚未設定 `GEMINI_API_KEY`、`AI_ENABLED`、`AI_ALLOWED_PROVIDERS`、`AI_GEMINI_PAID`、`AI_GEMINI_ACCOUNT`、`AI_GEMINI_PROJECT`、`AI_GEMINI_KEY_SHA256`、`AI_KMS_PROJECT_ID`、`AI_KMS_SERVICE_ACCOUNT`。
- 兩個資料庫的實際額度與 AI 子額度比例仍待確認。知識庫服務帳號權限、本機真實登入至 AI 後端、筆記檢索、偏好同步與聯網生成尚未完成實際端到端測試。

在正式部署之前，先處理 Google 帳務、準備 AI 後端與知識庫憑證並確認資料庫額度，再以本機真實後端完成上述驗收；通過後才申請一次正式環境設定與整批部署批准。Netlify 的環境變數修改需要新部署才生效，所以不要先部署再補設定。檢查完成不能保證供應商未來永不故障，但可避免已知缺項造成的重複部署。

檢查命令：`node --env-file=.env scripts/check-ai-connectivity.mjs`。加 `--generate` 只用同一 Gemini 金鑰送出固定測試文字，不讀寫 Firebase；會產生少量 token 費用，遇到付款、用量或網路錯誤便停止，不自動重試。AI 專項測試 20 項、專項 lint、TypeScript、正式建置及建置前 6 項 Functions 執行環境測試通過。

參考：[Google Interactions API](https://ai.google.dev/api/interactions-api)、[Google 帳務與 HTTP 402](https://ai.google.dev/gemini-api/docs/billing)、[Netlify 環境變數生效時機](https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/)。

## 2026-10-03：原專案金鑰輪替與重新實測

使用者已在原 Symbiosis Dashboard 專案建立新 API 金鑰並刪除舊金鑰。`v26.10.3.7` 清除舊金鑰與指紋，由使用者在本機 `.env` 填入新金鑰後，重新核對 Google AI Studio 顯示的 `summer94232@gmail.com`、`gen-lang-client-0155504975` 與新金鑰尾碼，並將新金鑰的 SHA256 指紋寫入本機設定。新金鑰採 Google 授權金鑰格式，繼續透過 `x-goog-api-key` 標頭使用，沒有改用其他帳號。

新金鑰取得的模型清單包含兩個已選 Gemini 模型。使用正式程式的請求格式、固定「只回覆 OK」文字，各做一次真實生成，`gemini-3.8-flash` 與 `gemini-3.5-flash-lite` 均回傳 HTTP 200，文字及用量解析成功，每次輸入 16／輸出 1 token，未使用搜尋工具、未送出筆記、未讀寫 Firebase。Google 頁面目前顯示 Tier 1 · Prepay；新金鑰的這次生成已不再受到先前 HTTP 402 阻擋。輪替本身不改變帳務，不能由此推定後續餘額永遠足夠。

本機後端的 Firebase 驗證設定、知識庫服務帳號及實際資料庫額度仍有缺項，因此整體預檢仍回傳失敗，不能宣稱正式系統已完成端到端驗證。生成測試只在測試程序暫時啟用 AI，`.env` 保留 `AI_ENABLED=false`，既有本機 UI 預覽仍使用固定示範資料。正式 Netlify 尚未配置新的 AI 金鑰，本次未修改正式環境或部署。後续需先補齊後端設定、完成本機登入與資料檢索驗證，再取得使用者對正式設定與整批部署的明確批准。

本批 TypeScript、正式建置及建置前 6 項 Functions 執行環境測試通過；確認建置產物包含 `v26.10.3.7`，且不包含新金鑰。既有大型 chunk 提示仍存在，沒有新增建置失敗。

參考：[Google 金鑰類型與使用方式](https://ai.google.dev/gemini-api/docs/api-key)。

## 2026-10-03：補齊本機後端設定與真實預覽

`v26.10.3.8` 已補齊本機投資與知識庫後端設定、允許 UID、原 Google 新金鑰與指紋、Gemini 模型範圍、月費目標與每日 AI 子額度。Netlify 只做唯讀查詢；Firebase CLI 登入帳號先確認為 `summer94232@gmail.com`，沒有切換 Google 帳號。兩個 Firebase 專案均沿用現有有效的下載憑證，未建立／更換服務帳號金鑰或修改 IAM 權限。

唯讀核對投資專案 `stocksserver-45482` 與知識庫專案 `tw-kms-jiawei`，兩者皆為有帳務的 Standard／Native Firestore，預設資料庫皆享有免費額度；Service Usage API 回報每日讀取 50,000、寫入 20,000。近期八個 24 小時對齊區間的投資讀取最高 15,433、寫入最高 304；知識庫讀取最高 108，寫入指標沒有資料點。這些是監控統計，並非永久用量保證或精確太平洋時區帳單。兩個專案的 AI 先各設每日讀取 1,000、寫入 400，約免費額度各 2%，低於使用者接受的 20% 上限目標，並保留原功能空間。AI 預留按台北日期重置，Firebase 免費額度按太平洋日期重置，因此仍採保守子額度，不把兩者當成同一計費日。

兩個既有允許帳號皆通過投資／知識庫帳號啟用與 UID 對應核對，全文索引皆 ready：106 則／16 頁及 21 則／13 頁，皆在 AI 單次 32 頁限制內。投資資料庫讀取通過。以一個既有允許帳號的真實 Firebase ID token 驗證本機 AI 驗證路徑，status 回傳 HTTP 200、金鑰指紋驗證成功，未登入請求 HTTP 401；使用暫時唯讀 status 模式，沒有建立 Firestore 費用、偏好或聊天文件。

聯網實測發現明確設定 `search_types` 時，本帳戶收到未執行的 `google:search` function_call。改為官方文件的 `tools: [{ type: 'google_search' }]` 後，兩個選定 Gemini 模型皆完成公開官方文件搜尋、最終文字與來源解析。搜尋建議改讀取實際回應的 `google_search_result.result[].search_suggestions`，保留原有 sandbox iframe。這些測試沒有向模型傳送私人筆記，沒有自動重試或切換模型。

新增 `scripts/prepare-ai-functions-env.mjs`，將 16 項新增 AI Functions 變數存到被 Git 忽略的 `local-secrets/ai-netlify-functions.env`，不包含既有 production API 驗證設定，不會自行呼叫 Netlify 或部署。未來批准後只將新變數加入 production／Functions 範圍，Gemini 金鑰與知識庫憑證應設為 secret。來源採 Netlify 現代 Request／Response Functions，避免 Lambda 相容模式的 4 KB 環境變數限制；同步執行上限為 60 秒，模型請求保留原有時限。

真實本機預覽使用 `npm run preview:ai`，網址 `http://127.0.0.1:5187/invest`；先執行 `npm run build`。此服務只綁定 `127.0.0.1`，提供正式建置與同一套登入保護的 Functions，不取用 Netlify 遠端環境變數，不提供公開通道。避開本機 Netlify CLI 的前端模組重寫與靜態資源 403 問題。原本 5186 的固定示範預覽仍保留。使用者須在 5187 正常登入才能對談，實際操作會使用 API 額度与雲端資料，縮小或切換頁面仍保留本機目前對話。

本機設定預檢沒有缺項；AI 專項測試 20 項、Functions 執行環境 6 項、專項 lint、TypeScript 與正式建置通過。真實預覽的首頁與 JavaScript 回傳 200、秘密檔案路徑回傳 404、未登入 AI 回傳 401、錯誤方法回傳 405。前端建置不含新 Gemini 金鑰或兩個 Firebase 私鑰。從瀏覽器已登入的真實浮窗送出固定連線測試，成功顯示「連線正常」，完成費用預留／結算與設定載入，僅寫入 AI 用量資料。另已從真實知識庫取得一則筆記的原始段落，沒有將其送给模型；唯讀 IAM 權限檢查確認知識庫可讀取、新增與更新。沒有寫入新偏好或測試筆記，正式環境變數沒有設定或部署。

設定與真實回覆截圖：`docs/ai-settings-2026-10-03/ai-ready.jpg`。本機已沿用目前瀏覽器登入狀態，可直接在真實預覽繼續對談；若開新瀏覽器需正常登入。新增的 Gemini 金鑰、知識庫服務帳號及其他 14 項設定仍須在正式 Netlify production／Functions 環境加入後，連同程式做一次批准後的部署才會生效。不需另建立 Netlify API 金鑰或另一把 Google 金鑰。

## 2026-10-03：一次部署前的整批核對

使用者要求避免因缺少設定再部署第二次，因此對同一批 `v26.10.3.8` 補做發布範圍驗證，沒有修改應用程式或新增版本。`npm test` 的主測試 727 項、介面同步 3 項、介面測試 5 項及 Functions 執行環境 6 項共 **741 項通過，0 項失敗、0 項跳過**。既有正式前端建置與真實 Gemini／Firebase 驗證結果沿用。

使用已快取的 Netlify CLI 27.5.2 所附 `zip-it-and-ship-it` 在本機打包全部 **16 支 Functions**，包含 `ai-assistant`，全部辨識為現代 runtime API v2。輸出僅存於被 Git 忽略的 `.codex-tmp/ai-release-functions`，沒有上传或建立部署。

Netlify 唯讀核對確認既有三項 API 登入設定皆涵蓋 Functions；投資專案與允許 UID 和本機相符。16 項新增設定包的內容逐項與本機 `.env` 比對一致，正式 Netlify 尚未加入這 16 項。另查到正式環境仍有舊 `VITE_GEMINI_API_KEY`，目前前端與後端來源已不再使用此變數。取得本批次正式批准後，應先加入新的後端設定、移除舊的前端 Gemini 變數並確認範圍，再一次發布已核對的前端和後端；不要先部署再補變數。此核對未修改任何正式環境設定。

目前沒有已知會阻擋這批 AI 上線的設定或打包缺項；正式網址的最終驗收仍須在部署完成後執行。本機實測與打包成功不能保證供應商或正式執行環境永不失敗，也不能預先宣稱正式站已通過驗收。

參考：[Firestore 免費額度與重置時間](https://firebase.google.com/docs/firestore/quotas)、[Google Search 回應](https://ai.google.dev/gemini-api/docs/google-search)、[Netlify Functions 執行設定](https://docs.netlify.com/build/functions/configuration/)、[Netlify Lambda 相容模式限制](https://docs.netlify.com/build/functions/lambda-compatibility/)。
