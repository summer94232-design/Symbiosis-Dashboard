import { mkdtempSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
// An ASCII temporary config avoids Windows Java command-line corruption of Unicode project paths.
const directory = mkdtempSync(join(tmpdir(), 'symbiosis-emulator-'))
for (const file of ['firestore.kms.rules', 'storage.kms.rules']) copyFileSync(resolve(file), join(directory, file))
const config = join(directory, 'firebase.json')
writeFileSync(config, JSON.stringify({
 firestore: { rules: 'firestore.kms.rules' }, storage: { rules: 'storage.kms.rules' },
 emulators: { firestore: { host: '127.0.0.1', port: 8085 }, storage: { host: '127.0.0.1', port: 9195 }, ui: { enabled: false }, singleProjectMode: false },
}))
const result = spawnSync(process.execPath, [resolve('node_modules/firebase-tools/lib/bin/firebase.js'), 'emulators:exec',
 '--only', 'firestore,storage', '--config', config, '--project', 'demo-kms-rules',
 'node --test --test-concurrency=1 tests/kms-rules.test.mjs tests/release-emulator.test.mjs'], {
 stdio: 'inherit', env: { ...process.env, XDG_CONFIG_HOME: join(directory, 'config'), FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true' },
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
