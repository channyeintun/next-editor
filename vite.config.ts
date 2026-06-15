import { defineConfig, lazyPlugins } from "vite-plus";
import type { PluginOption } from "@voidzero-dev/vite-plus-core";
import { fileURLToPath } from "node:url";

const crossOriginHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

// https://viteplus.dev/ alignment
export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  plugins: lazyPlugins(async () => {
    const [{ default: react }, { default: checker }] = await Promise.all([
      import("@vitejs/plugin-react"),
      import("vite-plugin-checker"),
    ]);

    return [
      ...react(),
      checker({
        typescript: true,
      }),
    ] as unknown as PluginOption[];
  }),
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    alias: {
      "monaco-editor": fileURLToPath(new URL("./src/test/monaco-editor.mock.ts", import.meta.url)),
    },
  },
  fmt: {
    ignorePatterns: ["dist/**", "public/**"],
  },
  lint: {
    jsPlugins: ["oxlint-tailwindcss"],
    plugins: ["eslint", "typescript", "unicorn", "oxc", "react", "vitest"],
    settings: {
      tailwindcss: {
        entryPoint: "src/index.css",
        rootFontSize: 16,
      },
    },
    rules: {
      "tailwindcss/enforce-canonical": "warn",
      "tailwindcss/enforce-shorthand": "warn",
      "tailwindcss/no-unnecessary-arbitrary-value": "warn",
    },
    ignorePatterns: ["dist/**", "public/**"],
    options: {
      denyWarnings: true,
    },
  },
  build: {
    minify: "oxc",
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "vendor",
              test: /[\\/]node_modules[\\/](react|react-dom|react-router-dom)[\\/]/,
            },
            {
              name: "editor",
              test: /[\\/]node_modules[\\/](@monaco-editor|monaco-editor)[\\/]/,
            },
            {
              name: "webcontainer",
              test: /[\\/]node_modules[\\/]@webcontainer[\\/]/,
            },
            {
              name: "terminal",
              test: /[\\/]node_modules[\\/]@xterm[\\/]/,
            },
            {
              name: "archive",
              test: /[\\/]node_modules[\\/]jszip[\\/]/,
            },
            {
              name: "xstate",
              test: /[\\/]node_modules[\\/](xstate|@xstate\/react)[\\/]/,
            },
            {
              name: "utils",
              test: /[\\/]node_modules[\\/](pako|@msgpack)[\\/]/,
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
    headers: crossOriginHeaders,
    hmr: {
      overlay: true, // Show errors in overlay
    },
  },
  preview: {
    headers: crossOriginHeaders,
  },
});
