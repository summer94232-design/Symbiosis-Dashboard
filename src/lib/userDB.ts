/**
 * userDB.ts — 用戶隔離資料路徑工具
 *
 * 所有 Firestore 操作改用此模組的 helper，
 * 確保每位用戶只讀寫自己 users/{uid}/ 下的資料。
 *
 * 使用方式：
 *   import { userCol, userDoc, userDocNested } from '../../lib/userDB'
 *
 *   // 原本：collection(investDB, 'trades')
 *   // 改為：userCol(investDB, 'trades')
 *
 *   // 原本：doc(investDB, 'settings', 'lastPrices')
 *   // 改為：userDocNested(investDB, 'settings', 'lastPrices')
 */

import { collection, doc } from 'firebase/firestore'
import { getAuth } from 'firebase/auth'
import type { Firestore } from 'firebase/firestore'

/** 取得目前登入用戶的 uid，未登入時拋出錯誤 */
export function getUID(): string {
  const uid = getAuth().currentUser?.uid
  if (!uid) throw new Error('用戶未登入')
  return uid
}

/**
 * 取得用戶專屬的 collection reference
 * 路徑：users/{uid}/{collectionName}
 *
 * 對應原本的：collection(db, collectionName)
 */
export function userCol(db: Firestore, collectionName: string) {
  return collection(db, 'users', getUID(), collectionName)
}

/**
 * 取得用戶專屬的單一 document reference（一層）
 * 路徑：users/{uid}/{collectionName}/{docId}
 *
 * 對應原本的：doc(db, collectionName, docId)
 */
export function userDoc(db: Firestore, collectionName: string, docId: string) {
  return doc(db, 'users', getUID(), collectionName, docId)
}

/**
 * 取得用戶專屬的巢狀 document reference（settings/lastPrices 等）
 * 路徑：users/{uid}/{col}/{docId}
 *
 * 對應原本的：doc(db, 'settings', 'lastPrices')
 * 改為：      userDocNested(db, 'settings', 'lastPrices')
 */
export function userDocNested(db: Firestore, ...pathSegments: string[]) {
  return doc(db, 'users', getUID(), ...pathSegments)
}
