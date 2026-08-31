import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

function option(name, fallback = '') {
  const prefix = `--${name}=`
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || fallback
}

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('安全中止：此腳本只能在 Firestore Emulator 中執行')
}

const mode = option('mode')
const fixturePath = resolve(option('fixture', 'migration-backups/kms-emulator-fixture.json'))
const projectId = option('project', 'demo-kms-local-migration')
if (!['seed', 'verify'].includes(mode)) throw new Error('請提供 --mode=seed 或 --mode=verify')

const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
const app = initializeApp({ projectId }, `kms-emulator-${mode}`)
const db = getFirestore(app)

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
}

if (mode === 'seed') {
  let writes = 0
  let batch = db.batch()
  async function flush() {
    if (writes) await batch.commit()
    batch = db.batch()
    writes = 0
  }
  for (const [userId, data] of Object.entries(fixture.users)) {
    for (const [noteId, note] of Object.entries(data.notes)) {
      batch.set(db.doc(`users/${userId}/notes/${noteId}`), note)
      writes += 1
      if (writes >= 400) await flush()
    }
    for (const [noteId, body] of Object.entries(data.noteBodies)) {
      batch.set(db.doc(`users/${userId}/noteBodies/${noteId}`), body)
      writes += 1
      if (writes >= 400) await flush()
    }
    if (data.tagStats) {
      batch.set(db.doc(`users/${userId}/metadata/tagStats`), data.tagStats)
      writes += 1
    }
    if (data.tagOrder) {
      batch.set(db.doc(`users/${userId}/settings/tagOrder`), data.tagOrder)
      writes += 1
    }
  }
  await flush()
  console.log(JSON.stringify({ mode, seededUsers: Object.keys(fixture.users).length }, null, 2))
} else {
  const report = { mode, users: {}, failures: [] }
  for (const [userId, source] of Object.entries(fixture.users)) {
    const [notes, bodies, stats] = await Promise.all([
      db.collection(`users/${userId}/notes`).get(),
      db.collection(`users/${userId}/noteBodies`).get(),
      db.doc(`users/${userId}/metadata/tagStats`).get(),
    ])
    const expectedIds = Object.keys(source.notes).sort()
    const actualIds = notes.docs.map(row => row.id).sort()
    if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) report.failures.push(`${userId}: 筆記 ID 或數量不一致`)
    if (bodies.size !== expectedIds.length) report.failures.push(`${userId}: 正文數量 ${bodies.size}/${expectedIds.length}`)

    for (const note of notes.docs) {
      const summary = note.data()
      const body = bodies.docs.find(row => row.id === note.id)?.data()
      const original = source.notes[note.id]
      const originalBody = source.noteBodies[note.id] || {
        content: original.content || '',
        ...(original.contentDoc ? { contentDoc: original.contentDoc } : {}),
        assets: original.assets || [],
      }
      if ('content' in summary || 'contentDoc' in summary || 'assets' in summary) {
        report.failures.push(`${userId}/${note.id}: 摘要仍包含正文`)
      }
      if (!body || JSON.stringify(stable(body)) !== JSON.stringify(stable(originalBody))) {
        report.failures.push(`${userId}/${note.id}: 正文內容不一致`)
      }
      if (summary.title !== original.title || JSON.stringify(summary.hashtags || []) !== JSON.stringify(original.hashtags || [])) {
        report.failures.push(`${userId}/${note.id}: 標題或標籤不一致`)
      }
    }

    const statsData = stats.exists ? stats.data() : {}
    if (Number(statsData.totalNotes) !== expectedIds.length) report.failures.push(`${userId}: 標籤統計數量不一致`)
    report.users[userId] = { notes: notes.size, noteBodies: bodies.size, tagStatsTotal: Number(statsData.totalNotes) || 0 }
  }
  console.log(JSON.stringify(report, null, 2))
  if (report.failures.length) process.exitCode = 2
}
