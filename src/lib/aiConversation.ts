import type { AiMessage } from './aiSession'

export interface AiConversationMemory { text: string; throughId: string }
interface HistoryMessage { role: 'user' | 'assistant'; content: string }
export const AI_MEMORY_LIMIT = 1200
export const AI_HISTORY_LIMIT = 12000
const SUMMARY_TRIGGER = 6000
const excerpt = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, Math.floor(limit * .7))}\n［中間省略］\n${text.slice(-Math.floor(limit * .3) + 12)}`

export function validConversationMemory(value: unknown): value is AiConversationMemory {
    if (!value || typeof value !== 'object') return false
    const memory = value as AiConversationMemory
    return typeof memory.text === 'string' && !!memory.text.trim() && memory.text.length <= AI_MEMORY_LIMIT
        && typeof memory.throughId === 'string' && !!memory.throughId && memory.throughId.length <= 80
}

// Only the outgoing context is compacted. The visible/local conversation stays intact.
export function buildAiHistory(messages: AiMessage[], summary = '', memory: AiConversationMemory | null = null) {
    const through = validConversationMemory(memory) ? messages.findIndex(m => m.id === memory!.throughId) : -1
    const prefixes: HistoryMessage[] = []
    if (summary) prefixes.push({ role: 'user', content: `目前討論重點（使用者整理，優先於自動摘要）：\n${summary.slice(0, 10000)}` })
    if (through >= 0) prefixes.push({ role: 'user', content: `先前討論摘要（不是長期偏好，也不是已查證證據）：\n${memory!.text}` })
    // Keep at least the last two exchanges verbatim for follow-ups such as「第二個」.
    const start = through >= 0 ? Math.max(0, Math.min(through + 1, messages.length - 5)) : 0
    const recent = messages.slice(start)
    const sourceMessage = [...recent].reverse().find(m => m.role === 'assistant' && m.reply?.sources.length)
    const history: HistoryMessage[] = recent.map(m => {
        const sources = m === sourceMessage ? m.reply!.sources.slice(0, 6).map(s => ({
            ref: s.ref, id: s.id, title: s.title, savedAt: s.savedAt, updatedAt: s.updatedAt,
            passages: s.passages.slice(0, 2).map(p => ({ paragraph: p.paragraph, quote: p.quote.slice(0, 180) })),
        })) : []
        const evidence = sources.length ? '\n\n上輪筆記來源線索（可能節錄；保存日期不是來源日期，編號不是本輪檢索編號）：\n' + excerpt(JSON.stringify(sources), 1400) : ''
        return { role: m.role, content: m.content + evidence }
    })
    const length = (items: HistoryMessage[]) => items.reduce((n, m) => n + m.content.length, 0)
    const originalCharacters = length(prefixes) + length(history)
    const newCharacters = length(history.slice(Math.max(0, through - start + 1)))
    // A long current question/manual summary is never silently shortened.
    const limit = Math.max(AI_HISTORY_LIMIT, length(prefixes) + (history.at(-1)?.content.length || 0) + 2000)
    let covered = through - start + 1
    while (through >= 0 && covered > 0 && history.length > 3 && length(prefixes) + length(history) > limit) { history.shift(); covered-- }
    let clipped = false
    if (length(prefixes) + length(history) > limit || prefixes.length + history.length > 48 || history.slice(0, -1).some(m => m.content.length > 12000)) {
        clipped = true
        const older = history.slice(0, -3)
        const quoted = older.filter(m => m.role === 'user').slice(-6).map(m => `使用者原話節錄：${excerpt(m.content, 220)}`).join('\n')
        if (quoted) prefixes.push({ role: 'user', content: `較早對話節錄（可能不完整；指代不明時請確認，不得補造細節）：\n${excerpt(quoted, 1600)}` })
        for (let i = 0; i < history.length - 1; i++) history[i] = { ...history[i], content: `［較早訊息節錄］\n${excerpt(history[i].content, history[i].role === 'assistant' ? 3200 : 1200)}` }
        while (history.length > 1 && (length(prefixes) + length(history) > limit || prefixes.length + history.length > 48)) history.shift()
        // The fallback excerpt must fit even when the current question is very long.
        if (length(prefixes) + length(history) > limit && quoted) prefixes.pop()
    }
    const outgoing = [...prefixes, ...history]
    return { messages: outgoing,
        updateMemory: clipped || (through < 0 ? originalCharacters >= SUMMARY_TRIGGER || recent.length >= 12
            : newCharacters >= SUMMARY_TRIGGER || messages.length - through - 1 >= 6),
        notice: clipped ? '較早內容暫以節錄帶入；完整訊息仍可在這個對話中查看。' : '',
        sentCharacters: length(outgoing), originalCharacters,
    }
}
