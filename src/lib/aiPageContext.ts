import { captureUserSession } from './userDB'

let current: { uid: string; path: string; noteId: string; title: string; text: string } | null = null
export function publishAiNote(noteId: string, title: string, text: string) {
    const uid = captureUserSession().uid
    const value = { uid, path: '/kms', noteId, title, text: text.slice(0, 3500) }
    current = value
    return () => { if (current === value) current = null }
}
export function aiPageContext(question: string, path: string) {
    const uid = captureUserSession().uid
    if (!current || current.uid !== uid || !path.startsWith(current.path) || !/這篇|這則|這份|畫面|目前.{0,5}筆記/.test(question)) return { page: path }
    return { page: path, noteId: current.noteId, pageText: `目前畫面（可能含未儲存編輯，非已查證資料）：${current.title}\n${current.text}` }
}
