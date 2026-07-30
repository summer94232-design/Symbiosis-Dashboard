interface CacheEntry<T = unknown> {
  data: T
  timestamp: number
  ttl: number
}

const store = new Map<string, CacheEntry>()
const pending = new Map<string, Promise<unknown>>()
const versions = new Map<string, number>()

function bumpVersion(key: string): void {
  versions.set(key, (versions.get(key) ?? 0) + 1)
}

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

  set<T>(key: string, data: T, ttlSeconds = 60): void {
    store.set(key, { data, timestamp: Date.now(), ttl: ttlSeconds * 1000 })
  },

  /**
   * Returns cached data, or shares one in-flight loader between every caller.
   * If the key is invalidated while loading, that stale result is returned to
   * its original callers but is not written back into the cache.
   */
  getOrLoad<T>(key: string, loader: () => Promise<T>, ttlSeconds = 60): Promise<T> {
    const cached = this.get<T>(key)
    if (cached !== null) return Promise.resolve(cached)

    const running = pending.get(key)
    if (running) return running as Promise<T>

    const version = versions.get(key) ?? 0
    const request = loader()
      .then(data => {
        if ((versions.get(key) ?? 0) === version) this.set(key, data, ttlSeconds)
        return data
      })
      .finally(() => {
        if (pending.get(key) === request) pending.delete(key)
      })

    pending.set(key, request)
    return request
  },

  invalidate(key: string): void {
    bumpVersion(key)
    store.delete(key)
    pending.delete(key)
  },

  invalidatePrefix(prefix: string): void {
    const keys = new Set([...store.keys(), ...pending.keys(), ...versions.keys()])
    keys.forEach(key => { if (key.startsWith(prefix)) this.invalidate(key) })
  },

  clear(): void {
    const keys = new Set([...store.keys(), ...pending.keys(), ...versions.keys()])
    keys.forEach(key => bumpVersion(key))
    store.clear()
    pending.clear()
  },
}
