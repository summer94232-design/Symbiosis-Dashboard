/**
 * userDB.ts — 用戶隔離資料路徑工具
 *
 * ⚠️ 重要：雖然系統有兩個 Firebase 專案（investDB / kmsDB），
 * 但統一使用 investAuth 的 uid 作為資料路徑依據。
 * 原因：兩個專案的 Auth uid 不同，所有資料都建立在 investAuth uid 下。
 */

import { collection, doc } from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import { investAuth } from './auth'
import type { Firestore } from 'firebase/firestore'

// 統一使用 investAuth 的 uid
let _uid: string | null = null

onAuthStateChanged(investAuth, user => {
    _uid = user?.uid ?? null
})

/** 取得目前登入用戶的 uid，未登入時拋出錯誤 */
export function getUID(): string {
    const uid = _uid ?? investAuth.currentUser?.uid
    if (!uid) throw new Error('用戶未登入')
    return uid
}

/**
 * 取得用戶專屬的 collection reference
 * 路徑：users/{uid}/{collectionName}
 */
export function userCol(db: Firestore, collectionName: string) {
    return collection(db, 'users', getUID(), collectionName)
}

/**
 * 取得用戶專屬的單一 document reference
 * 路徑：users/{uid}/{collectionName}/{docId}
 */
export function userDoc(db: Firestore, collectionName: string, docId: string) {
    return doc(db, 'users', getUID(), collectionName, docId)
}

/**
 * 取得用戶專屬的巢狀 document reference
 * 路徑：users/{uid}/{...pathSegments}
 */
export function userDocNested(db: Firestore, ...pathSegments: string[]) {
    return doc(db, 'users', getUID(), ...pathSegments)
}