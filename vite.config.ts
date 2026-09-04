import { defineConfig, lazyPlugins } from "vite-plus";
import { loadEnv } from "vite";
import type { PluginOption } from "@voidzero-dev/vite-plus-core";
import tailwindcss from "@tailwindcss/vite";
import wasm from "vite-plugin-wasm";
import posthog from "@posthog/rollup-plugin";
import { fileURLToPath } from "node:url";

import { proxyPlugin } from "./tube/vite/proxyPlugin";
import { openrouterProxyPlugin } from "./tube/vite/openrouterProxyPlugin";
import { rrwebRecorderBundlePlugin } from "./build/rrwebRecorderBundlePlugin";

const crossOriginHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

const monacoTestMock = fileURLToPath(new URL("./src/test/monaco-editor.mock.ts", import.meta.url));

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function stagedChecks(stagedFileNames: readonly string[]): string[] {
  const files = stagedFileNames.map(quoteShellArgument);
  const lintableFiles = stagedFileNames
    .filter((fileName) => /\.[cm]?[jt]sx?$/.test(fileName))
    .map(quoteShellArgument);

  return [
    ...(files.length > 0 ? [`vp fmt --threads=1 ${files.join(" ")}`] : []),
    ...(lintableFiles.length > 0
      ? [
          `oxlint --fix --threads=1 --deny-warnings --react-plugin --vitest-plugin -A react-hooks/exhaustive-deps ${lintableFiles.join(" ")}`,
        ]
      : []),
  ];
}

