import { createElement, Fragment } from 'react'
import { state, investAuth, getDoc, getDocs } from './services.mjs'
export * from './services.mjs'
export { useMarketCap } from './ui-text-services.mjs'
const prices = { '2330': 105, '0050': 62, '00981A': 11 }
export const usePrices = () => ({
  prices, quotes: {}, priceLoading: false, lastUpdated: '2026/10/2 下午3:00:00', priceErrors: [],
  loadCachedPrices: async () => prices, updatePrices: async () => {},
  ensurePrices: async () => prices, getCachedQuote: () => null,
})

export const PriceProvider = ({ children }) => createElement(Fragment, null, children)
export const MarketCapProvider = PriceProvider
export const PriceRefreshStatus = () => null
export const kmsStorage = {}
export const signOutAll = async () => { state.log.push('preview sign-out'); window.location.reload() }
export const ACCOUNT_STORE_CHANGED_EVENT = 'preview-accounts-changed'
export const loadAccounts = () => [{ email: 'preview@example.invalid', displayName: '預覽帳號' }]
export const removeAccount = () => {}
export const updateAccountDisplayName = () => {}
investAuth.currentUser.email = 'preview@example.invalid'

// Document subscriptions must emit a document snapshot, not a query snapshot.
export const onSnapshot = (reference, options, callback) => {
  const next = typeof options === 'function' ? options : callback
  let active = true
  ;(reference.id ? getDoc(reference) : getDocs(reference)).then(value => {
    if (active) next(value)
  })
  return () => { active = false }
}

// Attachment actions remain local; no Firebase Storage SDK is loaded.
export const ref = (_storage, path) => ({ path })
export const deleteObject = async () => {}
export const getDownloadURL = async () => { throw new Error('本機預覽未連接檔案儲存服務') }
export const uploadBytesResumable = () => { throw new Error('本機預覽未連接檔案儲存服務') }
export const generateHashtags = async () => ['預覽']
export const summarizeContent = async () => '本機預覽：此處顯示文章摘要。'
export const findRelatedNotes = async () => []
export const getDailyNews = async () => [
  { title: '本機示範：追蹤市場動態與今日待辦', category: '市場', source: '預覽資料', url: '#' },
]
