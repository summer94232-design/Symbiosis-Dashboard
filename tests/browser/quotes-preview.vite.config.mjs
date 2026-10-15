import base from './system-preview.vite.config.mjs'
import { fileURLToPath } from 'node:url'
const local = name => fileURLToPath(new URL(name, import.meta.url))
export default {
    ...base,
    define: { 'import.meta.env.VITE_FUBON_SNAPSHOT_ENABLED': JSON.stringify('true'), 'import.meta.env.VITE_FUBON_HISTORY_ENABLED': JSON.stringify('true') },
    resolve: { alias: [
        { find: /^(.*\/)?PriceContext$/, replacement: local('../../src/PriceContext.tsx') },
        { find: /^firebase\/firestore$/, replacement: local('./quotes-preview-services.mjs') },
        { find: /^(.*\/)?snapshot$/, replacement: local('../../src/lib/snapshot.ts') },
        ...base.resolve.alias,
    ] },
    server: { ...base.server, port: 5187 },
}
