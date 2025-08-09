import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Enable minification for production builds
    minify: 'terser',
    terserOptions: {
      compress: {
        // Remove console.log statements in production
        drop_console: true,
        drop_debugger: true,
        // Remove unused code
        dead_code: true,
        // Optimize boolean expressions
        booleans_as_integers: true,
      },
      mangle: {
        // Mangle function and variable names for smaller bundle size
        toplevel: true,
      },
      format: {
        // Remove comments from production build
        comments: false,
      },
    },
    // Optimize chunk splitting for better caching
    rollupOptions: {
      output: {
        manualChunks: {
          // Separate vendor libraries for better caching
          vendor: ['react', 'react-dom'],
          editor: ['@monaco-editor/react', 'monaco-editor'],
          utils: ['pako', 'superjson']
        },
      },
    },
    // Set chunk size warning limit to 1MB
    chunkSizeWarningLimit: 1024,
  },
})
