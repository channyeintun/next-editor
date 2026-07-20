import { resolve } from "node:path";
import { defineConfig } from "vite-plus";

// Single Vite Plus config: webview production build plus the fmt/lint/test
// toolchain sections (mirrors the root repo's vp conventions; the package
// itself stays fully independent — vite-plus is this package's own dev
// dependency).
export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  build: {
    // Webview bundle. Output filenames are fixed because getWebviewHtml.ts
    // references them directly (no HTML entry is shipped; the extension
    // host generates the webview HTML with a nonce-based CSP).
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
  test: {
    include: [
      "test/unit/**/*.test.ts",
      "test/artifact/**/*.test.ts",
      "test/recovery/**/*.test.ts",
      "test/webview/**/*.test.{ts,tsx}",
    ],
    environment: "node",
  },
  fmt: {
    ignorePatterns: [
      "dist/**",
      "dist-test/**",
      ".test-vscode/**",
      ".vscode-test/**",
      ".artifacts/**",
      "fixtures/**",
      "bun.lock",
    ],
  },
  lint: {
    // Same plugin set the repository pre-commit hook lints with, so local
    // `vp lint` and the hook agree.
    plugins: ["eslint", "typescript", "unicorn", "oxc", "react", "vitest"],
  },
});
