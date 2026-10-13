import { runTransaction } from 'firebase/firestore'
import { investDB } from './firebase'
import { captureUserSession } from './userDB'
import { ledgerSignature, type ExactTwrReport } from './exactTwr'

/** A fixed report document with optimistic concurrency and lost-response retry. */
export async function saveExactTwrReport(report: ExactTwrReport, baseline: string, session = captureUserSession()) {
    const ref = session.doc(investDB, 'settings', 'exactTwr')
    const data = { report, updatedAt: new Date().toISOString() }
    const committed = await runTransaction(investDB, async tx => {
        const current = await tx.get(ref)
        session.assertActive()
        if (current.exists() && ledgerSignature(current.data().report) === ledgerSignature(report)) return current.data()
        if (ledgerSignature(current.exists() ? current.data() : null) !== baseline) throw new Error('另一裝置已修改 TWR 估值，請重新讀取後再編輯。')
        tx.set(ref, data)
        return data
    })
    session.assertActive()
    return committed
}
