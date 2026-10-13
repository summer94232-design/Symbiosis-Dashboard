import { invokeEventHandler } from '../lib/http-function.js'
import { authorizeApiIdentity, cachedApi, apiError, apiHeaders } from '../lib/api-access.js'
import { publicDividendCatalog, refreshDividendAnnouncements } from '../lib/dividend-announcements.js'

export const handleEvent = async event => {
    const identity = await authorizeApiIdentity(event, 'dividends')
    if (identity.statusCode) return identity
    try {
        const data = await cachedApi('dividend-announcements', 300000, async () => {
            const refresh = await refreshDividendAnnouncements(identity.db)
            if (refresh.pending) throw new Error('Dividend refresh still in progress')
            const stored = (await identity.db.doc('sharedData/dividendAnnouncements').get()).data()
            return { ...(publicDividendCatalog(stored) || { entries: [], marketCheckedAt: {} }), refreshFailures: refresh.failures }
        })
        return { statusCode: 200, headers: apiHeaders, body: JSON.stringify(data) }
    } catch { return apiError(503, '除權息公告暫時無法更新，已保留上一份預告') }
}
export default async function (request) { return invokeEventHandler(request, handleEvent) }
