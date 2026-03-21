interface CacheEntry {
  data: any
  timestamp: number
  ttl: number
}

const store = new Map<string, CacheEntry>()

export const cache = {
  get<T>(key: string): T | null {
    const entry = store.get(key)
    if (!entry) return null
    if (Date.now() - entry.timestamp > entry.ttl) {
      store.delete(key)
      return null
    }
    return entry.data as T
  },

  set(key: string, data: any, ttlSeconds = 60) {
    store.set(key, { data, timestamp: Date.now(), ttl: ttlSeconds * 1000 })
  },

  invalidate(key: string) {
    store.delete(key)
  },

  invalidatePrefix(prefix: string) {
    store.forEach((_, k) => { if (k.startsWith(prefix)) store.delete(k) })
  }
}