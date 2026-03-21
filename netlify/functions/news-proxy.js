const https = require('https')

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  }

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' }
  }

  const API_KEY = process.env.NEWS_API_KEY
  if (!API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'NEWS_API_KEY not set' }) }
  }

  // 全部改用英文，免費版支援最好
  const queries = [
    `https://newsapi.org/v2/top-headlines?category=business&pageSize=6&sortBy=publishedAt&apiKey=${API_KEY}`,
    `https://newsapi.org/v2/top-headlines?category=technology&pageSize=4&sortBy=publishedAt&apiKey=${API_KEY}`,
    `https://newsapi.org/v2/top-headlines?category=general&pageSize=4&sortBy=publishedAt&apiKey=${API_KEY}`,
  ]

  try {
    const results = await Promise.all(queries.map(url => fetchUrl(url)))
    const allArticles = []

    results.forEach(r => {
      try {
        const data = JSON.parse(r)
        if (data.articles && data.articles.length > 0) {
          allArticles.push(...data.articles)
        }
      } catch (e) {}
    })

    if (allArticles.length === 0) {
      return {
        statusCode: 200,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ articles: [], error: 'No articles found' })
      }
    }

    const seen = new Set()
    const filtered = allArticles.filter(a => {
      if (!a.title || a.title === '[Removed]') return false
      if (seen.has(a.title)) return false
      seen.add(a.title)
      return true
    }).slice(0, 12)

    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ articles: filtered })
    }
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    }
  }
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, res => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')) })
  })
}