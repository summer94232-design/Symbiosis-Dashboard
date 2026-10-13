import base from './vite.config.mjs'
import { fileURLToPath } from 'node:url'

const local = name => fileURLToPath(new URL(name, import.meta.url))
// Explicit preview server only. Production Vite never loads these aliases.
export default {
  ...base,
  resolve: { alias: [
    { find: /^firebase\/(firestore|storage)$/, replacement: local('./system-preview-services.mjs') },
    { find: /^(.*\/)?(firebase|auth|accountStore|PriceContext|MarketCapContext|marketCapContext)$/, replacement: local('./system-preview-services.mjs') },
    { find: /^(.*\/)?InvestSyncContext$/, replacement: local('../../src/InvestSyncContext.tsx') },
    { find: /^(.*\/)?gemini$/, replacement: local('./system-preview-services.mjs') },
    ...base.resolve.alias,
  ] },
  server: { ...base.server, port: 5185 },
}
