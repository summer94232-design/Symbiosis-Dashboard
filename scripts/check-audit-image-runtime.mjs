import assert from 'node:assert/strict'
import sharp from 'sharp'
const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#405acc' } })
    .resize(4, 4).png().toBuffer()
const metadata = await sharp(image).metadata()
assert.equal(metadata.width, 4)
assert.equal(metadata.height, 4)
assert.equal(metadata.format, 'png')
console.log(JSON.stringify({ sharp: sharp.versions.sharp, width: metadata.width, height: metadata.height, format: metadata.format }))