// https://viteplus.dev/ alignment
export default ({ mode }: { mode: string }) => {
  // Merge non-VITE_ prefixed vars (e.g. POSTHOG_API_KEY) into process.env so
  // build-time plugins can read them. Vite only puts VITE_-prefixed vars in
  // import.meta.env; everything else needs this explicit merge.
  process.env = { ...process.env, ...loadEnv(mode, process.cwd(), "") };
  return defineConfig({
    // Staged checks run serially on the low-memory deployment host. The
    // embedded `vp check` linter otherwise starts one worker per CPU and can
    // exhaust the allocator before analysis begins.
    staged: stagedChecks,
    plugins: [
      rrwebRecorderBundlePlugin() as unknown as PluginOption,
      // Dev-server equivalent of infra/worker/routes/proxy.ts: lets
      // `bun run dev` resolve the same /api/proxy route the Worker
      // serves in production.
      proxyPlugin() as unknown as PluginOption,
      // Dev-server equivalent of infra/worker/routes/openrouter.ts: lets
      // `bun run dev` resolve the same /api/openrouter/responses route the
      // Worker serves in production (see src/shared/openrouterProxy.ts).
      openrouterProxyPlugin() as unknown as PluginOption,
      wasm() as unknown as PluginOption,
      posthog({
        personalApiKey: process.env.POSTHOG_API_KEY!,
        projectId: process.env.POSTHOG_PROJECT_ID,
        host: process.env.POSTHOG_HOST,
        sourcemaps: { deleteAfterUpload: true },
      }) as unknown as PluginOption,
      tailwindcss() as unknown as PluginOption,
      lazyPlugins(async () => {
        const { default: react, reactCompilerPreset } = await import("@vitejs/plugin-react");
        const { default: babel } = await import("@rolldown/plugin-babel");
        return [
          ...react(),
          // React Compiler (babel-plugin-react-compiler) runs through Rolldown's
          // Babel pass; default target is React 19, so no runtime shim is needed.
          // The plugin's default exclude already skips node_modules.
          //
          // @babel/core is pinned to 7.x in devDependencies on purpose. Under
          // Babel 8, @babel/types dropped AssignmentPattern from its LVal alias,
          // and the compiler's `isLVal()` guard in lowerAssignment then bails on
          // EVERY component with a defaulted destructured prop
          // (`({ x = true }) => …`) — silently, with no build error. That was 28
          // functions across 15 files here, all of them running unmemoized while
          // the codebase (and the disabled exhaustive-deps rule below) assumed
          // otherwise. Verify after any Babel bump: compiled output must contain
          // `const $ = _c(`.
          babel({ presets: [reactCompilerPreset()] }),
        ] as unknown as PluginOption[];
      }),
    ] as unknown as PluginOption[],
    resolve: {
      // tube/ installs its own dependencies (it is not a root workspace), so a
      // package it depends on resolves React from tube/node_modules while the
      // app's react-dom resolves the root copy — two React instances, whose
      // shared internals are then null ("Cannot read properties of null
      // (reading 'useEffect')"). Its source is compiled by this config, so it
      // has to share this config's React.
      //
      // @tanstack/react-query is on the list for the same reason, one level up:
      // a second copy means a second QueryClientContext, so tube's useQuery
      // never sees the provider App.tsx renders from the root copy ("No
      // QueryClient set, use QueryClientProvider to set one" on /learn). Dev
      // hides this — the dep optimizer keys pre-bundles by bare specifier, so
      // both importers land on one chunk — but the build resolves per importer
      // and shipped two react-query copies. query-core carries QueryClient
      // itself, so it has to travel with react-query.
      dedupe: ["react", "react-dom", "@tanstack/react-query", "@tanstack/query-core"],
      alias: {
        // Compile the tube workspace package from source so it goes through the
        // app's JSX/Tailwind/React-Compiler pipeline (not pre-bundled from
        // node_modules). Mounted at the /learn route.
        "@next-editor/tube": fileURLToPath(new URL("./tube/src/index.tsx", import.meta.url)),
        // Same idea for the infra client package (AuthMenu, UploadLessonModal, etc).
        "@next-editor/infra": fileURLToPath(new URL("./infra/client/index.ts", import.meta.url)),
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
      include: [
        "src/**/*.{test,spec}.{ts,tsx}",
        "tube/src/**/*.{test,spec}.{ts,tsx}",
        // infra/worker/** deliberately excluded: it runs in the Workers runtime,
        // not a browser — that side is tested against real wrangler dev + local
        // D1/R2 (see docs/progress.md), not jsdom.
        "infra/client/**/*.{test,spec}.{ts,tsx}",
        // infra/db/** is plain SQL-building logic against the D1 interface, so it
        // runs here rather than in the Workers-runtime suite.
        "infra/db/**/*.{test,spec}.{ts,tsx}",
      ],
      alias: {
        // y-monaco imports Monaco's deep editor API entrypoint. Keep it inline
        // so Vitest resolves that import through this mock instead of asking
        // Node to load Monaco's CSS-bearing ESM graph directly.
        "monaco-editor/esm/vs/editor/editor.api.js": monacoTestMock,
        "monaco-editor": monacoTestMock,
      },
      server: {
        deps: {
          // y-monaco imports Monaco's deep editor API entrypoint (see the alias
          // above). @tanstack/react-query is inlined so its `react` import goes
          // through this config's resolver — externalized, Node resolves it to
          // tube/node_modules/react and `resolve.dedupe` never sees it.
          inline: ["y-monaco", "@tanstack/react-query"],
        },
      },
    },
    fmt: {
      ignorePatterns: ["dist/**", "public/**", "src/studio/tts/pocket/vendor/**"],
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
      // The studio's vendored sentencepiece build (third-party, generated) is
      // excluded — it is not first-party code and never will lint clean.
      ignorePatterns: ["dist/**", "public/**", "src/studio/tts/pocket/vendor/**"],
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
                // onnxruntime-web must live alone: its threaded WASM runtime
                // spawns pthread workers from `import.meta.url`, so the chunk
                // it sits in is executed as a worker script — any co-bundled
                // app code touching `window` at module top level would crash
                // every worker (the studio's pocket-tts synthesis hangs).
                name: "ort",
                test: /[\\/]node_modules[\\/]onnxruntime-web[\\/]/,
              },
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
      sourcemap: true,
    },
    server: {
      headers: crossOriginHeaders,
      hmr: {
        overlay: true, // Show errors in overlay
      },
      fs: {
        // Vite's built-in deny list covers `.env*` but this project's Worker
        // secrets live in `infra/.dev.vars` (GOOGLE_CLIENT_SECRET,
        // SESSION_SECRET, the QStash signing keys), which is inside the served
        // root and matches no default pattern — so `GET /infra/.dev.vars` was
        // served verbatim. Harmless on a stock localhost bind, but a single
        // unauthenticated request once the dev server is started with `--host`
        // or on a shared/CI box. Vite merges these with its defaults.
        deny: [".dev.vars", ".dev.vars.*", "**/.dev.vars", "**/.dev.vars.*"],
      },
      // Routes implemented so far by the Tube Worker (`bun run dev:worker`,
      // see infra/wrangler.toml). Deliberately NOT a blanket "/api" proxy: that
      // would shadow proxyPlugin's existing /api/proxy dev route above before
      // it moves into the Worker (Phase 4). Extend this list route-by-route as
      // infra/worker/routes/* gains real handlers.
      proxy: {
        "/api/health": "http://localhost:8787",
        "/api/lessons": "http://localhost:8787",
        "/api/auth": "http://localhost:8787",
        "/api/uploads": "http://localhost:8787",
        // Authenticated Studio capabilities and the D1-gated Modal TTS proxy.
        "/api/studio": "http://localhost:8787",
        // Authenticated collaboration HTTP and WebSocket routes.
        "/api/collaboration": "http://localhost:8787",
        // Slide-image R2 ingestion (Worker-only — R2 lives behind wrangler).
        // Without `dev:worker` running this proxy 500s and the import falls
        // back to /api/proxy hrefs client-side (src/googleSlides/storeImageHrefs.ts).
        "/api/slide-images": "http://localhost:8787",
        // Language playground compile/run proxies for the pure-language
        // lessons (auth + kill switch live in the Worker). Each requires
        // `dev:worker` plus its own <LANG>_PLAYGROUND_ENABLED flag (e.g. in
        // infra/.dev.vars) to actually execute; without an entry here the
        // browser's POST hits vite's SPA fallback, which only serves GET, and
        // the Run button reports a bogus "service unavailable".
        "/api/go-playground": "http://localhost:8787",
        "/api/kotlin-playground": "http://localhost:8787",
        "/api/rust-playground": "http://localhost:8787",
        "/api/zig-playground": "http://localhost:8787",
        "/api/haskell-playground": "http://localhost:8787",
        "/media": "http://localhost:8787",
        // /api/proxy is deliberately NOT proxied here — the Worker now
        // implements it too (infra/worker/routes/proxy.ts, used for Slides
        // images and avatars), but proxyPlugin below already intercepts this
        // path directly in the vite dev server, so plain `bun run dev` (no
        // `dev:worker`) keeps working unchanged for both.
      },
    },
    preview: {
      headers: crossOriginHeaders,
    },
  });
};
