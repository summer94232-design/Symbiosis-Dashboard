import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
const fixture = fileURLToPath(new URL('./services.mjs', import.meta.url))
export default defineConfig({
  plugins: [react()],
  resolve: { alias: [
    { find: /^firebase\/firestore$/, replacement: fixture },
    { find: /^(.*\/)?(firebase|auth|stockDict|investorMeetings)$/, replacement: fixture },
    { find: /^(.*\/)?InvestSyncContext$/, replacement: fixture },
  ] },
  server: { host: '127.0.0.1', port: 5184, strictPort: true },
})
