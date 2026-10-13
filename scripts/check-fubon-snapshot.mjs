import { readFubonMarket } from '../netlify/lib/fubon-sdk.js'

const deadline = setTimeout(() => {
    console.error('富邦只讀行情測試逾時。')
    process.exit(2)
}, 45000)

try {
    for (const market of ['TSE', 'OTC']) {
        const response = await readFubonMarket(market)
        if (!response || !Array.isArray(response.data) || typeof response.date !== 'string') {
            const reportedStatus = String(response?.statusCode ?? response?.status ?? '')
            const status = /^[1-5]\d{2}$/.test(reportedStatus) ? reportedStatus : '無'
            const dataShape = Array.isArray(response?.data) ? '陣列' : typeof response?.data
            console.error(`${market} 回應診斷：狀態碼 ${status}，date 類型 ${typeof response?.date}，data 類型 ${dataShape}。`)
            throw new Error('unexpected-response')
        }
        const traded = response.data.filter(row => row?.isTrial === false
            && typeof row.lastPrice === 'number' && row.lastPrice > 0).length
        const reference = response.data.filter(row => row?.isTrial !== true
            && typeof row.closePrice === 'number' && row.closePrice > 0).length
        const trial = response.data.filter(row => row?.isTrial === true).length
        console.log(`${market}：來源日期 ${response.date}，快照 ${response.data.length} 筆，參考價 ${reference} 筆，明確成交價 ${traded} 筆，試撮 ${trial} 筆。`)
    }
    console.log('富邦只讀行情測試完成；未呼叫任何下單功能。')
    clearTimeout(deadline)
    process.exit(0)
} catch (error) {
    const reason = error?.message === 'fubon-config-missing' ? '必要的登入資料未填完整。'
        : error?.message === 'fubon-login-failed' ? 'SDK 回報登入失敗，請確認權限、憑證密碼或券商啟用狀態。'
            : error?.message === 'fubon-sdk-incompatible' ? 'SDK 行情介面與預期不符。'
                : error?.message === 'unexpected-response' ? '快照回應格式與預期不符。'
                    : '請檢查網路連線或稍後重試。'
    console.error(`富邦只讀行情測試失敗：${reason}`)
    clearTimeout(deadline)
    process.exit(1)
}
