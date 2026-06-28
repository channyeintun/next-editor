import { defineConfig, lazyPlugins } from "vite-plus";
import type { PluginOption } from "@voidzero-dev/vite-plus-core";
import tailwindcss from "@tailwindcss/vite";
import wasm from "vite-plugin-wasm";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const crossOriginHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

// --- Lesson pagination -------------------------------------------------------
// The /learn gallery paginates over static page shards instead of one big file,
// so a viewer only ever downloads the page they're scrolling (or the single
// lesson they open) — the catalog never ships to the client as one JSON blob.
// public/lessons.json stays the single authored source; this plugin serves the
// shard URLs in dev and writes them into the build output, keeping dev/prod
// paths identical. Swap point for a real backend: replace these URLs with
// `/api/lessons?page=` / `/api/lessons/:slug`.
const LESSONS_PAGE_SIZE = 12;
const LESSONS_SOURCE = fileURLToPath(new URL("./public/lessons.json", import.meta.url));
const DIST_DIR = fileURLToPath(new URL("./dist", import.meta.url));

interface LessonRecord {
  slug: string;
  [key: string]: unknown;
}

function buildLessonShards(): { pages: string[]; bySlug: Map<string, string> } {
  const parsed = JSON.parse(readFileSync(LESSONS_SOURCE, "utf8")) as { lessons?: LessonRecord[] };
  const lessons = parsed.lessons ?? [];
  const pageCount = Math.max(1, Math.ceil(lessons.length / LESSONS_PAGE_SIZE));
  const pages: string[] = [];
  for (let i = 0; i < pageCount; i++) {
    const start = i * LESSONS_PAGE_SIZE;
    const slice = lessons.slice(start, start + LESSONS_PAGE_SIZE);
    const nextPage = start + slice.length < lessons.length ? i + 1 : null;
    pages.push(JSON.stringify({ lessons: slice, nextPage }));
  }
  const bySlug = new Map<string, string>();
  for (const lesson of lessons) bySlug.set(lesson.slug, JSON.stringify(lesson));
  return { pages, bySlug };
}

interface MiddlewareServer {
  middlewares: {
    use(handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void): void;
  };
}

function lessonsPaginationPlugin() {
  const pageRe = /^\/lessons\/page-(\d+)\.json$/;
  const slugRe = /^\/lessons\/by-slug\/(.+)\.json$/;
  return {
    name: "lessons-pagination",
    configureServer(server: MiddlewareServer) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0];
        const pageMatch = pageRe.exec(path);
        const slugMatch = slugRe.exec(path);
        if (!pageMatch && !slugMatch) {
          next();
          return;
        }
        let body: string | undefined;
        try {
          // Read fresh each request so editing lessons.json reflects on reload.
          const { pages, bySlug } = buildLessonShards();
          if (pageMatch) body = pages[Number(pageMatch[1])];
          else if (slugMatch) body = bySlug.get(decodeURIComponent(slugMatch[1]));
        } catch (error) {
          res.statusCode = 500;
          res.end(String(error));
          return;
        }
        res.setHeader("Content-Type", "application/json");
        if (body === undefined) {
          res.statusCode = 404;
          res.end(`{"error":"not found"}`);
          return;
        }
        res.end(body);
      });
    },
    writeBundle(options: { dir?: string }) {
      const outDir = options.dir ?? DIST_DIR;
      const { pages, bySlug } = buildLessonShards();
      mkdirSync(join(outDir, "lessons", "by-slug"), { recursive: true });
      pages.forEach((body, i) => writeFileSync(join(outDir, "lessons", `page-${i}.json`), body));
      for (const [slug, body] of bySlug) {
        if (slug.includes("/")) continue;
        writeFileSync(join(outDir, "lessons", "by-slug", `${slug}.json`), body);
      }
    },
  };
}

// https://viteplus.dev/ alignment
export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  plugins: [
    lessonsPaginationPlugin() as unknown as PluginOption,
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
