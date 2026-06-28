import { defineConfig, lazyPlugins } from "vite-plus";
import type { PluginOption } from "@voidzero-dev/vite-plus-core";
import tailwindcss from "@tailwindcss/vite";
import wasm from "vite-plugin-wasm";
import { fileURLToPath } from "node:url";
import { lessonsApiPlugin } from "./tube/vite/lessonsApiPlugin";

const crossOriginHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

// https://viteplus.dev/ alignment
export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  plugins: [
    // Paginated /learn gallery data, served from one authored manifest that's
    // kept out of public/ so the catalog never ships as a single JSON blob.
    lessonsApiPlugin({
      source: fileURLToPath(new URL("./tube/data/lessons.json", import.meta.url)),
    }) as unknown as PluginOption,
    wasm() as unknown as PluginOption,
    tailwindcss() as unknown as PluginOption,
    lazyPlugins(async () => {
      const { default: react, reactCompilerPreset } = await import("@vitejs/plugin-react");
      const { default: babel } = await import("@rolldown/plugin-babel");
      return [
        ...react(),
        // React Compiler (babel-plugin-react-compiler) runs through Rolldown's
        // Babel pass; default target is React 19, so no runtime shim is needed.
        // The plugin's default exclude already skips node_modules.
        babel({ presets: [reactCompilerPreset()] }),
      ] as unknown as PluginOption[];
    }),
  ] as unknown as PluginOption[],
  resolve: {
    alias: {
      // Compile the tube workspace package from source so it goes through the
      // app's JSX/Tailwind/React-Compiler pipeline (not pre-bundled from
      // node_modules). Mounted at the /learn route.
      "@next-editor/tube": fileURLToPath(new URL("./tube/src/index.tsx", import.meta.url)),
      // Lets the tube package import the app's Editor for the /learn detail view.
      "@app": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  worker: {
    // ES-module workers tolerate the top-level await that vite-plugin-wasm emits
    // in the generated wasm module (the recording worker is already type:module).
    format: "es",
    plugins: () => [wasm()] as unknown as PluginOption[],
  },
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
      // The React Compiler (babel-plugin-react-compiler) is the memoization
      // authority now, so manual useMemo/useCallback were removed across the
      // app. oxlint's exhaustive-deps isn't compiler-aware and false-positives
      // with "changes every render" on values the compiler already memoizes.
      // rules-of-hooks stays on. See [[react-compiler-babel-preset]].
      "react-hooks/exhaustive-deps": "off",
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
    // Match tsconfig `target: ES2022` so first-party code is never down-leveled
    // to ES5 (avoids Lighthouse "Legacy JavaScript" transpilation overhead).
    target: "es2022",
    // Target browsers support <link rel="modulepreload"> natively; skip the polyfill.
    modulePreload: { polyfill: false },
    minify: "oxc",
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "vendor",
              test: /[\\/]node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/,
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
    chunkSizeWarningLimit: 4096,
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
