import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { investApp, kmsApp } from './firebase'
import { saveAccount, getPassword } from './accountStore'
import { cache } from './cache'

export const investAuth = getAuth(investApp)
export const kmsAuth = getAuth(kmsApp)

function normalizedEmail(user: User | null): string {
    return user?.email?.trim().toLowerCase() ?? ''
}

function isSameAccount(investUser: User | null, kmsUser: User | null): boolean {
    const investEmail = normalizedEmail(investUser)
    const kmsEmail = normalizedEmail(kmsUser)
    return !!investEmail && investEmail === kmsEmail
}

async function rollbackBothAuth(): Promise<void> {
    await Promise.allSettled([signOut(investAuth), signOut(kmsAuth)])
}

// 同時登入兩個 Firebase 專案；任一失敗時回復成兩邊都登出的狀態。
export async function signIn(email: string, password: string): Promise<void> {
    cache.clear()
    const results = await Promise.allSettled([
        signInWithEmailAndPassword(investAuth, email, password),
        signInWithEmailAndPassword(kmsAuth, email, password),
    ])
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) {
        await rollbackBothAuth()
        throw failure.reason
    }

    if (!isSameAccount(investAuth.currentUser, kmsAuth.currentUser)) {
        await rollbackBothAuth()
        throw new Error('兩個 Firebase 專案登入的帳號不一致')
    }
}

// 登入並自動儲存帳號（Login 頁面改用此函式）
export async function signInAndSave(email: string, password: string): Promise<void> {
    await signIn(email, password)          // 先確認密碼正確
    await saveAccount(email, password)     // 成功後加密儲存
}

// 無縫切換帳號（AccountSwitcher 呼叫）
export async function switchAccount(email: string): Promise<void> {
    const password = await getPassword(email)
    if (!password) throw new Error('找不到此帳號的儲存密碼，請重新登入')
    await signIn(email, password)
}

// 同時登出兩個專案
export async function signOutAll(): Promise<void> {
    cache.clear()
    const results = await Promise.allSettled([signOut(investAuth), signOut(kmsAuth)])
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
}

// 監聽 investAuth 登入狀態
export function onAuthChanged(callback: (user: User | null) => void) {
    return onAuthStateChanged(investAuth, callback)
}

/**
 * 同時等待兩個 Auth 都完成初始化後才呼叫 callback
 * 確保 App 渲染時 kmsAuth 也已就緒
 */
export function onBothAuthChanged(callback: (user: User | null) => void): () => void {
    let investReady = false
    let kmsReady = false
    let investUser: User | null = null
    let kmsUser: User | null = null
    let hasEmitted = false

    const check = () => {
        if (!investReady || !kmsReady) return

        if (isSameAccount(investUser, kmsUser)) {
            hasEmitted = true
            callback(investUser)
            return
        }

        if (!investUser && !kmsUser) {
            hasEmitted = true
            callback(null)
            return
        }

        // 初次載入若只有一邊保有登入狀態，顯示登入頁。
        // 帳號切換期間短暫出現兩邊狀態不同時，保留目前畫面，等兩邊完成後再通知。
        if (!hasEmitted) {
            hasEmitted = true
            callback(null)
        }
    }

    const unsubInvest = onAuthStateChanged(investAuth, user => {
        investUser = user
        investReady = true
        check()
    })

    const unsubKms = onAuthStateChanged(kmsAuth, user => {
        kmsUser = user
        kmsReady = true
        check()
    })

    return () => {
        unsubInvest()
        unsubKms()
    }
}
