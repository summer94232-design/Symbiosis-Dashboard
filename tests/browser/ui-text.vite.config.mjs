import base from './vite.config.mjs'
import { fileURLToPath } from 'node:url'
const fixture = fileURLToPath(new URL('./ui-text-services.mjs', import.meta.url))
export default { ...base, resolve: { alias: [
    { find: /^(.*\/)?(PriceContext|MarketCapContext|marketCapContext)$/, replacement: fixture },
    ...base.resolve.alias,
] } }
