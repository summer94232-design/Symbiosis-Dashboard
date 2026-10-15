export const REQUIRED_FUNCTION_SETTINGS = [
    'FUGLE_API_KEY', 'GEMINI_API_KEY', 'AI_ENABLED', 'AI_ALLOWED_PROVIDERS', 'AI_GEMINI_PAID',
    'AI_GEMINI_ACCOUNT', 'AI_GEMINI_PROJECT', 'AI_GEMINI_KEY_SHA256', 'AI_KMS_PROJECT_ID',
    'AI_KMS_SERVICE_ACCOUNT', 'AI_MONTHLY_TWD', 'AI_DAILY_TWD', 'AI_TURN_TWD', 'AI_RESEARCH_TWD',
    'AI_USD_TWD', 'AI_INVEST_DAILY_READS', 'AI_INVEST_DAILY_WRITES', 'AI_KMS_DAILY_READS',
    'AI_KMS_DAILY_WRITES', 'AI_DB_QUOTAS_CONFIRMED',
]
const secrets = new Set(['FUGLE_API_KEY', 'GEMINI_API_KEY', 'AI_KMS_SERVICE_ACCOUNT'])

/** Fixed allowlist: no frontend variables or new settings can hitchhike on a release. */
export function productionFunctionOverrides(env) {
    const missing = REQUIRED_FUNCTION_SETTINGS.filter(key => typeof env[key] !== 'string' || !env[key].trim())
    if (missing.length) throw new Error(`缺少正式 Functions 設定：${missing.join('、')}`)
    return REQUIRED_FUNCTION_SETTINGS.map(key => ({ key, value: env[key], scopes: ['functions'], is_secret: secrets.has(key) }))
}

export function functionOverrideArguments(overrides) {
    if (overrides.length !== REQUIRED_FUNCTION_SETTINGS.length || new Set(overrides.map(row => row.key)).size !== overrides.length
        || REQUIRED_FUNCTION_SETTINGS.some(key => !overrides.some(row => row.key === key))
        || overrides.some(row => row.scopes?.length !== 1 || row.scopes[0] !== 'functions'
            || row.is_secret !== secrets.has(row.key) || typeof row.value !== 'string' || !row.value.trim())) {
        throw new Error('正式 Functions 覆寫不完整或範圍不正確')
    }
    return overrides.flatMap(row => [row.is_secret ? '--secret-env' : '--env', `${row.key}=${row.value}`])
}

export function safeFunctionSettingsSummary(overrides) {
    return overrides.map(({ key, scopes, is_secret }) => ({ key, scopes, isSecret: is_secret }))
}
