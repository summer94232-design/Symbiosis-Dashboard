// One app-wide budget for its shared Fugle key, including simultaneous devices
// and cold function instances. Reserve before sending, never wait inside a refresh.
export async function reserveQuoteBudget(db, count, now) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 3000) throw new Error('Invalid quote count')
    const ref = db.doc('sharedData/fugleQuoteBudget')
    return db.runTransaction(async tx => {
        const data = (await tx.get(ref)).data() || {}
        // Stamp after the transaction read/retry, close to the upstream start.
        // The 70s window includes the provider's minute and commit headroom.
        const reservedAt = now ?? Date.now()
        if (data.starts !== undefined && (!Array.isArray(data.starts) || data.starts.some(value => !Number.isFinite(value)))) throw new Error('Invalid quote budget')
        const starts = (data.starts || []).filter(value => value > reservedAt - 70000)
        if (starts.length > 55) throw new Error('Invalid quote budget')
        const granted = Math.min(count, 55 - starts.length)
        if (granted) tx.set(ref, { starts: [...starts, ...Array(granted).fill(reservedAt)] })
        return { granted, retryAfter: starts.length ? Math.max(1, Math.ceil((Math.min(...starts) + 70000 - reservedAt) / 1000)) : 0 }
    })
}
