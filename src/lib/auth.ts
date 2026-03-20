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

// 監聽登入狀態
export function onAuthChanged(callback: (user: User | null) => void) {
  return onAuthStateChanged(investAuth, callback)
}