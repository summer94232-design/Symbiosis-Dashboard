import { getFirestore } from 'firebase-admin/firestore'
import { getProtectedApp } from '../lib/api-access.js'
import { updateAnnualCalendars } from '../lib/annual-calendars.js'

// Weekly checks include the year-end publication window and later official revisions.
export const config = { schedule: '0 0 * * 0' }
export default async function (request) {
    // Scheduled functions have no public URL in production; this also protects local invocation.
    const body = await request.json().catch(() => null)
    if (request.method !== 'POST' || !body?.next_run || !Number.isFinite(Date.parse(body.next_run))) return new Response(null, { status: 405 })
    try {
        const result = await updateAnnualCalendars(getFirestore(getProtectedApp()))
        console.log('[annual-calendars] public calendar check', result)
        if (!result.fomcYears.length && !result.settlementYears.length) throw new Error('No verified calendars')
        return new Response(null, { status: 204 })
    } catch {
        // No source response, SDK error, user data or credential is logged.
        console.error('[annual-calendars] refresh failed; previous calendars retained')
        return new Response(null, { status: 503 })
    }
}
