import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'

const require = createRequire(import.meta.url)

test('Firebase Admin and the read-only SDK load without require(ESM) support', async () => {
    const [app, auth, firestore, fubon] = await Promise.all([
        import('firebase-admin/app'), import('firebase-admin/auth'), import('firebase-admin/firestore'), import('fubon-neo'),
    ])
    assert.equal(typeof app.initializeApp, 'function')
    assert.equal(typeof auth.getAuth, 'function')
    assert.equal(typeof firestore.getFirestore, 'function')
    assert.equal(typeof fubon.FubonSDK, 'function')
})

test('Firebase JWKS verification accepts a valid signature and rejects tampered or expired tokens', async t => {
    // Exercise Firebase's actual JWKS consumer and its resolved transitive dependency.
    // All keys and tokens are generated fixtures; only a loopback server is contacted.
    const firebaseRequire = createRequire(require.resolve('firebase-admin/app'))
    const { PublicKeySignatureVerifier, JwtErrorCode } = firebaseRequire('../utils/jwt.js')
    const jwt = firebaseRequire('jsonwebtoken')
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const jwk = { ...publicKey.export({ format: 'jwk' }), use: 'sig', alg: 'RS256', kid: 'runtime-fixture' }
    let reads = 0
    const server = createServer((_request, response) => {
        reads++
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ keys: [jwk] }))
    })
    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    t.after(() => new Promise(resolve => {
        server.closeAllConnections()
        server.close(resolve)
    }))
    const verifier = PublicKeySignatureVerifier.withJwksUrl(`http://127.0.0.1:${server.address().port}/jwks.json`)
    const sign = expiresIn => jwt.sign({ sub: 'fixture-user' }, privateKey, {
        algorithm: 'RS256', keyid: jwk.kid, expiresIn,
    })
    const valid = sign(60)
    await assert.doesNotReject(verifier.verify(valid))
    const segments = valid.split('.')
    segments[1] = Buffer.from(JSON.stringify({ sub: 'tampered-user' })).toString('base64url')
    await assert.rejects(verifier.verify(segments.join('.')), error => error.code === JwtErrorCode.INVALID_SIGNATURE)
    await assert.rejects(verifier.verify(sign(-60)), error => error.code === JwtErrorCode.TOKEN_EXPIRED)
    assert.equal(reads, 1, 'Firebase retains its public-key cache across signature checks')
})
