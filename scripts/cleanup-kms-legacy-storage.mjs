import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { applicationDefault, initializeApp } from 'firebase-admin/app'
import { getStorage } from 'firebase-admin/storage'

function option(name, fallback = '') {
  const prefix = `--${name}=`
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || fallback
}

const reportPath = option('report')
const projectId = option('project', process.env.KMS_FIREBASE_PROJECT_ID)
const storageBucket = option('bucket', process.env.KMS_FIREBASE_STORAGE_BUCKET)
const commit = process.argv.includes('--commit')
if (!reportPath || !projectId || !storageBucket) {
  throw new Error('請提供 --report=<migration-json>、--project=<kms-project-id>、--bucket=<bucket>')
}

const report = JSON.parse(await readFile(resolve(reportPath), 'utf8'))
if (report.mode !== 'commit' || report.failed?.length) {
  throw new Error('只接受已完成且沒有失敗項目的 commit 遷移報告')
}

function pathFromUrl(url) {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    const encoded = parsed.pathname.match(/\/o\/(.+)$/)?.[1]
    return encoded ? decodeURIComponent(encoded) : ''
  } catch {
    return ''
  }
}

const candidates = new Set()
for (const row of report.notes || []) {
  const summary = row.summary || {}
  const paths = [pathFromUrl(summary.imageUrl), pathFromUrl(summary.fileUrl)]
  for (const asset of summary.assets || []) {
    paths.push(asset.storagePath, asset.thumbnailPath, pathFromUrl(asset.downloadUrl), pathFromUrl(asset.thumbnailUrl))
  }
  for (const path of paths.filter(Boolean)) {
    // 只允許刪除明確的舊全域路徑，永遠不碰 users/{uid}/... 新檔案。
    if (path.startsWith('images/') || path.startsWith('files/')) candidates.add(path)
  }
}

const result = { mode: commit ? 'commit' : 'dry-run', candidates: [...candidates], deleted: [], failed: [] }
if (commit) {
  const app = initializeApp({ credential: applicationDefault(), projectId, storageBucket }, 'kms-cleanup')
  const bucket = getStorage(app).bucket(storageBucket)
  for (const path of candidates) {
    try {
      await bucket.file(path).delete({ ignoreNotFound: true })
      result.deleted.push(path)
    } catch (error) {
      result.failed.push({ path, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

const resultPath = resolve(`${reportPath}.cleanup-${commit ? 'commit' : 'dry-run'}.json`)
await writeFile(resultPath, JSON.stringify(result, null, 2), 'utf8')
console.log(JSON.stringify({ ...result, resultPath }, null, 2))
if (result.failed.length) process.exitCode = 2
