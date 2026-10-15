// Default is a read-only preflight. Publish only after current-batch user approval.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { pathToFileURL } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { productionFunctionOverrides, functionOverrideArguments, safeFunctionSettingsSummary } from './production-function-settings.mjs'
import { validateQuoteDeploymentSettings } from './check-quote-deployment.mjs'

export async function runProductionDeploy(argv = process.argv.slice(2)) {
    const argument = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined }
    const cliPath = argument('--cli')
    if (!cliPath) throw new Error('請用 --cli 指定已安裝的官方 Netlify CLI 27.12.1 bin/run.js；預設不發布。')
    const cli = resolve(cliPath), cliRoot = dirname(dirname(cli))
    if (JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8')).version !== '27.12.1') throw new Error('正式發布需使用已驗證的官方 Netlify CLI 27.12.1')
    const env = { ...process.env, ...parseEnv(readFileSync('.env', 'utf8')) }
    const overrides = productionFunctionOverrides(env), flags = functionOverrideArguments(overrides)
    // Confirm the official CLI interprets the exact arguments as Functions-only.
    const { parseDeployEnvVar } = await import(pathToFileURL(join(cliRoot, 'dist/utils/env/deploy-env-vars.js')).href)
    const parsed = overrides.map((row, index) => parseDeployEnvVar(flags[index * 2])(flags[index * 2 + 1])[0])
    assert.deepEqual(parsed, overrides)
    const call = args => {
        try {
            const output = execFileSync(process.execPath, [cli, ...args], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024,
            })
            return output.trim() ? JSON.parse(output) : null
        } catch { throw new Error('Netlify 唯讀核對或狀態操作失敗；未輸出原始回應或憑證。') }
    }
    const siteId = JSON.parse(readFileSync('.netlify/state.json', 'utf8')).siteId
    assert.ok(typeof siteId === 'string' && siteId, 'Netlify site is not linked')
    const site = call(['api', 'getSite', '--data', JSON.stringify({ site_id: siteId })])
    const remote = call(['env:list', '--context', 'production', '--scope', 'functions', '--json'])
    const quoteCheck = validateQuoteDeploymentSettings({ ...remote, ...Object.fromEntries(overrides.map(row => [row.key, row.value])) })
    if (!quoteCheck.ready) throw new Error(`正式報價設定不完整：${quoteCheck.missing.join('、')}`)
    const version = readFileSync('src/lib/appVersion.ts', 'utf8').match(/v\d+\.\d+\.\d+\.\d+/)?.[0]
    assert.ok(version, 'Version label unavailable')
    const frontend = {}, hashes = value => createHash('sha256').update(value).digest('hex')
    let builtVersion = false
    const scan = dir => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name)
            if (entry.isDirectory()) scan(path)
            else {
                const bytes = readFileSync(path)
                if (path.endsWith('.js') && bytes.includes(Buffer.from(version))) builtVersion = true
                assert.ok(!overrides.filter(row => row.is_secret).some(row => bytes.includes(Buffer.from(row.value))), 'Backend secret found in frontend artifacts')
                frontend[path] = hashes(bytes)
            }
        }
    }
    scan('dist')
    assert.ok(builtVersion, 'Build output version differs from source')
    console.log(JSON.stringify({ ready: true, version, siteId, previousDeployId: site.published_deploy.id,
        quoteSettings: quoteCheck, functionOverrides: safeFunctionSettingsSummary(overrides),
        frontendFiles: Object.keys(frontend).length, frontendSecretScanPassed: true, publishRequested: argv.includes('--publish') }))
    if (!argv.includes('--publish')) return
    const expected = argument('--expected-deploy')
    assert.ok(expected && expected === site.published_deploy.id, 'Published deployment changed; review current deployment first')
    assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim(), '', 'Commit verified application changes before publishing')
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim()
    const releaseDir = join('.netlify', 'production-releases', new Date().toISOString().replace(/[:.]/g, '-'))
    mkdirSync(releaseDir, { recursive: true })
    writeFileSync(join(releaseDir, 'attempt.json'), JSON.stringify({ version, head, previousDeployId: expected, frontend }, null, 2))
    const output = join(releaseDir, 'deploy.json')
    let deployed, unlocked = false
    try {
        if (site.published_deploy.locked) {
            unlocked = true
            call(['api', 'unlockDeploy', '--data', JSON.stringify({ deploy_id: expected })])
        }
        const fd = openSync(output, 'w')
        let code
        try {
            code = await new Promise((accept, reject) => {
                const child = spawn(process.execPath, [cli, 'deploy', '--prod', '--no-build', '--dir', 'dist', '--functions', 'netlify/functions',
                    '--skip-functions-cache', '--site', siteId, '--timeout', '600', '--message', `${version} verified release with complete Functions settings`, '--json', ...flags], {
                    stdio: ['ignore', fd, fd], windowsHide: true, env: { ...process.env, CI: 'true', NETLIFY_TELEMETRY_DISABLED: '1' },
                })
                child.once('error', () => reject(new Error('Netlify CLI 啟動失敗；請先檢查既有發布紀錄。')))
                child.once('exit', accept)
            })
        } finally { closeSync(fd) }
        assert.equal(code, 0, 'Deployment command failed; inspect private output before retrying')
        deployed = JSON.parse(readFileSync(output, 'utf8').replace(/^\uFEFF/, ''))
        const after = call(['api', 'getSite', '--data', JSON.stringify({ site_id: siteId })])
        assert.equal(after.published_deploy.id, deployed.deploy_id)
        assert.equal(after.published_deploy.state, 'ready')
        const receipt = { version, head, siteId, previousDeployId: expected, deployId: deployed.deploy_id,
            state: after.published_deploy.state, publishedAt: after.published_deploy.published_at, functionOverrideCount: overrides.length }
        writeFileSync(join(releaseDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
        console.log(JSON.stringify(receipt))
    } finally {
        if (unlocked) {
            const after = call(['api', 'getSite', '--data', JSON.stringify({ site_id: siteId })])
            assert.ok([expected, deployed?.deploy_id].includes(after.published_deploy.id), 'Concurrent deployment detected; preserve its state')
            call(['api', 'lockDeploy', '--data', JSON.stringify({ deploy_id: after.published_deploy.id })])
            console.log(JSON.stringify({ productionLockRestored: true }))
        }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runProductionDeploy().catch(() => {
        console.error('正式發布程序停止；請檢查缺漏設定、原發布狀態及 .netlify/production-releases 的私有紀錄。不要未查明結果就重試。')
        process.exitCode = 1
    })
}
