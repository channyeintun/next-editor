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
    minify: 'terser',
    terserOptions: {
      mangle: {
        toplevel: true,
      },
      format: {
        comments: false,
      },
    },
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          editor: ['@monaco-editor/react', 'monaco-editor'],
          xstate: ['xstate', '@xstate/react'],
          utils: ['pako', 'superjson']
        },
      },
    },
    chunkSizeWarningLimit: 1024,
    reportCompressedSize: false, // Speed up build
    sourcemap: false,
  },
  server: {
    hmr: {
      overlay: true, // Show errors in overlay
    },
  },
})
