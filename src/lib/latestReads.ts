/** Only the latest request for each key may publish data or status. */
export function createLatestReads() {
    let epoch = 0
    const versions = new Map<string, number>()
    return {
        cancel() { epoch++; versions.clear() },
        async run<T>(key: string, load: () => Promise<T>, apply: (value: T) => void,
            status: (key: string, loading: boolean, error: string) => void, assertActive: () => void) {
            const generation = epoch, version = (versions.get(key) || 0) + 1
            versions.set(key, version)
            const current = () => generation === epoch && versions.get(key) === version
            status(key, true, '')
            try {
                const value = await load()
                if (!current()) return false
                assertActive()
                apply(value)
                status(key, false, '')
                return true
            } catch (error) {
                if (current()) status(key, false, error instanceof Error ? error.message : '讀取失敗')
                return false
            }
        },
    }
}
