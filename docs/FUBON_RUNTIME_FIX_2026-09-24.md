# 富邦測試版：Firebase 載入相容修正

仍屬 `v26.9.24.3` 同一整合批次。正式網站與富邦啟用旗標均未變動。

## 問題與證據

- 使用者交接的測試部署為 `6ab4da6ed95442ad17e5d0d0`。依交接報告，7 個引用 Firebase Admin 的入口發生 `ERR_REQUIRE_ESM`，其餘行事曆入口不受同一載入錯誤影響。
- 本機 Node 24.14.0 一般模式能載入；加入 `--no-experimental-require-module` 後，實際重現 `fubon-snapshot`、`news-proxy` 的同一錯誤，`google-calendar-auth` 能載入。
- 原因是 `firebase-admin@14.2.0 → jwks-rsa@4.1.0 → jose@6.2.8`，其中 CommonJS 同步載入 ESM 依賴雲端未提供的相容支援。
- 上游依據：[jwks-rsa changelog](https://github.com/auth0/node-jwks-rsa/blob/master/CHANGELOG.md)、[Firebase Admin issue 3181](https://github.com/firebase/firebase-admin-node/issues/3181)。

## 本機已完成

- `package.json` 加入範圍限定的 override：`firebase-admin` 底下的 `jwks-rsa` 固定 `3.2.2`，解析到 `jose@4.15.9`。保留 Firebase CLI 其他依賴的 `jose@6.2.8`，不做全域降版。
- 在 Windows 執行 `npm install --no-audit --no-fund --ignore-scripts`，更新根目錄 lockfile。僅新增／移除該相容依賴樹，不覆蓋其他未提交修改。
- 新增 `tests/firebase-runtime.test.mjs`：真實 Firebase Admin／Fubon SDK 模組載入，以及用本機 loopback JWKS、臨時 RSA 金鑰驗證有效、竄改與過期 token。測試不使用真實登入資料，不連接富邦或 Google。
- 新增 `npm run test:function-runtime`，使用 `--no-experimental-require-module` 跑 11 個入口與 JWT 相容檢查；`posttest` 和 `prebuild` 自動執行此門檻，避免再次只測預設 Node 行為。
- 原有測試 477 項通過；額外 runtime 測試 6 項通過；lint、TypeScript／Vite 建置通過。建置仍有原本的大型前端 chunk 提示。
- 本機日誌：`.local-tools/fubon-compat-tests.log`、`fubon-compat-build.log`、`fubon-compat-lint.log`。

## 部署與剩餘工作

- 已準備 `.local-tools/deploy-fubon-compat-draft.mjs`：只建立新的草稿，強制重新打包，不含 `--prod`，不改雲端環境變數；部署前後比對正式 deployment ID。
- 首次嘗試執行該草稿腳本被自動核准審查拒絕，原因為交接報告中的批准未被認定為本批直接部署批准。使用者隨後直接回覆「如果要部署才能測試就批准」，已取得本批草稿部署授權；正式部署與環境變數修改不在此次範圍內。
- 修正版草稿已部署：`6ab51ada3474283ab67659d7`，網址為 https://6ab51ada3474283ab67659d7--symbiosis-jiawei.netlify.app 。Netlify 確認 context 為 `deploy-preview`、state 為 `ready`、`published_at` 為 null。
- 11 個入口共 15 項雲端 HTTP 檢查全部通過：七個受保護入口未登入正常回 401；ensure／pull／sync 缺參數回 400、OPTIONS 回 200；Google OAuth 回 302 並導向 Google；富邦錯誤方法回 405。未再出現 `ERR_REQUIRE_ESM` 或 502。前端確認版本 `v26.9.24.3`。
- 正式部署前後均為 `6aad8126bef698564654e725`，未更動正式網站。部署後管理 API 一度 429，沿用已建立的草稿完成驗證，未重複上傳。驗證報告為 `.local-tools/fubon-compat-draft-verification.json`。
- 富邦五項設定存在各環境，但 `API_FIREBASE_PROJECT_ID`、`API_ALLOWED_UIDS`、`API_FIREBASE_SERVICE_ACCOUNT` 只有 Production 值。雲端以固定無效測試 token 驗證，富邦入口明確回 503「API 安全設定尚未完成」，因此尚未進入 Firebase token 驗證及富邦登入。
- 實際富邦登入前，需另取得測試環境安全設定的授權與安全配置途徑，或另獲正式部署但保持富邦旗標關閉的批准；不得略過既有登入或白名單檢查。
- 部分市場失敗的詳細提示、手動全富果重試，以及真實盤後補價／速度驗證仍未完成。

## Deploy Preview 安全設定後續

- 使用者回覆「批准 同意補上」，授權補上三項 Deploy Preview 安全設定。
- 已透過 Netlify PATCH 個別 context API，將既有 `API_FIREBASE_PROJECT_ID` 與 `API_ALLOWED_UIDS` 複製到 `deploy-preview`。回讀確認值相同，其他設定及正式 deployment 均未變更。唯讀結果摘要：`.local-tools/fubon-preview-public-auth.json`。
- 原始服務帳戶私密金鑰由既有 provision 腳本直接存入 Netlify，未存本機；Netlify secret 無法讀回，專案 `.env` 與程序環境亦無現成服務帳戶值。
- 已準備 `.local-tools/configure-fubon-preview-auth.mjs`，原規劃沿用同一服務帳戶建立測試專用金鑰，直接寫入 Netlify，保留正式金鑰與 IAM 權限；此腳本**尚未執行**。自動核准審查拒絕原因：補上測試設定的授權不包含明確建立／部署新的服務帳戶金鑰，且可由使用者重新提供既有值。
- 等待使用者明確批准建立上述測試金鑰，或自行在 Netlify 重新填入既有服務帳戶 JSON。不要將 JSON 貼入聊天。尚未新增金鑰、修改第三項設定或重新部署；真實富邦雲端登入仍未驗證。

### 已取得金鑰批准並完成設定（同日後續）

- 使用者明確回覆「同意」建立同一服務帳戶的測試用金鑰。已執行設定腳本，金鑰僅經記憶體直接送至 Netlify `deploy-preview` 的 secret 值，未輸出或寫入本機；IAM 權限、正式金鑰及其他環境設定均保持不變。安全結果為 `.local-tools/fubon-preview-auth-setup.json`，僅記錄金鑰名稱等非私密狀態。
- 三項 Preview 安全設定已完整。重新部署同批測試版成功：`6ab521e05dfa4824d67fd1ee`，網址 https://6ab521e05dfa4824d67fd1ee--symbiosis-jiawei.netlify.app 。正式部署仍為 `6aad8126bef698564654e725`。
- 11 個函式共 15 項 HTTP 檢查通過；額外富邦無效 token 檢查由缺設定的 503 轉為預期的 401，`missingPreviewSecuritySettings: false`。這僅證實設定可載入、無效憑證正常拒絕，**不代表已驗證真實使用者 token、服務帳戶 OAuth／Firestore 權限或富邦 SDK 登入**。
- 驗證程序的 Netlify 管理 API 讀取遇到限流；已使用同次部署程序成功完成的 production postcheck 補上結果，沒有重跑已通過 HTTP 檢查或重複部署。紀錄在 `.local-tools/fubon-preview-auth-draft-verification.json`。
- 瀏覽器已開啟新測試版，畫面為登入頁；已請使用者直接在網頁登入，不收集聊天密碼。富邦前端旗標仍關閉，後續尚需準備測試版的可操作快照驗證入口並完成真正登入查詢；正式部署與啟用仍待另行授權。
- 使用者後續已登入，瀏覽器確認投資儀表板正常顯示。因該前端的富邦旗標仍關閉，另以忽略的 `.local-tools/fubon-qa.mjs`／`build-fubon-qa.mjs` 建立獨立只讀測試頁，使用既有 Firebase 前端套件與相同快照價格判讀規則，僅查詢 2330 與 6488，呈現兩市場日期、價格類型及耗時。不含資產或快照資料寫入功能，只有既有後端 API 配額計數；JS 僅內含公開 Firebase web config，秘密標記檢查通過。輸出位於 `.local-tools/fubon-qa-site`，不加入正式 `dist`。
- 固定別名 `fubon-qa` 的部署 `6ab5237cd54a9c2a9a3f9807` 被 Netlify 歸類為 `branch-deploy`，所以不適用已批准的 Preview 設定。該頁不作為實測入口；沒有擴大環境變數範圍，後續移除 alias，重新建立一般 Deploy Preview。部署腳本亦增加 context 驗證與管理 API 429 的有限次退避，並保留成功上傳 ID，避免因 postcheck 限流而重複上傳。

## 只讀快照 502 診斷（9/25 凌晨，同一整合批次）

- 使用者已在只讀頁登入並測試，回報 HTTP 502、4.90 秒；瀏覽器亦顯示一次 4.99 秒失敗。僅憑原始通用 502 不能判断 SDK／憑證／登入／行情哪一步失败。CLI 日誌摘要沒有提供可辨別原因。
- 新增 `netlify/lib/fubon-diagnostic.js`，以固定 allowlist 分類 `sdk-load`、`certificate`、`sdk-create`、`login`、`realtime`、`snapshot`、`response`。SDK adapter 分段包裝錯誤；後端只向已授權使用者回傳固定階段／原因，既有匿名、白名單及配額檢查保持。原始訊息、cause、堆疊、檔案路徑與秘密不會回傳。部分市場成功的結果照常保留。
- 相關 14 項測試與 lint 通過；包含錯誤內容帶假秘密時不得外洩，以及登入和 realtime 失敗要能區分；QA 頁重新打包與秘密標記檢查通過。此處是同批驗證修正，保留版本 `v26.9.24.3`。
- 最新診斷測試部署：`6ab561e023c36a74939b5c54`，https://6ab561e023c36a74939b5c54--symbiosis-jiawei.netlify.app ，確認 Deploy Preview、ready、正式 deployment 未變。`.local-tools/fubon-qa-preview-result.json` 已指向此版。
- 已向使用者說明：信箱密碼用於個人系統的 Firebase 驗證；富邦連線仍在後端使用 API Key＋憑證，兩層用途不同。已開啟新頁，請使用者重新登入並按測試以取得安全診斷；**502 尚未定位／修復，不能宣稱富邦雲端快照已通過**。

## 憑證階段失敗的實際原因與修正進度

- 使用者回報新診斷為兩市場皆 `certificate / certificate-invalid`。回讀設定確認：**五項富邦變數只有 Production 非空，Deploy Preview／dev 等環境雖有 value entry，但實際 value 都是空字串**。先前交接與檢查僅看 context 名称存在，誤判「所有環境都已配置」，已向使用者更正。不是目前已有證據顯示原始 PFX 損壞。
- `.local-tools/check-fubon-env-contexts.mjs` 已增加每個 context 的非空 `configured` 判斷。`.local-tools/check-fubon-cert-parts.mjs` 的安全比對報告確認本機原始 PFX 為 5294 bytes／Base64 7060 chars，原 Preview 兩段皆空。此報告不含秘密。
- 自動審查起初拒絕重傳本機私有 PFX，理由為先前授權僅涵蓋 Firebase 三項設定。使用者隨後明確回覆「批准」補上五項富邦測試設定，已解決授權阻擋。
- 已執行 `.local-tools/set-fubon-preview-cert.mjs`，將本機原始 PFX 拆為 4000 與 3060 字元，僅 PATCH 兩個 `deploy-preview` 值，回讀確認非空、正式與其他設定未變。結果 `.local-tools/fubon-preview-cert-setup.json`。
- 已準備並開啟互動 PowerShell `.local-tools/enter-fubon-preview-login.ps1`，由使用者親自輸入剩餘三項富邦資料。透過隱藏輸入與 stdin 傳給 `.local-tools/set-fubon-preview-login.mjs`，直接寫入 Netlify Preview，原值不放命令列、聊天或本機檔案。使用者也可從 `.local-tools/enter-fubon-preview-login.cmd` 啟動。語法檢查已通過。
- 待使用者完成輸入，檢查 `.local-tools/fubon-preview-login-setup.json` 及實際 Preview 五項非空；完成後才重新部署 QA 並再次測試。不要讀取、輸出使用者輸入或假設已完成；目前尚未重新部署套用新憑證，亦未證實富邦登入成功。
- 使用者隨後回覆「完成」。已讀取安全狀態報告，確認剩餘三項成功存入 Preview；重新透過 Netlify API 驗證五項富邦與三項安全設定全部 `configured: true`，正式及其他環境未變。開始重新部署 QA 套用完整設定；無程式變更，不重跑已通過測試。
- 套用完整設定的新 QA 部署已 ready、context 為 Deploy Preview：`6ab564ac152a34ea0821b163`，https://6ab564ac152a34ea0821b163--symbiosis-jiawei.netlify.app 。已在瀏覽器開啟並請使用者登入個人系統，以便執行真正快照測試；尚不能把設定非空或 ready 當成富邦查詢成功。
- **真實雲端測試已成功**：使用者登入並執行測試，瀏覽器確認兩市場皆成功。TSE 2330 為 2475、OTC 6488 為 948，均標示 `reference`，來源日期 2026-09-24，`failedMarkets: []`。第一次觀察耗時 10.10 秒；助理透過測試按鈕追加一次驗證，耗時 2.63 秒且結果相同。後者是後續請求實測，不保證一定命中同一 instance 或快取。
- 這次成功路徑包含既有 Firebase 真實 token／白名單／配額、Linux SDK 載入、憑證還原、富邦 API Key 登入與兩市場快照；未繞過登入、未下單、未寫入持倉或資產快照。安全結果存於 `.local-tools/fubon-cloud-snapshot-verified.json`。原始 502 的缺值原因已排除。
- 正式部署仍為 `6aad8126bef698564654e725`，`VITE_FUBON_SNAPSHOT_ENABLED` 仍未設定。後續工作：完整儀表板混合更新與持倉盤後補價驗收、部分市場失敗提示與手動全富果重試，完成後才另取得正式部署／啟用批准。

## 使用者限制

使用者本次交接表示已取消先前的用量保留限制。若之後重新提出限額，依新指示處理。正式部署與啟用仍須另行批准。
