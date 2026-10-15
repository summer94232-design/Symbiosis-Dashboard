import assert from 'node:assert/strict'
// Optional local browser verifier; production and npm test never import it.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}) })
const context = await browser.newContext({ timezoneId: 'Asia/Taipei', viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
const origin = process.env.QUOTE_PREVIEW_ORIGIN || 'http://127.0.0.1:5187'
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) throw new Error('Browser verifier accepts a loopback fixture only')
const inspect = async () => {
    await page.getByRole('button', { name: '檢查保存資料', exact: true }).click()
    return JSON.parse(await page.getByRole('status', { name: '保存資料' }).textContent())
}
const waitForSaved = async predicate => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
        const value = await inspect()
        if (predicate(value)) return value
        await page.waitForTimeout(100)
    }
    throw new Error('Timed out waiting for persisted fixture data')
}
try {
    await page.goto(`${origin}/tests/browser/quotes-preview.html`)
    await page.getByRole('button', { name: '更新現價', exact: true }).click()
    const first = await waitForSaved(value => value.prices['2330'] === 120)
    assert.equal(first.prices['2317'], 100)
    assert.equal(first.snapshot, null)
    await page.getByText('持股更新中（1/2）', { exact: true }).waitFor()
    await page.getByLabel('測試頁面').selectOption('/invest/trend')
    await page.getByRole('heading', { name: '資產趨勢', exact: true }).waitFor()
    assert.equal((await inspect()).snapshot, null)
    await page.getByLabel('測試頁面').selectOption('/kms')
    await page.getByRole('heading', { name: '知識庫', exact: true }).waitFor()
    await page.getByRole('button', { name: '完成第二檔持股', exact: true }).click()
    const held = await waitForSaved(value => value.snapshot?.totalAssets === 103000)
    assert.equal(held.snapshot.marketValue, 23000)
    assert.equal(held.snapshot.cash, 80000)
    await page.getByRole('status').filter({ hasText: '持股已更新，其他股票更新中' }).waitFor()
    if (process.env.QUOTE_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.QUOTE_SCREENSHOT_DIR}/quote-holdings-before-market.png` })
    await page.getByRole('button', { name: '完成富邦', exact: true }).click()
    const full = await waitForSaved(value => value.prices['0050'] === 80)
    assert.equal(full.prices['2330'], 120)
    assert.equal(full.prices['2317'], 110)
    assert.equal(full.snapshot.totalAssets, 103000)
    assert.equal(full.marketRequests, 1)
    await page.getByLabel('測試頁面').selectOption('/invest')
    assert.equal((await inspect()).marketRequests, 1)
    await page.getByRole('button', { name: '檢查歷史快取', exact: true }).click()
    await page.getByRole('status', { name: '快取結果' }).filter({ hasText: 'persisted' }).waitFor()
    assert.deepEqual(JSON.parse(await page.getByRole('status', { name: '快取結果' }).textContent()), { persisted: true, historyCalls: 1 })
    await page.reload()
    await page.getByRole('button', { name: '檢查歷史快取', exact: true }).click()
    await page.getByRole('status', { name: '快取結果' }).filter({ hasText: 'persisted' }).waitFor()
    assert.deepEqual(JSON.parse(await page.getByRole('status', { name: '快取結果' }).textContent()), { persisted: true, historyCalls: 0 })
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 320, height: 740 }]) {
        await page.setViewportSize(viewport)
        await page.getByRole('button', { name: '更新現價', exact: true }).click()
        await waitForSaved(value => value.prices['2330'] === 120)
        const status = page.getByRole('status').filter({ hasText: '持股更新中' }).first()
        const box = await status.boundingBox()
        assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width + 1)
        assert.equal(await page.getByText(/估值完整度.*100%/).count(), 0)
        if (process.env.QUOTE_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.QUOTE_SCREENSHOT_DIR}/quote-progress-${viewport.width}.png` })
        await page.reload()
    }
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ passed: true, checks: ['per-symbol holdings first', 'no partial asset snapshot', 'trend and KMS route changes',
        'complete holding valuation 103000', 'late market cannot regress holdings', 'single background market request',
        'IndexedDB survives reload without another history call', '390/844/320 progress layout'], source: 'isolated fixtures, real application components' }))
} finally { await browser.close() }
