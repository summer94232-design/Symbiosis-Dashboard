import { investAuth } from './auth'
import { captureUserSession } from './userDB'

/** A token is sent only to this application's protected functions. Never retry a metered request automatically. */
export async function authenticatedFetch(path: string, session = captureUserSession(), init: RequestInit = {}, returnHttpErrors = false): Promise<Response> {
    if (!/^\/\.netlify\/functions\/(news-proxy|foreign-quote|market-cap-proxy|yahoo-calendar-proxy|mops-proxy|fubon-snapshot|fubon-history|annual-calendars|dividend-announcements|quote-budget|fugle-proxy|ai-assistant|market-reports)(\?|$)/.test(path)) throw new Error('不允許的 API 目的地')
    session.assertActive()
    const user = investAuth.currentUser
    if (!user) throw new Error('請先登入')
    const token = await user.getIdToken()
    session.assertActive()
    const timeout = path.startsWith('/.netlify/functions/ai-assistant') ? 90000
        : path === '/.netlify/functions/fugle-proxy?batch=1' ? 45000 : 30000
    const response = await fetch(path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` }, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) })
    session.assertActive()
    const contentType = response.headers.get('Content-Type') || ''
    if (/\b(text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
        throw new Error('API 回傳網頁而非資料，請確認已啟動 Netlify 後端；純前端預覽無法使用此功能。')
    }
    if (!response.ok && !returnHttpErrors) {
        const body = await response.json().catch(() => ({}))
        const retry = response.headers.get('Retry-After')
        throw new Error(`${body.error || `API HTTP ${response.status}`}${response.status === 429 && retry ? `（約 ${retry} 秒後可再試）` : ''}`)
    }
    return response
}
