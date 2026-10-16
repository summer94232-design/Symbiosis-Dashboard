export interface StreamQuoteResult { quote: Record<string, unknown> | null; error?: string; fetchedAt?: string }

/** Bound and validate the protocol; completed rows survive an interrupted stream. */
export async function readQuoteStream(response: Response, symbols: string[],
    accept: (symbol: string, result: StreamQuoteResult) => void, assertActive: () => void): Promise<void> {
    if (!response.headers.get('Content-Type')?.includes('application/x-ndjson') || !response.body) throw new Error('報價串流格式異常')
    const remaining = new Set(symbols), reader = response.body.getReader(), decoder = new TextDecoder()
    let buffer = '', bytes = 0, done = false
    const parse = (line: string) => {
        if (!line.trim()) return
        const row = JSON.parse(line)
        if (!row || typeof row !== 'object' || done) throw new Error('報價串流格式異常')
        if (row.done === true) { if (remaining.size) throw new Error('報價串流尚未完成'); done = true; return }
        if (typeof row.symbol !== 'string' || !remaining.has(row.symbol) || ![200, 401, 403, 429, 502].includes(row.status)) throw new Error('報價串流格式異常')
        if (row.status === 200 && (!row.quote || typeof row.quote !== 'object' || Array.isArray(row.quote))) throw new Error('報價串流格式異常')
        remaining.delete(row.symbol)
        assertActive()
        accept(row.symbol, { quote: row.status === 200 ? row.quote : null,
            ...(row.status === 200 ? {} : { error: row.status === 429 ? '報價服務限流，請稍後再試' : `報價服務 HTTP ${row.status}` }),
            fetchedAt: new Date().toISOString() })
    }
    try {
        while (true) {
            assertActive()
            const chunk = await reader.read()
            assertActive()
            if (chunk.done) { buffer += decoder.decode(); break }
            bytes += chunk.value.byteLength
            if (bytes > 1024 * 1024) throw new Error('報價串流過大')
            buffer += decoder.decode(chunk.value, { stream: true })
            let newline
            while ((newline = buffer.indexOf('\n')) >= 0) { parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1) }
            if (buffer.length > 65536) throw new Error('報價串流格式異常')
        }
        if (buffer.trim()) parse(buffer)
        if (!done) throw new Error('報價串流中斷')
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
