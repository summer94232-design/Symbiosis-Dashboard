import { createHash } from 'node:crypto'
import { taipeiDate } from './ai-policy.js'

export const uidHash = uid => createHash('sha256').update(uid).digest('hex')
export function planReservation(old, input, config, now = Date.now()) {
    if (old.budgetAuditRequired && input.hold > 0) throw new Error('待核對的模型用量超出預留，暫停新的 AI 請求')
    const day = taipeiDate(now), month = day.slice(0, 7)
    const minute = Math.floor(now / 60000)
    const daily = old.day === day ? { ...old.daily } : { investReads: 0, investWrites: 0, kmsReads: 0, kmsWrites: 0 }
    const calls = old.minute === minute ? old.calls || 0 : 0
    if (calls >= 6) throw new Error('每分鐘最多 6 次 AI 操作，請稍後手動重試')
    const months = structuredClone(old.months || {})
    const billing = months[month] || { charged: 0, reserved: 0 }
    if (input.hold > 0 && billing.charged + billing.reserved + input.hold > config.monthlyTwd) throw new Error('已達本月 AI 費用目標（含預留），請下月再試')
    const moneyDays = structuredClone(old.moneyDays || {})
    const dayMoney = moneyDays[day] || { charged: 0, reserved: 0 }
    if (input.hold > 0 && dayMoney.charged + dayMoney.reserved + input.hold > (config.dailyTwd ?? Infinity)) throw new Error('已達今日 AI 費用上限（含預留），請明日再試')
    const reservations = { ...old.reservations }
    const completed = Object.fromEntries(Object.entries(old.completed || {}).filter(([,value]) => now - value.at < 93 * 86400000))
    if (reservations[input.id] || completed[input.id]) throw new Error('此請求已處理或仍在執行，請勿重送；不會再次呼叫模型')
    if (Object.keys(reservations).length >= 100) throw new Error('待核對的費用預留已滿，請先核對供應商用量')
    const tasks = structuredClone(old.tasks || {})
    const taskId = input.task?.id
    if (taskId) {
        const previous = tasks[taskId]
        if (previous && (previous.uid !== input.uid || previous.model !== input.task.model)) throw new Error('此請求的研究帳號或模型不符')
        // Prevent two tabs/devices paying to map the same research concurrently.
        // Unknown bills still reserve money after this short execution lock ends.
        if (Object.values(reservations).some(r => r.taskId === taskId && now - r.at < 120000)) throw new Error('此項研究正在處理，請約 2 分鐘後手動重試；不會重複呼叫模型')
        const task = previous || { uid: input.uid, model: input.task.model, charged: 0, reserved: 0, limit: config.researchTwd, at: now }
        if (task.charged + task.reserved + input.hold > task.limit + 1e-9) throw new Error('已達這項研究的費用上限，已讀摘要仍保留')
        task.reserved += input.hold
        tasks[taskId] = task
    }
    for (const key of ['investReads', 'investWrites', 'kmsReads', 'kmsWrites']) {
        daily[key] = (daily[key] || 0) + (input[key] || 0)
        if (daily[key] > config[key]) throw new Error('已達今日 AI 資料庫用量目標，原功能仍可使用')
    }
    if (input.hold > 0) {
        billing.reserved += input.hold
        dayMoney.reserved += input.hold
        reservations[input.id] = { uid: input.uid, hold: input.hold, month, day, at: now, ...(taskId ? { taskId } : {}) }
    }
    moneyDays[day] = dayMoney
    months[month] = billing
    // Preserve months with unsettled reservations; only small billing metadata is stored.
    for (const key of Object.keys(months)) if (key !== month && !Object.values(reservations).some(r => r.month === key)) delete months[key]
    for (const key of Object.keys(moneyDays)) if (key !== day && !Object.values(reservations).some(r => r.day === key)) delete moneyDays[key]
    for (const [key,task] of Object.entries(tasks)) if (!task.reserved && now - task.at > 15 * 86400000) delete tasks[key]
    return { day, daily, minute, calls: calls + 1, months, moneyDays, tasks, reservations, completed,
        ...(old.budgetAuditRequired ? {budgetAuditRequired:true} : {}) }
}
export async function reserveAi(db, uid, id, hold, operations, config, task = null) {
    const ref = db.doc('aiUsage/control')
    return db.runTransaction(async tx => {
        const snap = await tx.get(ref)
        const old = snap.data() || {}
        const previous = task && old.tasks?.[task.id]
        const taskRemaining = previous ? previous.limit - previous.charged - previous.reserved : config.researchTwd
        const day = taipeiDate(), month = old.months?.[day.slice(0,7)], today = old.moneyDays?.[day]
        const monthRemaining = config.monthlyTwd - (month?.charged || 0) - (month?.reserved || 0)
        const dayRemaining = (config.dailyTwd ?? Infinity) - (today?.charged || 0) - (today?.reserved || 0)
        // Fit the available balance rather than rejecting a cheap request just
        // because the default reservation is larger. Preflight uses this hold.
        const admittedHold = hold > 0 ? Math.floor((Math.min(hold,monthRemaining,dayRemaining,task ? taskRemaining : Infinity) + 1e-9) * 1000) / 1000 : 0
        if (hold > 0 && admittedHold < .01) {
            if (task && taskRemaining < .01) throw new Error('已達這項研究的費用上限，已讀摘要仍保留')
            if (monthRemaining < .01) throw new Error('已達本月 AI 費用目標（含預留），請下月再試')
            throw new Error('已達今日 AI 費用上限（含預留），請明日再試')
        }
        const next = planReservation(old, { id, uid: uidHash(uid), hold: admittedHold, ...operations, task }, config)
        tx.set(ref, next)
        return next
    }, { maxAttempts: 1 })
}
export async function extendAiReservation(db, uid, id, operations, config) {
    const ref = db.doc('aiUsage/control')
    return db.runTransaction(async tx => {
        const snap = await tx.get(ref), data = snap.data()
        const reservation = data?.reservations?.[id]
        if (!reservation || reservation.uid !== uidHash(uid)) throw new Error('此請求已失效，請手動重試')
        // One bounded retrieval belongs to the same user operation; it does not
        // consume another request-rate slot or add a second fee reservation.
        if (reservation.retrieval) {
            if (JSON.stringify(reservation.retrieval) !== JSON.stringify(operations)) throw new Error('此請求已配置不同的檢索範圍')
            return data
        }
        const day = taipeiDate()
        const daily = data.day === day ? { ...data.daily } : { investReads: 0, investWrites: 0, kmsReads: 0, kmsWrites: 0 }
        const extra = { ...operations }
        // The initial reservation covers ledger work on its day. If midnight
        // passes, cover extension, settlement and a possible preference update.
        if (reservation.day !== day) { extra.investReads = (extra.investReads || 0) + 4; extra.investWrites = (extra.investWrites || 0) + 3 }
        for (const key of ['investReads','investWrites','kmsReads','kmsWrites']) {
            const value = extra[key] || 0
            if (!Number.isSafeInteger(value) || value < 0) throw new Error('AI 檢索用量設定不正確')
            daily[key] = (daily[key] || 0) + value
            if (daily[key] > config[key]) throw new Error('已達今日 AI 資料庫用量目標，原功能仍可使用')
        }
        data.day = day; data.daily = daily
        reservation.retrieval = operations
        tx.set(ref, data)
        return data
    }, { maxAttempts: 1 })
}
export async function settleAi(db, uid, id, amount, details = null) {
    if (!Number.isFinite(amount) || amount < 0) return null // Unknown upstream billing keeps the full reservation.
    const ref = db.doc('aiUsage/control')
    return db.runTransaction(async tx => {
        const snap = await tx.get(ref), data = snap.data()
        const reservation = data?.reservations?.[id]
        if (!reservation || reservation.uid !== uidHash(uid)) return null
        data.months[reservation.month].reserved = Math.max(0, data.months[reservation.month].reserved - reservation.hold)
        data.months[reservation.month].charged += amount
        const dayMoney = data.moneyDays?.[reservation.day]
        if (dayMoney) { dayMoney.reserved = Math.max(0, dayMoney.reserved - reservation.hold); dayMoney.charged += amount }
        const task = data.tasks?.[reservation.taskId]
        if (task) { task.reserved = Math.max(0, task.reserved - reservation.hold); task.charged += amount }
        const offered = details?.taskOffer
        if (offered && !reservation.taskId) {
            // The initial question is part of the same NT$5 research, rather
            // than a separate fee before the continuation budget starts.
            data.tasks ||= {}
            data.tasks[offered.id] = {uid:reservation.uid,model:offered.model,limit:offered.limit,
                charged:amount,reserved:0,at:reservation.at}
        }
        const metadata = details ? { model: details.model, input: details.input, output: details.output, thoughts: details.thoughts || 0,
            cached: details.cached || 0, searches: details.searches, calls: details.calls, costTwd: amount } : { costTwd: amount }
        data.completed = { ...data.completed, [id]: { uid: reservation.uid, at: reservation.at, ...metadata } }
        if (amount > reservation.hold + .001 || details?.auditRequired) data.budgetAuditRequired = true
        delete data.reservations[id]
        tx.set(ref, data)
        return data
    }, { maxAttempts: 1 })
}
export function budgetView(data, config) {
    const month = taipeiDate().slice(0, 7), bill = data.months?.[month] || { charged: 0, reserved: 0 }
    return { month, estimatedTwd: bill.charged, reservedTwd: bill.reserved,
        auditRequired:!!data.budgetAuditRequired,
        remainingTwd: Math.max(0, config.monthlyTwd - bill.charged - bill.reserved), monthlyTwd: config.monthlyTwd,
        dailyTwd: config.dailyTwd, dailyEstimatedTwd: data.moneyDays?.[taipeiDate()]?.charged || 0,
        dailyReservedTwd: data.moneyDays?.[taipeiDate()]?.reserved || 0,
        day: data.day, daily: data.daily, limits: Object.fromEntries(['investReads','investWrites','kmsReads','kmsWrites'].map(key => [key, config[key]])),
        quotaConfirmed: config.quotaConfirmed }
}
