// Serve the production build and the same Request/Response Functions on loopback.
// No deployment, remote environment loading, public tunnel, or authentication bypass.
import { createServer } from 'node:http'
import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateApiConfig } from './check-api-config.mjs'

const errors = validateApiConfig(process.env)
if (errors.length) { console.error(JSON.stringify({ ready: false, errors })); process.exit(1) }
const root = resolve('dist'), functionsRoot = resolve('netlify/functions')
await stat(resolve(root, 'index.html'))
const functions = new Map((await readdir(functionsRoot)).filter(name => name.endsWith('.js'))
    .map(name => [name.slice(0, -3), resolve(functionsRoot, name)]))
const modules = new Map()
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp',
    '.woff2': 'font/woff2', '.pdf': 'application/pdf' }
const server = createServer(async (incoming, outgoing) => {
    try {
        const url = new URL(incoming.url, 'http://127.0.0.1:5187')
        if (url.pathname.startsWith('/.netlify/functions/')) {
            const name = url.pathname.slice('/.netlify/functions/'.length)
            if (!functions.has(name)) { outgoing.writeHead(404); outgoing.end(); return }
            const chunks = []; let bytes = 0
            for await (const chunk of incoming) {
                bytes += chunk.length
                if (bytes > 6 * 1024 * 1024) { outgoing.writeHead(413); outgoing.end(); return }
                chunks.push(chunk)
            }
            if (!modules.has(name)) modules.set(name, import(pathToFileURL(functions.get(name)).href))
            const { default: handler } = await modules.get(name)
            const headers = new Headers()
            for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
            const response = await handler(new Request(url, { method: incoming.method, headers,
                ...(!['GET', 'HEAD'].includes(incoming.method) ? { body: Buffer.concat(chunks) } : {}) }))
            outgoing.writeHead(response.status, Object.fromEntries(response.headers))
            outgoing.end(incoming.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()))
            return
        }
        if (!['GET', 'HEAD'].includes(incoming.method)) { outgoing.writeHead(405); outgoing.end(); return }
        const pathname = decodeURIComponent(url.pathname)
        if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part.startsWith('.'))) {
            outgoing.writeHead(404); outgoing.end(); return
        }
        let path = resolve(root, `.${pathname}`)
        if (path !== root && !path.startsWith(`${root}${sep}`)) { outgoing.writeHead(404); outgoing.end(); return }
        try { if (!(await stat(path)).isFile()) path = resolve(root, 'index.html') }
        catch { if (extname(path)) { outgoing.writeHead(404); outgoing.end(); return }; path = resolve(root, 'index.html') }
        const body = await readFile(path)
        outgoing.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream',
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        outgoing.end(incoming.method === 'HEAD' ? undefined : body)
    } catch {
        // Never serialize request headers, SDK errors, credentials, user input or tokens.
        if (!outgoing.headersSent) outgoing.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        outgoing.end(JSON.stringify({ error: '本機服務未完成請求，請檢查本機設定' }))
    }
})
server.listen(5187, '127.0.0.1', () => console.log('本機真實預覽：http://127.0.0.1:5187/invest'))
