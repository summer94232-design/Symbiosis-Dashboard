const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY

const MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
]

async function callGemini(prompt: string): Promise<string> {
  for (const model of MODELS) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
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
        if (status === 429 || status === 404 || status === 400) {
          console.warn(`Gemini model ${model} failed (${status}), trying next...`)
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

export async function generateHashtags(
  content: string,
  title: string,
  existingTags: string[] = []
): Promise<string[]> {
  try {
    const existingTagsStr = existingTags.length > 0
      ? `\n\n現有標籤庫（優先從這裡選擇，若有合適的請直接使用，不要創造新標籤）：\n${existingTags.join('、')}`
      : ''

    const text = await callGemini(`請分析以下筆記內容，產生 3-6 個最相關的 hashtag 標籤。
標籤規則：
- 使用繁體中文
- 每個標籤簡短精確（2-6個字）
- 支援母子標籤格式，例如：投資/台股、料理/食譜
- 優先使用現有標籤庫中的標籤，只在沒有合適標籤時才新增
- 只回傳標籤陣列，格式為 JSON array，例如：["投資/台股","技術分析"]
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

    const text = await callGemini(`分析以下筆記，找出與「目標筆記」最相關的筆記 ID。

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

export async function getDailyNews(): Promise<{ title: string; summary: string; category: string }[]> {
  try {
    const isLocalhost = window.location.hostname === 'localhost'

    if (isLocalhost) {
      // 本地開發：用 Gemini AI 生成（部署後會用真實新聞）
      const today = new Date().toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric' })
      const text = await callGemini(`今天是 ${today}。

請整理 5-8 則近期全球重要新聞，特別關注：
1. 金融市場（美股、台股、加密貨幣、匯率）
2. 科技產業（AI、半導體、重要科技公司動態）
3. 總體經濟（通膨、利率、各國政策）
4. 地緣政治（重大國際事件）

請回傳 JSON array，每則包含：
- title：新聞標題（繁體中文，30字以內）
- summary：2-3句重點摘要（繁體中文）
- category：分類（市場/科技/經濟/政治）

只回傳 JSON array，不要其他文字。`)

      const clean = text.replace(/```json|```/g, '').trim()
      return JSON.parse(clean)
    }

    // 部署環境：從 Netlify Function 取得真實新聞
    const res = await fetch('/.netlify/functions/news-proxy')
    const data = await res.json()

    if (!data.articles?.length) throw new Error('No articles')

    // 用 Gemini 翻譯 + 分類 + 摘要
    const articleList = data.articles
      .slice(0, 10)
      .map((a: any, i: number) => `${i + 1}. ${a.title}${a.description ? ' — ' + a.description : ''}`)
      .join('\n')

    const text = await callGemini(`請將以下新聞整理成繁體中文摘要：

${articleList}

請回傳 JSON array，每則包含：
- title：繁體中文標題（30字以內，重新撰寫使其清晰）
- summary：2-3句繁體中文重點摘要
- category：分類（市場/科技/經濟/政治）

只回傳 JSON array，不要其他文字。`)

    const clean = text.replace(/```json|```/g, '').trim()
    return JSON.parse(clean)
  } catch (err) {
    console.error('getDailyNews error:', err)
    return []
  }
}