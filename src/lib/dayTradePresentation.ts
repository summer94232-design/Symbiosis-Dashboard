import type { DayTradeAnalysis, TradeRecord } from './calc'

/** 只提醒需要處理的交易；正常自動沖抵或有效人工指定不需要常駐卡片。 */
export function getDayTradeAttention(trades: TradeRecord[], analysis: DayTradeAnalysis) {
    const pending = trades.filter(t => t.dayTradePending && t.type === 'sell'
        && (analysis.matchedShares.get(t) || 0) < t.shares)
    const tradesNeedingAttention = new Set([
        ...analysis.issues.map(issue => issue.trade), ...analysis.uncertain, ...pending,
    ])
    return { pending, tradesNeedingAttention, count: tradesNeedingAttention.size }
}
