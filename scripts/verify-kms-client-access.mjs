import { readFile } from 'node:fs/promises'
import { cert, initializeApp as initializeAdminApp } from 'firebase-admin/app'
import { getAuth as getAdminAuth } from 'firebase-admin/auth'
import { initializeApp as initializeClientApp, deleteApp } from 'firebase/app'
import { getAuth, signInWithCustomToken, signOut } from 'firebase/auth'
import { collection, getDocs, getFirestore, limit, orderBy, query } from 'firebase/firestore'

function option(name, fallback = '') {
  const prefix = `--${name}=`
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || fallback
}

const projectId = option('project')
const credentialsPath = option('credentials')
const apiKey = option('api-key')
const authDomain = option('auth-domain')
const mappings = process.argv
  .filter(value => value.startsWith('--map='))
  .map(value => value.slice(6).split(':'))
  .filter(([kmsUid, investUid]) => kmsUid && investUid)

if (!projectId || !credentialsPath || !apiKey || !authDomain || mappings.length === 0) {
  throw new Error('請提供 --project、--credentials、--api-key、--auth-domain 與至少一個 --map')
}

const credential = cert(JSON.parse(await readFile(credentialsPath, 'utf8')))
const adminApp = initializeAdminApp({ credential, projectId }, 'kms-client-access-admin')
const adminAuth = getAdminAuth(adminApp)
const results = []

for (const [kmsUid, investUid] of mappings) {
  const clientApp = initializeClientApp({ apiKey, authDomain, projectId }, `kms-client-${kmsUid}`)
  const clientAuth = getAuth(clientApp)
  const token = await adminAuth.createCustomToken(kmsUid)
  const credentialResult = await signInWithCustomToken(clientAuth, token)
  const tokenResult = await credentialResult.user.getIdTokenResult(true)
  const db = getFirestore(clientApp)
  const snapshot = await getDocs(query(
    collection(db, 'users', investUid, 'notes'),
    orderBy('createdAt', 'desc'),
    limit(1),
  ))
  results.push({
    kmsUid,
    investUid,
    tokenInvestUid: tokenResult.claims.investUid || null,
    canReadNotes: !snapshot.empty,
    firstPageDocumentCount: snapshot.size,
  })
  await signOut(clientAuth)
  await deleteApp(clientApp)
}

console.log(JSON.stringify(results, null, 2))
