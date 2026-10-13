import { invokeEventHandler } from '../lib/http-function.js'
import { authorizeApiIdentity, apiError, apiHeaders } from '../lib/api-access.js'
import { cachedApi } from '../lib/api-access.js'
import { annualCalendarSeed } from '../lib/annual-calendar-seed.js'
import { getAnnualCalendarLastSuccessAt } from '../lib/annual-calendars.js'

export const handleEvent = async event => {
    const identity = await authorizeApiIdentity(event, 'annualCalendars')
    if (identity.statusCode) return identity
    try {
        const data = await cachedApi('annual-calendars', 300000, async () => (await identity.db.doc('sharedData/annualCalendars').get()).data())
        return { statusCode: 200, headers: apiHeaders, body: JSON.stringify({
            fomc: { ...annualCalendarSeed.fomc, ...data?.fomc },
            settlement: { ...annualCalendarSeed.settlement, ...data?.settlement },
            lastSuccessAt: getAnnualCalendarLastSuccessAt(data),
        }) }
    } catch { return apiError(503, '年度資料暫時無法讀取，已保留內建日程') }
}
export default async function (request) { return invokeEventHandler(request, handleEvent) }
