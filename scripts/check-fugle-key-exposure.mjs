import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// Only booleans leave this check. Never log environment values or matched bundle excerpts.
const env = readFileSync('.env', 'utf8')
const raw = env.match(/^FUGLE_API_KEY=(.*)$/m)?.[1]?.trim() || ''
const key = raw.replace(/^['"]|['"]$/g, '')
const assets = readdirSync('dist/assets').filter(name => name.endsWith('.js'))
const report = {
    localServerKeyConfigured: !!key,
    legacyFrontendEnvPresent: /^VITE_FUGLE_API_KEY=/m.test(env),
    builtAssetContainsKey: !!key && assets.some(name => readFileSync(join('dist/assets', name), 'utf8').includes(key)),
}
writeFileSync('docs/audit-fixes-2026-10-04/key-exposure.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
if (report.builtAssetContainsKey || report.legacyFrontendEnvPresent) process.exitCode = 1
