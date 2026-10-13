import { runTransaction } from 'firebase/firestore'
import { kmsDB } from './firebase'
import { captureUserSession } from './userDB'
import { parseCSVRecords } from './csv'
import { buildKmsSearchTerms, buildKmsTagPaths } from './kmsSearch'

export interface KmsImportResult { success: number; duplicated: number; skipped: number; failed: number; error?: string }

export function parseKmsImport(text: string, filename: string): Record<string, unknown>[] {
    if (/\.json$/i.test(filename)) {
        const parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
        const rows = Array.isArray(parsed) ? parsed : parsed?.notes
        if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('JSON 必須是筆記陣列，或含 notes 陣列的物件')
        return rows
    }
    if (!/\.csv$/i.test(filename)) throw new Error('請選擇 JSON 或 CSV 檔案')
    const [headers, ...rows] = parseCSVRecords(text)
    if (!headers) return []
    return rows.map(cols => Object.fromEntries(headers.map((header, i) => [header.trim(), cols[i] || ''])))
}

/** Atomic note/body/receipt, stable per file and source row. A lost response is safely retryable. */
export async function importKmsNotes(text: string, filename: string, session = captureUserSession()): Promise<KmsImportResult> {
    const result: KmsImportResult = { success: 0, duplicated: 0, skipped: 0, failed: 0 }
    let writing = false
    try {
        session.assertActive()
        const rows = parseKmsImport(text, filename)
        if (!rows.length) throw new Error('檔案內容為空')
        const bytes = new TextEncoder().encode(text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'))
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
        session.assertActive()
        for (const [index, row] of rows.entries()) {
            session.assertActive()
            const title = String(row.title || row['標題'] || '').trim()
            if (!title) { result.skipped++; continue }
            const content = String(row.content || row['內容'] || '')
            const type = ['url', 'image', 'file'].includes(String(row.type)) ? String(row.type) : 'note'
            const url = String(row.url || row['網址'] || '').trim()
            const rawTags = row.hashtags || row['標籤'] || []
            const hashtags = [...new Set((Array.isArray(rawTags) ? rawTags.map(String) : String(rawTags).split(/[;,、]/)).map(tag => tag.trim()).filter(Boolean))]
            const id = `import_${hash}_${index}`
            const note = session.doc(kmsDB, 'notes', id), body = session.doc(kmsDB, 'noteBodies', id)
            const receipt = session.doc(kmsDB, 'noteImports', id)
            writing = true
            const inserted = await runTransaction(kmsDB, async tx => {
                const [previous, existing] = await Promise.all([tx.get(receipt), tx.get(note)])
                session.assertActive()
                if (previous.exists() || existing.exists()) return false
                const now = new Date().toISOString()
                tx.set(note, { title, type, ...(url ? { url } : {}), hashtags, links: [],
                    searchTerms: buildKmsSearchTerms(title, hashtags), tagPaths: buildKmsTagPaths(hashtags),
                    isUntagged: hashtags.length === 0, createdAt: typeof row.createdAt === 'string' && row.createdAt ? row.createdAt : now, updatedAt: now })
                tx.set(body, { content, assets: [] })
                tx.set(receipt, { noteId: id, importedAt: now })
                return true
            })
            writing = false
            if (inserted) result.success++
            else result.duplicated++
            session.assertActive()
        }
    } catch (error) {
        if (writing) result.failed++
        result.error = `${writing ? '寫入未確認，請用同一份檔案重試；已儲存的筆記會自動略過。' : ''}${error instanceof Error ? error.message : '匯入未完成'}`
    }
    return result
}
