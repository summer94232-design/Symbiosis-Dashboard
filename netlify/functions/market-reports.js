import { createHash } from 'node:crypto'
import { authorizeApiIdentity, apiError, apiHeaders, cachedApi } from '../lib/api-access.js'
import { invokeEventHandler } from '../lib/http-function.js'
import { GOOGLE_ACCOUNT_EMAIL, hasGoogleReportAuthorization } from '../lib/google-authorization.js'
import { REPORT_FILE_NAME, parseReportRows, taipeiDate } from '../lib/market-reports.js'
import { validateAnnualEntry } from '../lib/annual-calendars.js'

const failure = (status, message, code) => Object.assign(new Error(message), { status, code })
async function readGoogleReports(connection) {
    const signal = AbortSignal.timeout(20000)
    const clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET
    if (!clientId || !clientSecret) throw failure(503, 'Google 授權設定尚未完成', 'GOOGLE_CONFIGURATION')
    const exchange = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', signal,
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: connection.refreshToken, grant_type: 'refresh_token' }) })
    const token = await exchange.json()
    if (!exchange.ok && token.error === 'invalid_grant') throw failure(401, 'Google 授權已失效，請到行事曆設定重新授權', 'GOOGLE_RECONNECT')
    if (!exchange.ok || typeof token.access_token !== 'string' || !token.access_token) throw failure(503, 'Google 授權服務暫時無法使用，請稍後重試', 'SOURCE_UNAVAILABLE')
    const headers = { Authorization: `Bearer ${token.access_token}` }
    const request = async url => {
        const response = await fetch(url, { headers, signal })
        if (!response.ok) {
            if (response.status === 401) throw failure(401, 'Google 授權已失效，請重新授權', 'GOOGLE_RECONNECT')
            if (response.status === 403) throw failure(403, 'Google 無法讀取報告，請確認 Drive／Sheets API 已啟用及讀取權限', 'GOOGLE_ACCESS')
            if (response.status === 404) throw failure(404, '報告來源已移除或無法讀取', 'SOURCE_MISSING')
            throw failure(503, 'Google 報告來源暫時無法讀取，請稍後重試', 'SOURCE_UNAVAILABLE')
        }
        return response.json()
    }
    const user = await request('https://openidconnect.googleapis.com/v1/userinfo')
    if (user.email !== GOOGLE_ACCOUNT_EMAIL || user.email_verified !== true || user.sub !== connection.googleAccountId) {
        throw failure(403, 'Google 連線帳號不符，請到行事曆設定重新授權', 'GOOGLE_RECONNECT')
    }
    let pageToken = '', fallback = false, formatFailure = false
    for (let attempt = 0; attempt < 3; attempt++) {
        const query = new URLSearchParams({ q: `name = '${REPORT_FILE_NAME}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false and '${GOOGLE_ACCOUNT_EMAIL}' in owners`,
            orderBy: 'createdTime desc', pageSize: '1', fields: 'nextPageToken,incompleteSearch,files(id,name,createdTime)', ...(pageToken ? { pageToken } : {}) })
        const list = await request(`https://www.googleapis.com/drive/v3/files?${query}`)
        if (list.incompleteSearch || !Array.isArray(list.files)) throw failure(503, '報告檔案搜尋未完成，請稍後重試', 'SOURCE_UNAVAILABLE')
        const file = list.files[0]
        if (file?.id && /^[\w-]+$/.test(file.id)) {
            try {
                const sheet = await request(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(file.id)}/values/A1:F?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`)
                let parsed
                try { parsed = parseReportRows(sheet.values) }
                catch { throw failure(422, '報告格式尚未完整', 'REPORT_FORMAT') }
                const now = new Date(), today = taipeiDate(now)
                const reports = parsed.reports.filter(report => report.date <= today && new Date(report.updatedAt.replace(' ', 'T') + '+08:00') <= now)
                if (reports.length) return { reports, source: { id: file.id, name: REPORT_FILE_NAME, createdTime: file.createdTime || '',
                    fallback, invalidRows: parsed.invalidRows + parsed.reports.length - reports.length } }
                formatFailure = true
            } catch (error) {
                if (error.status !== 404 && error.code !== 'REPORT_FORMAT') throw error
                formatFailure = true
            }
        }
        if (!list.nextPageToken) break
        pageToken = list.nextPageToken; fallback = true
    }
    throw failure(404, formatFailure ? '最新試算表尚無完整可閱讀報告，請稍後重新讀取' : '找不到「台股每日投資報告資料庫」', 'REPORT_EMPTY')
}

export const handleEvent = async event => {
    const identity = await authorizeApiIdentity(event, 'marketReports')
    if (identity.statusCode) return identity
    const selectedId = event.queryStringParameters?.report
    if (selectedId && !/^20\d{2}-\d{2}-\d{2}:(pre|post)$/.test(selectedId)) return apiError(400, '報告選擇格式錯誤')
    try {
        const connection = (await identity.db.doc(`users/${identity.uid}/settings/googleCalendarAuth`).get()).data()
        if (!hasGoogleReportAuthorization(connection) || !connection?.refreshToken || !connection.googleAccountId) {
            return { statusCode: 403, headers: apiHeaders, body: JSON.stringify({ error: '請到行事曆設定補充報告授權', code: 'GOOGLE_RECONNECT' }) }
        }
        // Never share report caches between users or across a replaced Google grant.
        const key = 'reports:' + createHash('sha256').update(JSON.stringify([identity.uid, connection.refreshToken, connection.googleAccountId])).digest('hex')
        const result = await cachedApi(key, 60000, () => readGoogleReports(connection), event.queryStringParameters?.refresh === '1')
        const selected = selectedId ? result.reports.find(report => report.id === selectedId) : null
        if (selectedId && !selected) return apiError(404, '所選歷史報告不存在，請重新讀取報告清單')
        let holidays = []
        try {
            const year = Number(taipeiDate().slice(0, 4))
            const calendar = (await identity.db.doc('sharedData/annualCalendars').get()).data()
            // Official parsing excludes settlement-only days; these are confirmed trading holidays.
            holidays = validateAnnualEntry('settlement', year, calendar?.settlement?.[year]).dates
        } catch { /* Missing official coverage is not evidence that today is a holiday. */ }
        return { statusCode: 200, headers: apiHeaders, body: JSON.stringify({ ownerUid: identity.uid, source: result.source,
            latest: result.reports[0], selected, reports: result.reports.map(({ id, date, period, title, summary, updatedAt }) => ({ id, date, period, title, summary, updatedAt })), holidays, checkedAt: new Date().toISOString() }) }
    } catch (error) {
        const known = ['GOOGLE_CONFIGURATION', 'GOOGLE_RECONNECT', 'GOOGLE_ACCESS', 'SOURCE_MISSING', 'SOURCE_UNAVAILABLE', 'REPORT_EMPTY', 'REPORT_FORMAT'].includes(error.code)
            && [401, 403, 404, 422, 503].includes(error.status)
        return { statusCode: known ? error.status : 503, headers: apiHeaders, body: JSON.stringify({ error: known ? error.message : '報告讀取未完成，請稍後重試', code: known ? error.code : 'SOURCE_UNAVAILABLE' }) }
    }
}
export default async function (request) { return invokeEventHandler(request, handleEvent) }
