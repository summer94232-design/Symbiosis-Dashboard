import { getDocs, orderBy, query, setDoc } from 'firebase/firestore'
import { investDB } from './firebase'
import { userCol, userDoc } from './userDB'

export interface ReconciliationSuggestion {
    category: 'trade' | 'margin' | 'cash' | 'holding' | 'dividend'
    severity: 'warning' | 'danger'
    message: string
}

export interface SavedReconciliationReport {
    id: string
    periodStart: string
    periodEnd: string
    savedAt: string
    sourceFiles: string[]
    tradeSystemCount: number
    tradeBrokerCount: number
    tradeGroupCount: number
    tradeMatchedGroups: number
    cashStatus: string
    holdingMatched: number
    holdingIssues: number
    dividendMatched: number
    dividendIssues: number
    suggestions: ReconciliationSuggestion[]
}

export async function saveReconciliationReport(report: Omit<SavedReconciliationReport, 'id' | 'savedAt'>): Promise<SavedReconciliationReport> {
    const id = report.periodEnd.slice(0, 7)
    const saved: SavedReconciliationReport = { ...report, id, savedAt: new Date().toISOString() }
    await setDoc(userDoc(investDB, 'reconciliationReports', id), { ...report, savedAt: saved.savedAt })
    return saved
}

export async function fetchReconciliationReports(): Promise<SavedReconciliationReport[]> {
    const snapshot = await getDocs(query(userCol(investDB, 'reconciliationReports'), orderBy('periodEnd', 'desc')))
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as SavedReconciliationReport))
}
