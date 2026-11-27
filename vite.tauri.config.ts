import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'kadr-tauri-entry',
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => html.replace('/src/main.tsx', '/src/platform/tauri-entry.ts')
      }
    }
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url))
    }
  },
  build: { outDir: 'out/tauri-ui' },
  server: { host: '127.0.0.1', port: 1420, strictPort: true }
})
