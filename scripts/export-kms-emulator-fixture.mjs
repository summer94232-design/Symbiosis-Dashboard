import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { cert, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

function option(name, fallback = '') {
  const prefix = `--${name}=`
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || fallback
}

const projectId = option('project')
const credentialsPath = option('credentials')
const outputPath = resolve(option('output', 'migration-backups/kms-emulator-fixture.json'))
const users = process.argv.filter(value => value.startsWith('--user=')).map(value => value.slice(7))

if (!projectId || !credentialsPath || users.length === 0) {
  throw new Error('請提供 --project、--credentials 與至少一個 --user')
}

const credential = cert(JSON.parse(await readFile(resolve(credentialsPath), 'utf8')))
const app = initializeApp({ credential, projectId }, 'kms-emulator-fixture-export')
const db = getFirestore(app)
const fixture = { sourceProjectId: projectId, exportedAt: new Date().toISOString(), users: {} }

for (const userId of users) {
  const [notes, bodies, tagStats, tagOrder] = await Promise.all([
    db.collection(`users/${userId}/notes`).get(),
    db.collection(`users/${userId}/noteBodies`).get(),
    db.doc(`users/${userId}/metadata/tagStats`).get(),
    db.doc(`users/${userId}/settings/tagOrder`).get(),
  ])
  fixture.users[userId] = {
    notes: Object.fromEntries(notes.docs.map(row => [row.id, row.data()])),
    noteBodies: Object.fromEntries(bodies.docs.map(row => [row.id, row.data()])),
    tagStats: tagStats.exists ? tagStats.data() : null,
    tagOrder: tagOrder.exists ? tagOrder.data() : null,
  }
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, JSON.stringify(fixture, null, 2), 'utf8')
console.log(JSON.stringify({
  output: outputPath,
  users: Object.fromEntries(Object.entries(fixture.users).map(([userId, data]) => [userId, {
    notes: Object.keys(data.notes).length,
    noteBodies: Object.keys(data.noteBodies).length,
  }])),
}, null, 2))
