import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Frontend-only config. The API lives in /api as Vercel serverless functions,
// so run `npm run dev` (vercel dev) to get the full stack locally — `vite`
// alone serves only the UI.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
