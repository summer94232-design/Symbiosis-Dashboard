import type { SavedPrices } from './pricePolicy'

/** Display-only progress for the current request; never used to authorize a snapshot. */
export interface PriceRefreshSummary {
    requestedAt: string
    phase: 'preparing' | 'running' | 'complete' | 'error'
    total: number
    received: number
    succeeded: number
    holdingsTotal: number
    holdingsReceived: number
    holdingsSucceeded: number
    holdingsElapsedMs: number | null
    oldestHoldingDate: string
}

export function summarizePriceRefresh(saved: SavedPrices, codes: string[], holdings: string[], requestedAt: string,
    phase: PriceRefreshSummary['phase'], now = Date.now(), previous: PriceRefreshSummary | null = null,
    startedAt = Date.parse(requestedAt)): PriceRefreshSummary {
    const uniqueHoldings = [...new Set(holdings)]
    const universe = [...new Set([...codes, ...uniqueHoldings])]
    const received = (code: string) => saved._quotes?.[code]?.requestedAt === requestedAt
    const succeeded = (code: string) => {
        const value = saved[code]
        return received(code) && saved._quotes?.[code]?.status === 'success'
            && typeof value === 'number' && Number.isFinite(value) && value > 0 && value === saved._quotes?.[code]?.price
    }
    const holdingsSucceeded = uniqueHoldings.filter(succeeded).length
    const ready = uniqueHoldings.length > 0 && holdingsSucceeded === uniqueHoldings.length
    return {
        requestedAt, phase, total: universe.length, received: universe.filter(received).length,
        succeeded: universe.filter(succeeded).length, holdingsTotal: uniqueHoldings.length,
        holdingsReceived: uniqueHoldings.filter(received).length, holdingsSucceeded,
        holdingsElapsedMs: ready ? previous?.requestedAt === requestedAt && previous.holdingsElapsedMs !== null
            ? previous.holdingsElapsedMs : Math.max(0, now - startedAt) : null,
        oldestHoldingDate: uniqueHoldings.filter(succeeded).map(code => saved._quotes![code].sourceDate).sort()[0] || '',
    }
}

export function holdingQuoteStatus(summary: PriceRefreshSummary | null): { text: string; tone: 'muted' | 'positive' | 'warning' } | null {
    if (!summary) return null
    if (summary.phase === 'preparing') return { text: '持股報價準備中', tone: 'muted' }
    if (!summary.holdingsTotal) return { text: summary.phase === 'error' ? '持股報價狀態未確認' : '目前沒有持股', tone: 'muted' }
    if (summary.holdingsSucceeded === summary.holdingsTotal) {
        const seconds = ((summary.holdingsElapsedMs ?? 0) / 1000).toFixed(1)
        return { text: `持股報價已完成 · ${seconds} 秒`, tone: 'positive' }
    }
    const count = `${summary.holdingsSucceeded}/${summary.holdingsTotal}`
    return summary.phase === 'complete' || summary.phase === 'error'
        ? { text: `持股報價未齊 ${count}`, tone: 'warning' }
        : { text: `持股報價更新中 ${count}`, tone: 'muted' }
}

export function priceRefreshStatusText(summary: PriceRefreshSummary): string {
    if (summary.phase === 'preparing') return '持股報價準備中'
    if (summary.phase === 'complete') {
        const missing = summary.total - summary.succeeded
        return missing ? `報價更新結束 · ${summary.succeeded}/${summary.total} 檔成功，${missing} 檔未取得有效報價`
            : `全部報價已更新 · ${summary.succeeded}/${summary.total} 檔`
    }
    if (summary.phase === 'error') return '本次報價更新未完成，已取得的報價仍保留'
    const otherTotal = summary.total - summary.holdingsTotal
    const otherReceived = summary.received - summary.holdingsReceived
    const background = otherTotal ? `其他股票背景更新中（${otherReceived}/${otherTotal}）` : '報價整理中'
    return summary.holdingsTotal && summary.holdingsSucceeded === summary.holdingsTotal
        ? `持股報價已完成 · ${background}`
        : summary.holdingsTotal ? `持股報價更新中（${summary.holdingsSucceeded}/${summary.holdingsTotal}） · ${background}` : background
}
