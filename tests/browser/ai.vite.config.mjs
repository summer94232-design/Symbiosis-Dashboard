import base from './system-preview.vite.config.mjs'
import { fileURLToPath } from 'node:url'
export default {
 ...base,
 resolve:{alias:[{find:/^(.*\/)?gemini$/,replacement:fileURLToPath(new URL('../../src/lib/gemini.ts',import.meta.url))},...base.resolve.alias]},
 plugins:[...base.plugins,{name:'ai-fixture-routes',configureServer(server){server.middlewares.use((req,_res,next)=>{if(/^\/(ai|invest|kms|calendar)(\/|\?|$)/.test(req.url||''))req.url='/tests/browser/ai.html';next()})}}],
 server:{...base.server,port:5186},
}
