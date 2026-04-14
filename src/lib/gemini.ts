// src/lib/gemini.ts

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY

// ── 模型順位（依 2026 Gemini API 使用手冊）────────────────────────────────
// 第一順位：gemini-2.5-flash-lite（高性價比主力）
// 第二順位：gemini-3.1-flash-lite（備援，最新一代推理速度）
const MODELS = [
    'gemini-2.5-flash-lite',
    'gemini-3.1-flash-lite',
]

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

// ── 指數退避 (Exponential Backoff) ──────────────────────────────────────────
// 503 / 429：等待 1s → 2s → 4s，三次後放棄並切換下一個模型
async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithBackoff(url: string, options: RequestInit): Promise<Response> {
    const RETRY_DELAYS = [1000, 2000, 4000]
    let lastError: Error | null = null

    for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
        try {
            const res = await fetch(url, options)
            if (res.status !== 503 && res.status !== 429) {
                return res // 成功或其他錯誤碼，直接回傳
            }
            console.warn(`Rate limited / server busy (${res.status}), retry ${attempt + 1}/${RETRY_DELAYS.length} after ${RETRY_DELAYS[attempt]}ms...`)
            await sleep(RETRY_DELAYS[attempt])
            lastError = new Error(`HTTP ${res.status}`)
        } catch (err) {
            lastError = err as Error
            await sleep(RETRY_DELAYS[attempt])
        }
    }
    throw lastError ?? new Error('fetchWithBackoff: 未知錯誤')
}

// ── 核心呼叫函式（純文字回傳，不啟用 JSON Mode）─────────────────────────────
async function callGemini(prompt: string): Promise<string> {
    for (const model of MODELS) {
        try {
            const res = await fetchWithBackoff(
                `${BASE_URL}/${model}:generateContent?key=${GEMINI_API_KEY}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }]
                    })
                }
            )

            if (!res.ok) {
                const status = res.status
                if (status === 404) {
                    console.warn(`Gemini model ${model} not found (404), switching to next model...`)
                    continue
                }
                throw new Error(`HTTP ${status}`)
            }

            const data = await res.json()
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text
            if (!text) continue
            console.log(`✅ Gemini using model: ${model}`)
            return text
        } catch (err) {
            console.warn(`Gemini model ${model} error:`, err)
            continue
        }
    }
    throw new Error('所有 Gemini 模型都無法使用')
}

// ── JSON Mode 呼叫函式（用於需要結構化輸出的功能）──────────────────────────
async function callGeminiJSON(prompt: string): Promise<string> {
    for (const model of MODELS) {
        try {
            const res = await fetchWithBackoff(
                `${BASE_URL}/${model}:generateContent?key=${GEMINI_API_KEY}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: {
                            response_mime_type: 'application/json'
                        }
                    })
                }
            )

            if (!res.ok) {
                const status = res.status
                if (status === 404) {
                    console.warn(`Gemini model ${model} not found (404), switching to next model...`)
                    continue
                }
                throw new Error(`HTTP ${status}`)
            }

            const data = await res.json()
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text
            if (!text) continue
            console.log(`✅ Gemini JSON mode using model: ${model}`)
            return text
        } catch (err) {
            console.warn(`Gemini model ${model} error:`, err)
            continue
        }
    }
    throw new Error('所有 Gemini 模型都無法使用')
}

// ── 公開 API ─────────────────────────────────────────────────────────────────

export async function generateHashtags(
    content: string,
    title: string,
    existingTags: string[] = []
): Promise<string[]> {
    try {
        const existingTagsStr = existingTags.length > 0
            ? `\n\n現有標籤庫（優先從這裡選擇，若有合適的請直接使用，不要創造新標籤）：\n${existingTags.join('、')}`
            : ''

        const text = await callGeminiJSON(`請分析以下筆記內容，產生 3-6 個最相關的 hashtag 標籤。
標籤規則：
- 使用繁體中文
- 每個標籤簡短精確（2-6個字）
- 支援母子標籤格式，例如：投資/台股、料理/食譜
- 優先使用現有標籤庫中的標籤，只在沒有合適標籤時才新增
- 只回傳標籤字串陣列，格式為 JSON array，例如：["投資/台股","技術分析"]
- 不要加 # 符號，不要有其他文字${existingTagsStr}

標題：${title}
內容：${content.slice(0, 1000)}`)

        const clean = text.replace(/```json|```/g, '').trim()
        const parsed = JSON.parse(clean)
        return Array.isArray(parsed) ? parsed : []
    } catch (err) {
        console.error('generateHashtags error:', err)
        return []
    }
}

export async function summarizeContent(content: string): Promise<string> {
    try {
        const text = await callGemini(
            `請用 2-3 句話總結以下內容的重點，使用繁體中文，簡潔扼要：\n\n${content.slice(0, 2000)}`
        )
        return text
    } catch (err) {
        console.error('summarizeContent error:', err)
        return ''
    }
}

export async function findRelatedNotes(
    currentTitle: string,
    currentContent: string,
    allNotes: { id: string; title: string; content: string }[]
): Promise<string[]> {
    try {
        const notesList = allNotes
            .map(n => `ID: ${n.id} | 標題: ${n.title} | 內容摘要: ${n.content.slice(0, 100)}`)
            .join('\n')

        const text = await callGeminiJSON(`分析以下筆記，找出與「目標筆記」最相關的筆記 ID。

目標筆記：
標題：${currentTitle}
內容：${currentContent.slice(0, 500)}

所有筆記清單：
${notesList}

請回傳最相關的 3-5 筆筆記 ID，格式為 JSON array，例如：["id1", "id2", "id3"]
只回傳 JSON array，不要其他文字。`)

        const clean = text.replace(/```json|```/g, '').trim()
        const parsed = JSON.parse(clean)
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

// ── getDailyNews ──────────────────────────────────────────────────────────
// 本地端（netlify dev）和部署端一律走 /.netlify/functions/news-proxy
// news-proxy 負責：News API 抓取英文新聞 → 關鍵字分類 → 回傳 NewsItem[]
// 本地開發請用 `netlify dev` 啟動，不要用 `npm run dev`
export async function getDailyNews(): Promise<{ title: string; category: string; url: string; source: string }[]> {
    try {
        const res = await fetch('/.netlify/functions/news-proxy')

        if (!res.ok) {
            const err = await res.json().catch(() => ({}))
            throw new Error((err as any).error || `HTTP ${res.status}`)
        }

        const data = await res.json()

        if (!Array.isArray(data) || data.length === 0) {
            throw new Error('news-proxy 回傳空陣列')
        }

        return data
    } catch (err) {
        console.error('getDailyNews error:', err)
        return []
    }
}