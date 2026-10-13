import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let materializedCertificate

// Netlify limits each environment variable value to 5,000 characters.
export function decodeFubonCertificate(certificateBase64, certificateParts = []) {
    const hasParts = certificateParts.some(part => part !== undefined)
    if (hasParts) {
        if (certificateParts.length !== 2 || certificateParts.some(part =>
            typeof part !== 'string' || !part.trim() || part.length > 5000)) {
            throw new Error('fubon-cert-parts-invalid')
        }
        // A configured pair takes precedence over a leftover single-value setting.
        certificateBase64 = certificateParts.join('')
    }
    if (!certificateBase64) return null
    if (typeof certificateBase64 !== 'string') throw new Error('fubon-cert-invalid')
    const encoded = certificateBase64.replace(/\s+/g, '')
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 100000) throw new Error('fubon-cert-invalid')
    const contents = Buffer.from(encoded, 'base64')
    if (!contents.length || contents.length > 65536
        || contents.toString('base64') !== encoded) throw new Error('fubon-cert-invalid')
    return contents
}

/** SDK requires a path; the hosted certificate is supplied only through a server-side secret. */
export async function resolveFubonCertificatePath({
    certificatePath = process.env.FUBON_CERT_PATH,
    certificateBase64 = process.env.FUBON_CERT_BASE64,
    certificateParts = [process.env.FUBON_CERT_BASE64_1, process.env.FUBON_CERT_BASE64_2],
    temporaryDirectory = tmpdir(),
} = {}) {
    const contents = decodeFubonCertificate(certificateBase64, certificateParts)
    if (!contents) {
        if (typeof certificatePath !== 'string' || !certificatePath) throw new Error('fubon-config-missing')
        return certificatePath
    }
    materializedCertificate ??= (async () => {
        const destination = join(temporaryDirectory, `fubon-${randomBytes(16).toString('hex')}.pfx`)
        await writeFile(destination, contents, { flag: 'wx', mode: 0o600 })
        return destination
    })().catch(error => { materializedCertificate = undefined; throw error })
    return materializedCertificate
}
