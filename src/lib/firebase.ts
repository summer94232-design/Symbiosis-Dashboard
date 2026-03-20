import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'

const investConfig = {
  apiKey: import.meta.env.VITE_INVEST_API_KEY,
  authDomain: import.meta.env.VITE_INVEST_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_INVEST_PROJECT_ID,
  storageBucket: import.meta.env.VITE_INVEST_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_INVEST_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_INVEST_APP_ID,
}

const kmsConfig = {
  apiKey: import.meta.env.VITE_KMS_API_KEY,
  authDomain: import.meta.env.VITE_KMS_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_KMS_PROJECT_ID,
  storageBucket: import.meta.env.VITE_KMS_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_KMS_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_KMS_APP_ID,
}

export const investApp = initializeApp(investConfig, 'investment')
export const kmsApp = initializeApp(kmsConfig, 'knowledge')

export const investDB = getFirestore(investApp)
export const kmsDB = getFirestore(kmsApp)
export const kmsStorage = getStorage(kmsApp)