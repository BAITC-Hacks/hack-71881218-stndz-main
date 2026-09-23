import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The development and built-preview servers share the same API origin.
const API_TARGET = process.env.API_PROXY || 'http://127.0.0.1:8000'
const proxy = { '/api': API_TARGET }

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
})
