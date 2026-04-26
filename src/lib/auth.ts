import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { investApp, kmsApp } from './firebase'

export const investAuth = getAuth(investApp)
export const kmsAuth = getAuth(kmsApp)

// 同時登入兩個 Firebase 專案
export async function signIn(email: string, password: string) {
    await signInWithEmailAndPassword(investAuth, email, password)
    await signInWithEmailAndPassword(kmsAuth, email, password)
}

// 同時登出兩個專案
export async function signOutAll() {
    await signOut(investAuth)
    await signOut(kmsAuth)
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

    const check = () => {
        if (investReady && kmsReady) {
            callback(investUser)
        }
    }

    const unsubInvest = onAuthStateChanged(investAuth, user => {
        investUser = user
        investReady = true
        check()
    })

    const unsubKms = onAuthStateChanged(kmsAuth, () => {
        kmsReady = true
        check()
    })

    return () => {
        unsubInvest()
        unsubKms()
    }
}