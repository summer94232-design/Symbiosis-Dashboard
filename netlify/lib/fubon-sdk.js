import { resolveFubonCertificatePath } from './fubon-certificate.js'
import { fubonStage } from './fubon-diagnostic.js'

let clientPromise = null

export async function createFubonClient(FubonSDK, settings) {
    const { id, key, certificatePath, certificatePassword } = settings
    if (![id, key, certificatePath, certificatePassword].every(value => typeof value === 'string' && value.length)) {
        throw new Error('fubon-config-missing')
    }
    const sdk = await fubonStage('sdk-create', () => new FubonSDK())
    await fubonStage('login', async () => {
        const login = await sdk.apikeyLogin(id, key, certificatePath, certificatePassword)
        if (!login?.isSuccess) throw new Error('fubon-login-failed')
    })
    await fubonStage('realtime', () => sdk.initRealtime())
    const quotes = sdk.marketdata?.restClient?.stock?.snapshot?.quotes
    await fubonStage('realtime', () => { if (typeof quotes !== 'function') throw new Error('fubon-sdk-incompatible') })
    return { sdk, quotes: options => quotes.call(sdk.marketdata.restClient.stock.snapshot, options) }
}

async function getClient() {
    if (!clientPromise) {
        clientPromise = (async () => {
            // The SDK and private certificate remain server-side.
            const { FubonSDK } = await fubonStage('sdk-load', () => import('fubon-neo'))
            const certificatePath = await fubonStage('certificate', () => resolveFubonCertificatePath())
            return createFubonClient(FubonSDK, {
                id: process.env.FUBON_LOGIN_ID,
                key: process.env.FUBON_API_KEY,
                certificatePath,
                certificatePassword: process.env.FUBON_CERT_PASSWORD,
            })
        })().catch(error => { clientPromise = null; throw error })
    }
    return clientPromise
}

export async function readFubonMarket(market) {
    if (!['TSE', 'OTC'].includes(market)) throw new Error('fubon-market-invalid')
    const client = await getClient()
    try { return await fubonStage('snapshot', () => client.quotes({ market, type: 'ALLBUT0999' })) }
    catch (error) { clientPromise = null; throw error }
}
