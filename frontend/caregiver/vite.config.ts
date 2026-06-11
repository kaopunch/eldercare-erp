import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'อุ่นใจ Care — สำหรับผู้ดูแล',
        short_name: 'อุ่นใจ ผู้ดูแล',
        lang: 'th',
        display: 'standalone',
        start_url: '/',
        theme_color: '#b45309',
        background_color: '#ffffff',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/api': process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8080',
    },
  },
})
