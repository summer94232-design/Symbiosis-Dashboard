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

// existingTags：傳入現有標籤，讓 AI 優先使用
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