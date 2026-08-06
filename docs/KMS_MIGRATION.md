# KMS 安全規則與舊資料遷移

## 為什麼需要 UID 對照

KMS Firestore 的既有資料放在 `users/{investUid}/...`，但 kmsDB 收到的登入身分是 KMS Firebase Auth UID。同一個 email 在兩個 Firebase 專案不保證有相同 UID，因此不能直接部署只比較 `request.auth.uid == userId` 的規則。

`firestore.kms.rules` 支援兩種情況：

- 兩邊 UID 相同：直接允許自己的 `users/{uid}`。
- UID 不同：由 Admin SDK 把 `investUid` 寫入該 KMS Auth 使用者的 custom claim，並在 `uidMappings/{kmsUid}` 留下管理端稽核紀錄。前端完全不能讀寫 mapping。

規則直接讀取登入 token 的 claim，不會為每次 Firestore 請求多讀一份 mapping 文件。若 UID 不同而 claim 尚未建立，部署規則後該帳號的 KMS 讀寫會被拒絕；claim 建立後需登出再登入一次取得新 token。登入畫面、投資系統與其他 Firebase 專案不受這份規則影響。

## 前置條件

1. 安裝 Java 21 或目前 Firebase Emulator 支援的 JDK，確認 `java -version` 可執行。
2. 準備 Google Application Default Credentials，或設定 `GOOGLE_APPLICATION_CREDENTIALS` 指向 KMS 專案的服務帳戶 JSON。服務帳戶檔不可提交到 Git。
3. 從兩個 Firebase Authentication 控制台核對同一帳號的 `kmsUid` 與 `investUid`。
4. 設定 `KMS_FIREBASE_PROJECT_ID`、`KMS_FIREBASE_STORAGE_BUCKET`，或在每個命令提供 `--project`、`--bucket`。

UID 核對路徑：分別打開兩個 Firebase Console 專案 → Build → Authentication → Users → 用相同 email 找到使用者 → 複製 UID。兩個 UID 完全相同時不需要 `--map`；不同時使用 `--map=<kmsUid>:<investUid>`，不可顛倒。

若只要設定帳號對應、不要同時遷移筆記或圖片，請使用獨立的 UID 對應命令：

```powershell
npm.cmd run kms:uid-map:dry-run -- --project=<kms-project-id> --map=<kmsUid>:<investUid>
npm.cmd run kms:uid-map -- --project=<kms-project-id> --map=<kmsUid>:<investUid>
```

若本機尚未設定 Google Application Default Credentials，可將 KMS 專案的服務帳戶 JSON 放在專案外，並在命令加入 `--credentials=<json絕對路徑>`。服務帳戶金鑰不可提交到 Git。

可重複提供 `--map=` 一次處理多個帳號。此命令只更新 KMS Authentication custom claim 與管理端 `uidMappings` 稽核紀錄，不會搬移、刪除或改寫任何筆記與圖片。

若要求完全不寫入 Firestore，可在正式命令加入 `--claims-only`。這只更新 Authentication custom claim，不建立 `uidMappings` 稽核文件：

```powershell
npm.cmd run kms:uid-map -- --claims-only --project=<kms-project-id> --credentials=<json絕對路徑> --map=<kmsUid>:<investUid>
```

## 先驗證規則

```powershell
npm.cmd run test:kms-rules
```

測試包含 UID 對照、跨帳號拒絕、未登入拒絕、mapping 防竄改、圖片／縮圖／文件大小限制，以及舊全域 Storage 路徑唯讀。

## 遷移流程

所有命令預設以 40 則為一批。第一次只執行 dry run，不會改線上資料：

```powershell
npm.cmd run kms:migrate:dry-run -- --project=<kms-project-id> --bucket=<bucket> --map=<kmsUid>:<investUid>
```

檢查 `migration-backups/` 產生的 JSON，確認 `pending`、`failed`、`orphanBodies` 和原始資料內容。該資料夾可能包含私人正文與附件 URL，已加入 `.gitignore`。

確認後才正式遷移；這一步會先設定 KMS Auth custom claim 並建立管理端 mapping 紀錄，再逐筆以 Firestore batch 寫入摘要和正文，重新產生缺少的縮圖，並在每筆寫入後核對：

```powershell
npm.cmd run kms:migrate -- --project=<kms-project-id> --bucket=<bucket> --map=<kmsUid>:<investUid>
```

若有多個帳號，可重複 `--map=`；只處理單一資料路徑時加 `--user=<investUid>`。中途中斷可用相同參數再次執行，已完成資料會被略過。

## 舊 Storage 清理

遷移工具不會立即刪除舊檔。先登入正式網站抽查圖片、文件、展開正文與垃圾桶，再對成功且 `failed` 為空的 commit 報告執行清理 dry run：

```powershell
npm.cmd run kms:cleanup:dry-run -- --report=<commit-report.json> --project=<kms-project-id> --bucket=<bucket>
```

確認候選路徑全部位於 `images/` 或 `files/`，才執行：

```powershell
npm.cmd run kms:cleanup -- --report=<commit-report.json> --project=<kms-project-id> --bucket=<bucket>
```

清理程式硬性拒絕刪除 `users/{uid}/...`，並會輸出獨立結果 JSON。完成後才將 Storage 規則中舊 `/images`、`/files` 的 `read` 改為 `false`。

## 部署順序

1. 執行 Emulator 規則測試。
2. dry run 並檢查備份。
3. 正式遷移並確認 `failed: 0`、`orphanBodies: 0`。
4. 若兩邊 UID 不同，登出再登入以取得包含 `investUid` 的新 token，並抽查正式網站操作。
5. 部署 Firestore 與 Storage 規則：

```powershell
npx.cmd firebase deploy --only firestore:rules,storage --config firebase.kms.json --project <kms-project-id>
```

6. 規則部署後再次測試建立、編輯、展開、刪除、復原與附件上傳。
7. 最後才執行舊 Storage 清理與完全關閉舊路徑讀取。
