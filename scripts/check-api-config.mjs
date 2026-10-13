// Read-only preflight. Do not print credentials, private keys, tokens, or allowed UIDs.
export function validateApiConfig(env) {
    const errors = []
    if (!env.API_FIREBASE_PROJECT_ID) errors.push('缺少 API_FIREBASE_PROJECT_ID')
    if (!(env.API_ALLOWED_UIDS || '').split(',').some(value => value.trim())) errors.push('缺少 API_ALLOWED_UIDS')
    try {
        const account = JSON.parse(env.API_FIREBASE_SERVICE_ACCOUNT || '')
        if (account.project_id !== env.API_FIREBASE_PROJECT_ID) errors.push('服務帳號專案與 API_FIREBASE_PROJECT_ID 不一致')
        if (!account.client_email || !account.private_key?.includes('BEGIN PRIVATE KEY')) errors.push('服務帳號缺少必要欄位')
    } catch { errors.push('API_FIREBASE_SERVICE_ACCOUNT 必須是有效的服務帳號 JSON') }
    return errors
}
import { pathToFileURL } from 'node:url'
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const errors = validateApiConfig(process.env)
    if (errors.length) { errors.forEach(error => console.error(error)); process.exitCode = 1 }
    else console.log('API 設定格式檢查通過；尚未驗證遠端權限或部署狀態。')
}
