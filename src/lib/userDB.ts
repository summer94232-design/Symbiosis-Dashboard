/**
 * userDB.ts — 用戶隔離資料路徑工具
 *
 * ⚠️ 重要：雖然系統有兩個 Firebase 專案（investDB / kmsDB），資料路徑刻意
 * 統一使用 investAuth 的 uid，作為跨專案共用的使用者識別碼。
 *
 * 同一 email 在兩個 Firebase 專案中的 Auth uid 可能不同；既有 KMS 資料已建立
 * 在 investAuth uid 路徑下，因此不能直接改成 kmsAuth uid，否則現有資料會落在
 * 另一條路徑。登入流程會另外驗證兩邊 Auth 的 email 必須一致。
 */

import { collection, doc } from 'firebase/firestore'
import { investAuth } from './auth'
import type { Firestore } from 'firebase/firestore'

/** 取得目前登入用戶的 uid，未登入時拋出錯誤 */
export function getUID(): string {
    // currentUser 是 Firebase Auth 的即時真實狀態；不可優先使用監聽器快取，
    // 否則帳號切換瞬間可能拿到上一個帳號的 uid。
    const uid = investAuth.currentUser?.uid
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
