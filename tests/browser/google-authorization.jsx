import React from 'react'
import { createRoot } from 'react-dom/client'
import CalendarSettings from '../../src/pages/calendar/CalendarSettings'
import { GOOGLE_ACCOUNT_EMAIL, GOOGLE_AUTH_SCOPES } from '../../netlify/lib/google-authorization.js'
import { investAuth, state } from './services.mjs'
import '../../src/index.css'

const mode = new URLSearchParams(location.search).get('mode') || 'legacy'
const path = `users/${investAuth.currentUser.uid}/settings/googleCalendarAuth`
const legacy = { refreshToken: 'fixture-old-token', calendarId: 'fixture-existing-calendar',
    syncTypes: ['personal', 'fomc'], connectedAt: '2026-10-13T14:00:00Z' }
const verified = { ...legacy, refreshToken: 'fixture-new-token',
    googleEmail: GOOGLE_ACCOUNT_EMAIL, googleAccountId: 'fixture-google-account', grantedScopes: GOOGLE_AUTH_SCOPES }
investAuth.currentUser.getIdTokenResult = async () => ({ claims: { auth_time: 100 } })
if (mode !== 'new') state.rows.set(path, mode === 'verified' ? verified : legacy)
if (mode === 'callback') {
    const clientState = 'a'.repeat(64)
    sessionStorage.setItem('symbiosis.google.oauth.pending', JSON.stringify({
        uid: investAuth.currentUser.uid, authTime: 100, clientState, expires: Date.now() + 600000,
    }))
    location.hash = new URLSearchParams({ gcal_complete: '1', gcal_uid: investAuth.currentUser.uid,
        gcal_auth_time: '100', gcal_state: clientState }).toString()
}
if (mode === 'denied') location.hash = new URLSearchParams({ gcal_error: '請同時允許行事曆、試算表唯讀與報告檔案搜尋；原有連線已保留' }).toString()
window.fetch = async (url, init = {}) => {
    if (String(url).includes('google-calendar-auth?action=complete')) {
        if (new Headers(init.headers).get('Authorization') !== 'Bearer fixture-token') throw new Error('Missing fixture identity')
        state.rows.set(path, verified)
        return Response.json({ connected: true })
    }
    throw new Error('測試：Google 授權服務暫時無法使用，請稍後重試')
}
createRoot(document.getElementById('root')).render(<React.StrictMode><CalendarSettings /></React.StrictMode>)
