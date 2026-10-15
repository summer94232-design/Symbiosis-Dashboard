import type { HistoryEntry, HistoryStore } from './historyCache'

/** Best-effort IndexedDB. A denied/full browser store never breaks a fetch. */
export function createBrowserHistoryStore(): HistoryStore {
    const memory = new Map<string, HistoryEntry>()
    const metadata = new Map<string, { key: string; accessedAt: number; bytes: number }>()
    let database: Promise<IDBDatabase | null> | undefined
    let writes = Promise.resolve()
    const open = () => database ??= new Promise(resolve => {
        if (typeof indexedDB === 'undefined') { resolve(null); return }
        const request = indexedDB.open('symbiosis-public-history-v1', 2)
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains('daily')) request.result.createObjectStore('daily', { keyPath: 'key' })
            if (!request.result.objectStoreNames.contains('metadata')) request.result.createObjectStore('metadata', { keyPath: 'key' })
        }
        request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result) }
        request.onerror = request.onblocked = () => resolve(null)
    })
    const trim = (rows: { key: string; accessedAt: number; bytes: number }[]) => {
        let bytes = 0
        const keep = new Set<string>()
        for (const row of rows.sort((a, b) => b.accessedAt - a.accessedAt)) {
            bytes += row.bytes
            if (keep.size < 200 && bytes <= 32 * 1024 * 1024) keep.add(row.key)
        }
        return rows.filter(row => !keep.has(row.key)).map(row => row.key)
    }
    return {
        async get(key) {
            if (memory.has(key)) return structuredClone(memory.get(key))
            const db = await open()
            if (!db) return undefined
            return new Promise(resolve => {
                try {
                    const request = db.transaction('daily').objectStore('daily').get(key)
                    request.onsuccess = () => resolve(request.result)
                    request.onerror = () => resolve(undefined)
                } catch { resolve(undefined) }
            })
        },
        async set(entry) {
            memory.set(entry.key, structuredClone(entry))
            const meta = { key: entry.key, accessedAt: entry.accessedAt, bytes: JSON.stringify(entry).length * 2 }
            metadata.set(entry.key, meta)
            trim([...metadata.values()]).forEach(key => { memory.delete(key); metadata.delete(key) })
            writes = writes.catch(() => {}).then(async () => {
                const db = await open()
                if (!db) return
                await new Promise<void>(resolve => {
                    try {
                        const tx = db.transaction(['daily', 'metadata'], 'readwrite'), store = tx.objectStore('daily'), index = tx.objectStore('metadata')
                        store.put(entry)
                        index.put(meta)
                        const all = index.getAll()
                        all.onsuccess = () => trim(all.result).forEach(key => { store.delete(key); index.delete(key) })
                        tx.oncomplete = tx.onerror = tx.onabort = () => resolve()
                    } catch { resolve() }
                })
            })
            await writes
        },
    }
}
