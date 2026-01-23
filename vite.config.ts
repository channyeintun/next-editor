import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import checker from 'vite-plugin-checker'

// https://viteplus.dev/ alignment
export default defineConfig({
  plugins: [
    react(),
    checker({
      typescript: true,
      eslint: {
        useFlatConfig: true,
        lintCommand: 'eslint "./src/**/*.{ts,tsx}"',
      },
    }),
  ],
  build: {
    minify: true,
    chunkSizeWarningLimit: 1024,
    reportCompressedSize: false,
    sourcemap: false,
  },
  server: {
    hmr: {
      overlay: true, // Show errors in overlay
    },
  },
})
