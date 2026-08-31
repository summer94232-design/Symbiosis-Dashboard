import { spawnSync } from 'node:child_process'

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
  throw new Error('安全中止：Firestore 與 Storage Emulator 必須同時啟動')
}

const projectId = 'demo-kms-local-migration'
const bucket = `${projectId}.appspot.com`
const fixture = 'migration-backups/kms-emulator-fixture.json'

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', env: process.env })
  if (result.status !== 0) process.exit(result.status || 1)
}

run('scripts/kms-emulator-fixture.mjs', [`--mode=seed`, `--fixture=${fixture}`, `--project=${projectId}`])
run('scripts/migrate-kms-notes.mjs', [
  '--commit',
  '--allow-same-uid',
  `--project=${projectId}`,
  `--bucket=${bucket}`,
  '--page-size=100',
  '--output=migration-backups/emulator-run',
])
run('scripts/rebuild-kms-metadata.mjs', ['--commit', `--project=${projectId}`])
run('scripts/kms-emulator-fixture.mjs', [`--mode=verify`, `--fixture=${fixture}`, `--project=${projectId}`])
