import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev proxy: browser hits same origin; Vite forwards /api → FastAPI.
// Default backend port is 8000 (see README); use 8001 when 8000 is taken.
const API_TARGET = process.env.API_PROXY || 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': API_TARGET,
    },
  },
})
