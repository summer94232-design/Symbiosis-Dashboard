const stages = new Set(['sdk-load', 'certificate', 'sdk-create', 'login', 'realtime', 'snapshot', 'response'])
const reasons = new Set(['module-missing', 'module-incompatible', 'native-library', 'certificate-invalid',
    'config-missing', 'timeout', 'connection', 'rejected', 'response-invalid', 'unknown'])

// Never return provider messages, error causes, credentials, paths, or stacks.
export function fubonDiagnostic(error) {
    if (stages.has(error?.fubonStage) && reasons.has(error?.fubonReason)) {
        return { stage: error.fubonStage, reason: error.fubonReason }
    }
    return { stage: 'snapshot', reason: 'unknown' }
}

export async function fubonStage(stage, operation) {
    try { return await operation() }
    catch (original) {
        const message = typeof original?.message === 'string' ? original.message.slice(0, 8192) : ''
        const code = typeof original?.code === 'string' ? original.code : ''
        const text = `${code} ${message}`
        let reason = 'unknown'
        if (/GLIBC_|ERR_DLOPEN_FAILED|libssl|libcrypto|invalid ELF|shared object/i.test(text)) reason = 'native-library'
        else if (/MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot find (?:module|package|native binding)/i.test(text)) reason = 'module-missing'
        else if (/ERR_REQUIRE_ESM|Dynamic require|fubon-sdk-incompatible|not a constructor/i.test(text)) reason = 'module-incompatible'
        else if (/fubon-cert-(?:parts-)?invalid|PKCS|PFX|certificate|憑證/i.test(text)) reason = 'certificate-invalid'
        else if (/fubon-config-missing/.test(text)) reason = 'config-missing'
        else if (/ETIMEDOUT|AbortError|TimeoutError|timed? ?out/i.test(text)) reason = 'timeout'
        else if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|fetch failed|network/i.test(text)) reason = 'connection'
        else if (/fubon-login-failed/.test(text)) reason = 'rejected'
        else if (/fubon-response-invalid/.test(text)) reason = 'response-invalid'
        const error = new Error('fubon-operation-failed')
        error.fubonStage = stages.has(stage) ? stage : 'snapshot'
        error.fubonReason = reason
        throw error
    }
}
