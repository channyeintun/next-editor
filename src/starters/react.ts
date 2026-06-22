import { collectWorkspaceFolders, type WorkspaceProject } from "../types/workspace";
import { createWorkspaceFile, STARTER_FAVICON_SVG } from "./shared";

/**
 * TanStack Start "basic" starter.
 *
 * This mirrors the official `start-basic` example, but pinned to the last
 * release line that targets **Vite 7**: TanStack Start + Nitro v3-alpha runs
 * fine on Vite 5/6/7, while Vite 8 currently fails to respond inside the
 * WebContainer runtime, so the whole dependency set is held at the Vite 7 era
 * (`@tanstack/react-start@^1.163`, `vite@^7.3`). It is trimmed to a Home/About
 * route pair and uses plain CSS instead of Tailwind v4 — Tailwind's native
 * oxide/lightningcss bindings are the most likely thing to break in the
 * in-browser runtime, and every other starter here ships plain CSS too.
 */
export function createStarterWorkspaceProject(): WorkspaceProject {
  const files = {
    "package.json": createWorkspaceFile(
      "package.json",
      JSON.stringify(
        {
          name: "next-editor-tanstack-start",
          private: true,
          sideEffects: false,
          version: "0.0.0",
          type: "module",
          scripts: {
            dev: "vite dev --host 0.0.0.0 --port 4173",
            build: "vite build",
            preview: "vite preview --host 0.0.0.0 --port 4173",
            start: "node .output/server/index.mjs",
          },
          dependencies: {
            "@tanstack/react-router": "^1.163.2",
            "@tanstack/react-router-devtools": "^1.163.2",
            "@tanstack/react-start": "^1.163.2",
            react: "^19.0.0",
            "react-dom": "^19.0.0",
          },
          devDependencies: {
            "@types/node": "^22.5.4",
            "@types/react": "^19.0.8",
            "@types/react-dom": "^19.0.3",
            "@vitejs/plugin-react": "^4.6.0",
            // Nitro v3-alpha is the server runtime that pairs with the Vite 7
            // release line; the exact pin matches the known-good combination.
            nitro: "3.0.1-alpha.2",
            typescript: "^7.0.1-rc",
            // Pinned to Vite 7 on purpose: Vite 8 + Nitro v3 does not respond
            // inside the WebContainer runtime yet.
            vite: "^7.3.1",
            "vite-tsconfig-paths": "^5.1.4",
          },
        },
        null,
        2,
      ),
    ),
    "vite.config.ts": createWorkspaceFile(
      "vite.config.ts",
      `import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tsConfigPaths from "vite-tsconfig-paths";
import { nitro } from "nitro/vite";

export default defineConfig({
  server: {
    // The live preview is served through the WebContainer host, so accept it.
    allowedHosts: true,
  },
  plugins: [
    tsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tanstackStart({
      srcDirectory: "src",
    }),
    viteReact(),
    nitro(),
  ],
});
`,
    ),
    "tsconfig.json": createWorkspaceFile(
      "tsconfig.json",
      `{
  "include": ["**/*.ts", "**/*.tsx"],
  "compilerOptions": {
    "strict": true,
    "esModuleInterop": true,
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "isolatedModules": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "target": "ES2022",
    "allowJs": true,
    "forceConsistentCasingInFileNames": true,
    "baseUrl": ".",
    "paths": {
      "~/*": ["./src/*"]
    },
    "noEmit": true
  }
}`,
    ),
    "public/favicon.svg": createWorkspaceFile("public/favicon.svg", STARTER_FAVICON_SVG),
    "src/router.tsx": createWorkspaceFile(
      "src/router.tsx",
      `import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { DefaultCatchBoundary } from "./components/DefaultCatchBoundary";
import { NotFound } from "./components/NotFound";

export function getRouter() {
  const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    defaultErrorComponent: DefaultCatchBoundary,
    defaultNotFoundComponent: () => <NotFound />,
    scrollRestoration: true,
  });

  return router;
}
`,
    ),
    "src/routes/__root.tsx": createWorkspaceFile(
      "src/routes/__root.tsx",
      `/// <reference types="vite/client" />
import { HeadContent, Link, Scripts, createRootRoute } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import type { ReactNode } from "react";
import { DefaultCatchBoundary } from "~/components/DefaultCatchBoundary";
import { NotFound } from "~/components/NotFound";
import appCss from "~/styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        title: "TanStack Start | Type-Safe, Client-First, Full-Stack React",
      },
      {
        name: "description",
        content:
          "A TanStack Start starter: type-safe, client-first, full-stack React.",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
    ],
  }),
  errorComponent: DefaultCatchBoundary,
  notFoundComponent: () => <NotFound />,
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <nav className="app-nav">
          <Link to="/" activeProps={{ className: "active" }} activeOptions={{ exact: true }}>
            Home
          </Link>
          <Link to="/about" activeProps={{ className: "active" }}>
            About
          </Link>
        </nav>
        <hr />
        <main className="app-main">{children}</main>
        <TanStackRouterDevtools position="bottom-right" />
        <Scripts />
      </body>
    </html>
  );
}
`,
    ),
    "src/routes/index.tsx": createWorkspaceFile(
      "src/routes/index.tsx",
      `import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <section className="page">
      <h1>Welcome to TanStack Start</h1>
      <p>
        Edit <code>src/routes/index.tsx</code> and save to see the preview update.
      </p>
      <p>
        Routes live in <code>src/routes</code>. Add a file there and the type-safe
        route tree regenerates automatically.
      </p>
    </section>
  );
}
`,
    ),
    "src/routes/about.tsx": createWorkspaceFile(
      "src/routes/about.tsx",
      `import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
  component: About,
});

function About() {
  return (
    <section className="page">
      <h1>About</h1>
      <p>
        This starter is powered by{" "}
        <a href="https://tanstack.com/start" target="_blank" rel="noreferrer">
          TanStack Start
        </a>{" "}
        on Vite 7, running fully in the browser.
      </p>
    </section>
  );
}
`,
    ),
    "src/components/DefaultCatchBoundary.tsx": createWorkspaceFile(
      "src/components/DefaultCatchBoundary.tsx",
      `import {
  ErrorComponent,
  Link,
  rootRouteId,
  useMatch,
  useRouter,
} from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";

export function DefaultCatchBoundary({ error }: ErrorComponentProps) {
  const router = useRouter();
  const isRoot = useMatch({
    strict: false,
    select: (state) => state.id === rootRouteId,
  });

  console.error("DefaultCatchBoundary Error:", error);

  return (
    <div className="error-boundary">
      <ErrorComponent error={error} />
      <div className="error-actions">
        <button type="button" onClick={() => router.invalidate()}>
          Try Again
        </button>
        {isRoot ? (
          <Link to="/">Home</Link>
        ) : (
          <Link
            to="/"
            onClick={(event) => {
              event.preventDefault();
              window.history.back();
            }}
          >
            Go Back
          </Link>
        )}
      </div>
    </div>
  );
}
`,
    ),
    "src/components/NotFound.tsx": createWorkspaceFile(
      "src/components/NotFound.tsx",
      `import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

export function NotFound({ children }: { children?: ReactNode }) {
  return (
    <div className="not-found">
      <div>{children ?? <p>The page you are looking for does not exist.</p>}</div>
      <p className="not-found-actions">
        <button type="button" onClick={() => window.history.back()}>
          Go back
        </button>
        <Link to="/">Start Over</Link>
      </p>
    </div>
  );
}
`,
    ),
    "src/styles/app.css": createWorkspaceFile(
      "src/styles/app.css",
      `:root {
  color-scheme: light dark;
  --bg: #0b1020;
  --text: #e7ecf5;
  --muted: #9aa6c0;
  --accent: #38bdf8;
  --accent-strong: #0ea5e9;
  --border: rgba(231, 236, 245, 0.12);
  --chip: rgba(148, 166, 192, 0.18);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  line-height: 1.6;
  color: var(--text);
  background:
    radial-gradient(circle at top, rgba(56, 189, 248, 0.18), transparent 45%),
    var(--bg);
}

a {
  color: var(--accent);
  text-decoration: none;
}

a:hover {
  color: var(--accent-strong);
}

.app-nav {
  display: flex;
  gap: 1rem;
  padding: 1rem 1.5rem;
  font-size: 1.05rem;
}

.app-nav .active {
  font-weight: 700;
  color: var(--text);
}

hr {
  margin: 0;
  border: none;
  border-top: 1px solid var(--border);
}

.app-main {
  padding: 1.5rem;
}

.page {
  max-width: 46rem;
  margin: 0 auto;
}

.page h1 {
  margin: 0 0 0.5rem;
  font-size: clamp(1.8rem, 4vw, 2.6rem);
}

.page p {
  color: var(--muted);
}

code {
  padding: 0.15rem 0.4rem;
  border-radius: 0.4rem;
  background: var(--chip);
  font-size: 0.95em;
}

button {
  font: inherit;
  cursor: pointer;
  padding: 0.45rem 0.9rem;
  border: none;
  border-radius: 0.5rem;
  color: #04121f;
  background: var(--accent);
}

button:hover {
  background: var(--accent-strong);
}

.error-boundary,
.not-found {
  max-width: 46rem;
  margin: 2rem auto;
  display: grid;
  gap: 1rem;
}

.error-actions,
.not-found-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
`,
    ),
  };

  return {
    id: "tanstack-start-workspace",
    name: "TanStack Start Basic",
    lessonType: "react",
    entryFilePath: "src/routes/index.tsx",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}
