const https = require('https')
const http = require('http')

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  }

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' }
  }

  const { stockNo, year, month } = event.queryStringParameters || {}

  try {
    // 查詢公開資訊觀測站法說會資料
    const params = new URLSearchParams({
      encodeURIComponent: '1',
      step: '1',
      firstin: '1',
      off: '1',
      keyword4: '',
      code1: '',
      TYPEK2: '',
      checkbtn: '',
      queryName: 'co_id',
      inpuType: 'co_id',
      TYPEK: 'all',
      isnew: 'false',
      co_id: stockNo || '',
      date1: year && month ? `${year}/${month.padStart(2, '0')}/01` : '',
      date2: year && month ? `${year}/${month.padStart(2, '0')}/31` : '',
    })

    const url = `https://mopsov.twse.com.tw/mops/web/ajax_t100sb01_1?${params}`

    const data = await fetchUrl(url)
    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: data
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
    const client = url.startsWith('https') ? https : http
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://mopsov.twse.com.tw/',
        'Accept': 'application/json, text/html',
      }
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')) })
  })
}