import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The Todolist is served by Whats Up at /todo/ (its page, its API and its service
// worker), so everything is built for that base.
// In development: run Whats Up (`npm run dev` in the repo root, port 8080), then
// `npm run dev` here; Vite serves the page on :5173/todo/ and forwards the API and
// Whats Up's own sign-in to :8080.
export default defineConfig({
  base: '/todo/',
  plugins: [react()],
  server: {
    proxy: {
      '/todo/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
})
