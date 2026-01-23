import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-oxc'
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
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'vendor',
              test: /[\\/]node_modules[\\/](react|react-dom|react-router-dom)[\\/]/,
            },
            {
              name: 'editor',
              test: /[\\/]node_modules[\\/](@monaco-editor|monaco-editor)[\\/]/,
            },
            {
              name: 'xstate',
              test: /[\\/]node_modules[\\/](xstate|@xstate\/react)[\\/]/,
            },
            {
              name: 'utils',
              test: /[\\/]node_modules[\\/](pako|superjson)[\\/]/,
            },
          ],
        },
      },
    },
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
