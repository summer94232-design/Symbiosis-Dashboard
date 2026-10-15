import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const required = ['FUGLE_API_KEY', 'API_FIREBASE_PROJECT_ID', 'API_FIREBASE_SERVICE_ACCOUNT', 'API_ALLOWED_UIDS']

// Remote secrets may be represented by opaque placeholders. Check availability,
// never parse, print, or return their values. This does not validate provider access.
export function validateQuoteDeploymentSettings(settings) {
    const missing = required.filter(key => typeof settings?.[key] !== 'string' || !settings[key].trim())
    return { ready: missing.length === 0, context: 'production', scope: 'functions', missing }
}

export async function checkQuoteDeployment(readSettings = async () => {
    try {
        const { stdout } = await promisify(exec)('netlify env:list --context production --scope functions --json', {
            windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
        })
        return JSON.parse(stdout)
    } catch { throw new Error('無法唯讀核對正式 Functions 設定；請檢查 Netlify CLI 登入與網路。') }
}) {
    return validateQuoteDeploymentSettings(await readSettings())
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const result = await checkQuoteDeployment()
        console.log(JSON.stringify(result))
        if (!result.ready) {
            console.error('正式報價必要設定缺漏，停止發布。單次部署覆寫不會自動保留到下一次部署。')
            process.exitCode = 1
        }
    } catch {
        console.error('無法核對正式報價設定，停止發布；未修改正式環境。')
        process.exitCode = 1
    }
}
