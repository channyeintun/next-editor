import { defineConfig } from "vite";
import { resolve } from "node:path";

// Webview bundle. Output filenames are fixed because getWebviewHtml.ts
// references them directly (no HTML entry is shipped; the extension host
// generates the webview HTML with a nonce-based CSP).
export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  build: {
    outDir: "dist/webview",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      input: resolve(__dirname, "src/webview/index.tsx"),
      output: {
        entryFileNames: "webview.js",
        chunkFileNames: "chunk-[name].js",
        assetFileNames: "webview.[ext]",
      },
    },
  },
});
