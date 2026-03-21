const sharp = require('sharp')
const fs = require('fs')

if (!fs.existsSync('public/icons')) fs.mkdirSync('public/icons', { recursive: true })

const svg = Buffer.from(`<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" rx="80" fill="#1a1d27"/>
  <text x="256" y="320" font-size="280" text-anchor="middle" fill="#4f8ef7">S</text>
</svg>`)

sharp(svg).resize(192).png().toFile('public/icons/icon-192.png', () => console.log('192 done'))
sharp(svg).resize(512).png().toFile('public/icons/icon-512.png', () => console.log('512 done'))