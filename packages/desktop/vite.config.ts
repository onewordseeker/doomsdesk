import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import { resolve } from 'path'

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  css: {
    postcss: {
      plugins: [
        tailwindcss({ config: resolve(__dirname, 'tailwind.config.ts') }),
        autoprefixer(),
      ],
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
  server: {
    host: host ?? false,
    port: 5173,
    strictPort: true,
    hmr: host ? { protocol: 'ws', host, port: 5183 } : undefined,
  },
  envPrefix: ['VITE_', 'TAURI_'],
})
