import { defineConfig } from "vite";
import { resolve } from "node:path";

// Development-only benchmark bundle (plan §11). Built separately from the
// shipping webview bundle so renderer candidates never leak into the VSIX.
export default defineConfig({
  build: {
    outDir: "dist/benchmark",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    // Release mode measurement (plan §11.3): default minified production.
    rollupOptions: {
      input: resolve(__dirname, "src/webview/benchmark/index.ts"),
      output: {
        entryFileNames: "benchmark.js",
        chunkFileNames: "chunk-[name].js",
        assetFileNames: "[name][extname]",
        manualChunks(id: string) {
          if (id.includes("monaco-editor")) {
            return "monaco";
          }
          if (
            id.includes("@codemirror") ||
            id.includes("style-mod") ||
            id.includes("w3c-keyname") ||
            id.includes("crelt")
          ) {
            return "codemirror";
          }
          return undefined;
        },
      },
    },
  },
});
