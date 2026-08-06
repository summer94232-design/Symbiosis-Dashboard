import { readFile } from 'node:fs/promises'
import { applicationDefault, cert, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

function option(name, fallback = '') {
  const prefix = `--${name}=`
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || fallback
}

const projectId = option('project', process.env.KMS_FIREBASE_PROJECT_ID)
const credentialsPath = option('credentials', process.env.GOOGLE_APPLICATION_CREDENTIALS)
const commit = process.argv.includes('--commit')
const claimsOnly = process.argv.includes('--claims-only')
const mappings = process.argv
  .filter(value => value.startsWith('--map='))
  .map(value => value.slice('--map='.length).split(':'))
  .filter(([kmsUid, investUid]) => kmsUid && investUid)

if (!projectId) throw new Error('請提供 --project=<kms-project-id> 或 KMS_FIREBASE_PROJECT_ID')
if (mappings.length === 0) throw new Error('請至少提供一組 --map=<kmsUid>:<investUid>')

const duplicateKmsUid = mappings.find(([kmsUid], index) =>
  mappings.findIndex(([candidate]) => candidate === kmsUid) !== index)
if (duplicateKmsUid) throw new Error(`KMS UID 重複：${duplicateKmsUid[0]}`)

const credential = credentialsPath
  ? cert(JSON.parse(await readFile(credentialsPath, 'utf8')))
  : applicationDefault()
const app = initializeApp({ credential, projectId }, 'kms-uid-mapping')
const auth = getAuth(app)
const db = getFirestore(app)

console.log(JSON.stringify({
  projectId,
  mode: commit ? 'commit' : 'dry-run',
  mappings: mappings.length,
  firestoreAuditWrites: commit && !claimsOnly,
}, null, 2))

for (const [kmsUid, investUid] of mappings) {
  const user = await auth.getUser(kmsUid)
  const currentInvestUid = user.customClaims?.investUid || null

  console.log(JSON.stringify({
    email: user.email || null,
    emailVerified: user.emailVerified,
    kmsUid,
    requestedInvestUid: investUid,
    currentInvestUid,
    action: currentInvestUid === investUid ? 'unchanged' : commit ? 'update' : 'would-update',
  }, null, 2))

  if (!commit || currentInvestUid === investUid) continue

  await auth.setCustomUserClaims(kmsUid, {
    ...(user.customClaims || {}),
    investUid,
  })
  if (!claimsOnly) {
    await db.doc(`uidMappings/${kmsUid}`).set({
      investUid,
      email: user.email || null,
      updatedAt: new Date().toISOString(),
    }, { merge: true })
  }
}

console.log(commit
  ? 'UID 對應已完成；受影響的使用者必須登出再登入。'
  : 'Dry run 完成，未修改 Firebase。確認後加入 --commit 才會寫入。')
