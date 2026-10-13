import { invokeEventHandler } from '../lib/http-function.js'
import { authorizeApi, apiError, apiHeaders, cachedApi } from '../lib/api-access.js'
// netlify/functions/market-cap-proxy.js
// ──────────────────────────────────────────────────────────────
// 查詢台股「已發行股數」，供前端計算市值（現價 × 股數）。
//
// 資料來源：公開資訊觀測站 (MOPS) 開放資料 CSV，政府公開資料、免 API Key：
//   上市：https://mopsfin.twse.com.tw/opendata/t187ap03_L.csv
//   上櫃：https://mopsfin.twse.com.tw/opendata/t187ap03_O.csv
// 兩份 CSV 欄位結構相同，最後一欄「已發行普通股數或TDR原股發行股數」即為股數。
// 股本資料為公司申報資料，變動極少，故在 lambda 容器存活期間做記憶體快取。
//
// 呼叫方式：GET /.netlify/functions/market-cap-proxy?codes=2330,2317,6488
// 回傳格式：{ "2330": 25930380458, "2317": 13812779518, "6488": null }
//   → 數字為已發行股數；null 表示查無資料（例如非上市櫃、代號輸入錯誤）
// ──────────────────────────────────────────────────────────────

const SOURCES = [
    'https://mopsfin.twse.com.tw/opendata/t187ap03_L.csv', // 上市
    'https://mopsfin.twse.com.tw/opendata/t187ap03_O.csv', // 上櫃
]

const CACHE_TTL_MS = 12 * 60 * 60 * 1000 // 12 小時（股本資料變動極少）

// 模組級變數：同一個 lambda 容器（warm start）之間共用快取
let cache = null // { data: Record<string, number>, fetchedAt: number }

export const handleEvent = async (event) => {
    const headers = apiHeaders
    const denied = await authorizeApi(event, 'marketCap')
    if (denied) return denied


    const codesParam = event.queryStringParameters?.codes || ''
    const codes = [...new Set(codesParam.split(',').map(s => s.trim()).filter(Boolean))]
    if (codesParam.length > 1000 || codes.length > 100 || codes.some(code => !/^[A-Za-z0-9]{2,10}$/.test(code))) return apiError(400, '單次最多 100 個有效代號')

    if (codes.length === 0) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: '缺少 codes 參數，例如 ?codes=2330,2317' }),
        }
    }

    try {
        const sharesMap = await getSharesMap()
        const result = {}
        for (const code of codes) {
            result[code] = sharesMap[code] ?? null
        }
        return { statusCode: 200, headers, body: JSON.stringify(result) }
    } catch (err) {
        console.error('[market-cap-proxy] 失敗：', err.message)
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: `抓取股本資料失敗：${err.message}` }),
        }
    }
}

// ── 取得「代號 → 已發行股數」對照表（含快取）────────────────────────
async function getSharesMap() {
    const now = Date.now()
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
        return cache.data
    }

    const merged = {}
    for (const url of SOURCES) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
            if (!res.ok) {
                console.error(`[market-cap-proxy] ${url} HTTP ${res.status}`)
                continue
            }
            const text = await res.text()
            const parsed = parseSharesCSV(text)
            Object.assign(merged, parsed)
        } catch (err) {
            console.error(`[market-cap-proxy] 抓取 ${url} 失敗：`, err.message)
            // 單一來源失敗不影響另一來源，繼續往下跑
        }
    }

    // 若兩個來源都失敗，且沒有舊快取可用，直接拋出錯誤
    if (Object.keys(merged).length === 0 && !cache) {
        throw new Error('上市與上櫃資料皆抓取失敗')
    }

    // 只要有抓到新資料就更新快取；若這次全失敗但有舊快取，就繼續沿用舊快取
    if (Object.keys(merged).length > 0) {
        cache = { data: merged, fetchedAt: now }
        return merged
    }
    return cache.data
}

// ── 解析 MOPS CSV：以「代號 → 已發行股數」為目標欄位 ──────────────────
// CSV 欄位皆以雙引號包住，且用逗號分隔；已發行股數固定為最後一欄。
// 用 header 動態找欄位 index，避免欄位順序未來變動時整支程式失效。
function parseSharesCSV(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0)
    if (lines.length < 2) return {}

    const header = splitCSVLine(lines[0])
    const codeIdx = header.findIndex(h => h.includes('公司代號'))
    const sharesIdx = header.findIndex(h => h.includes('已發行普通股數'))

    if (codeIdx === -1 || sharesIdx === -1) {
        console.error('[market-cap-proxy] CSV 欄位格式異常，找不到「公司代號」或「已發行普通股數」欄位')
        return {}
    }

    const map = {}
    for (let i = 1; i < lines.length; i++) {
        const cols = splitCSVLine(lines[i])
        if (cols.length <= Math.max(codeIdx, sharesIdx)) continue
        const code = cols[codeIdx]?.trim()
        const sharesRaw = cols[sharesIdx]?.trim()
        if (!code || !sharesRaw) continue
        const shares = Number(sharesRaw)
        if (!Number.isFinite(shares) || shares <= 0) continue
        map[code] = shares
    }
    return map
}

// 解析單行 CSV（處理雙引號包欄位、"" 轉義引號）
function splitCSVLine(line) {
    const fields = []
    let cur = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (inQuotes) {
            if (ch === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++ }
                else inQuotes = false
            } else {
                cur += ch
            }
        } else {
            if (ch === '"') inQuotes = true
            else if (ch === ',') { fields.push(cur); cur = '' }
            else cur += ch
        }
    }
    fields.push(cur)
    return fields
}
export default async function (request) {
    return invokeEventHandler(request, handleEvent)
}
