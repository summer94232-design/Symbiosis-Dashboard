import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { compile, read } from './helpers/compile.mjs'
const { createDialogController } = compile(read('src/ui/dialogs.ts'))
const { validationField } = compile(read('src/ui/useFieldFeedback.tsx'), { require: createRequire(import.meta.url) })
const { fmtMoney } = compile(read('src/ui/format.ts'))

test('confirmation is fail-closed without its host and cannot queue repeated destructive clicks', async () => {
    const controller = createDialogController()
    assert.equal(await controller.request('delete'), false)
    const detach = controller.attach()
    const first = controller.request('delete')
    assert.equal(await controller.request('duplicate delete'), false)
    assert.equal(controller.getSnapshot().message, 'delete')
    controller.resolve(false)
    assert.equal(await first, false)
    detach()
})

test('switching scope or unmounting cancels pending work, and confirmation settles only once', async () => {
    const controller = createDialogController()
    const detach = controller.attach()
    const pending = controller.request('delete')
    detach()
    assert.equal(await pending, false)
    assert.equal(controller.getSnapshot(), null)
    const detachNext = controller.attach()
    const decision = controller.request('save')
    controller.resolve(true)
    controller.resolve(false)
    assert.equal(await decision, true)
    assert.equal(controller.getSnapshot(), null)
    detachNext()
})

test('existing financial validator messages map to the actual correction field', () => {
    for (const [message, field] of [
        ['已確認現金股利請填入帳日期', 'cashPaymentDate'],
        ['股票配發日期必須有效且不得早於除權息日期', 'stockDistributionDate'],
        ['日期不是有效的西元日期', 'date'],
        ['股票代號格式不正確', 'code'],
        ['股票名稱不可空白', 'name'],
        ['現金股利與股票股利至少一項必須大於 0', 'cashDividend'],
        ['金額必須是大於 0 的整數', 'amount'],
    ]) assert.equal(validationField(message), field)
})

test('account changes before the React host unmounts still cancel confirmation', async () => {
    const controller = createDialogController()
    let account = 'a'
    const detach = controller.attach(() => {
        const original = account
        return () => { if (account !== original) throw Error('session changed') }
    })
    const pending = controller.request('delete')
    account = 'b'
    controller.resolve(true)
    assert.equal(await pending, false)
    detach()
})

test('losses carry an explicit minus sign independently of their color', () => {
    assert.equal(fmtMoney(-5000), '-$5,000')
    assert.equal(fmtMoney(12345.6), '+$12,346')
})

