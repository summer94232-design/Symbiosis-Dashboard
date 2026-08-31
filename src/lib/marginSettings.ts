import { getDoc, setDoc } from 'firebase/firestore'
import { investDB } from './firebase'
import { userDocNested } from './userDB'
import { DEFAULT_MARGIN_INTEREST_RATE, DEFAULT_MARGIN_RISK_THRESHOLDS, type MarginRiskThresholds } from './calc'

export interface MarginRules extends MarginRiskThresholds {
    defaultInterestRate: number
    stockInterestRates: Record<string, number>
}

export const DEFAULT_MARGIN_RULES: MarginRules = {
    ...DEFAULT_MARGIN_RISK_THRESHOLDS,
    defaultInterestRate: DEFAULT_MARGIN_INTEREST_RATE,
    stockInterestRates: {},
}

const positive = (value: unknown, fallback: number) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function normalizeMarginRules(raw: unknown): MarginRules {
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const stockInterestRates: Record<string, number> = {}
    if (value.stockInterestRates && typeof value.stockInterestRates === 'object') {
        Object.entries(value.stockInterestRates as Record<string, unknown>).forEach(([code, rate]) => {
            const normalizedCode = code.trim().toUpperCase()
            const parsed = Number(rate)
            if (normalizedCode && Number.isFinite(parsed) && parsed > 0) stockInterestRates[normalizedCode] = parsed
        })
    }
    return {
        defaultInterestRate: positive(value.defaultInterestRate, DEFAULT_MARGIN_RULES.defaultInterestRate),
        safeRatio: positive(value.safeRatio, DEFAULT_MARGIN_RULES.safeRatio),
        maintenanceRatio: positive(value.maintenanceRatio, DEFAULT_MARGIN_RULES.maintenanceRatio),
        liquidationRatio: positive(value.liquidationRatio, DEFAULT_MARGIN_RULES.liquidationRatio),
        stockInterestRates,
    }
}

export function validateMarginRules(rules: MarginRules): string | null {
    if (!(rules.safeRatio > rules.maintenanceRatio && rules.maintenanceRatio > rules.liquidationRatio)) return '門檻需符合：安全線 > 追繳線 > 斷頭線。'
    if (rules.defaultInterestRate <= 0 || rules.defaultInterestRate > 1) return '預設年利率需介於 0%～100%。'
    if (Object.values(rules.stockInterestRates).some(rate => rate <= 0 || rate > 1)) return '個股年利率需介於 0%～100%。'
    return null
}

export function resolveMarginInterestRate(rules: MarginRules, code: string): number {
    return rules.stockInterestRates[code.trim().toUpperCase()] ?? rules.defaultInterestRate
}

export async function loadMarginRules(): Promise<MarginRules> {
    try {
        const snap = await getDoc(userDocNested(investDB, 'settings', 'marginRules'))
        return normalizeMarginRules(snap.exists() ? snap.data() : null)
    } catch (error) {
        console.warn('讀取融資規則失敗，改用預設值', error)
        return DEFAULT_MARGIN_RULES
    }
}

export async function saveMarginRules(rules: MarginRules): Promise<void> {
    const normalized = normalizeMarginRules(rules)
    const error = validateMarginRules(normalized)
    if (error) throw new Error(error)
    await setDoc(userDocNested(investDB, 'settings', 'marginRules'), normalized, { merge: false })
}
