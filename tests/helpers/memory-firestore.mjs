import assert from 'node:assert/strict'

// Transaction retries and read versions mirror the SDK's optimistic concurrency.
export function memoryFirestore(seed = {}) {
    const store = new Map(Object.entries(seed)), versions = new Map(), commits = []
    const state = { uid: 'a', login: {}, beforeRead: null, afterCommit: null, serialize: null }
    const snap = path => {
        const value = structuredClone(store.get(path))
        return { id: path.split('/').at(-1), ref: path, exists: () => value !== undefined, data: () => value }
    }
    const captureUserSession = () => {
        const uid = state.uid, login = state.login
        const assertActive = () => { if (uid !== state.uid || login !== state.login) throw Error('登入帳號已變更') }
        return { uid, assertActive, col: (_, name) => { assertActive(); return `users/${uid}/${name}` },
            doc: (_, name, id) => { assertActive(); return `users/${uid}/${name}/${id}` } }
    }
    const bindings = {
        investDB: 'invest', kmsDB: 'kms', captureUserSession,
        doc: path => `${path}/replacement-${commits.length}`,
        getDocFromServer: async path => snap(path),
        getDocsFromServer: async prefix => ({ docs: [...store.keys()].filter(path => path.startsWith(prefix + '/')).map(snap) }),
        runTransaction: async (_, fn) => {
            for (let attempt = 0; attempt < 8; attempt++) {
                const reads = new Map(), writes = []
                const result = await fn({
                    get: async path => { assert.equal(writes.length, 0, 'read before write'); await state.beforeRead?.(path); reads.set(path, versions.get(path) || 0); return snap(path) },
                    set: (path, data) => { state.serialize?.(path, data); writes.push({ path, data: structuredClone(data) }) },
                    update: (path, patch) => { state.serialize?.(path, patch); writes.push({ path, data: { ...store.get(path), ...structuredClone(patch) } }) },
                    delete: path => writes.push({ path }),
                })
                if ([...reads].some(([path, revision]) => (versions.get(path) || 0) !== revision)) continue
                for (const write of writes) {
                    if (write.data) store.set(write.path, write.data); else store.delete(write.path)
                    versions.set(write.path, (versions.get(write.path) || 0) + 1)
                }
                commits.push(writes)
                await state.afterCommit?.(writes)
                return result
            }
            throw Error('transaction contention')
        },
    }
    return { store, state, commits, bindings, captureUserSession }
}
