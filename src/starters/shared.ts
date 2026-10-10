const STARTER_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><rect width="64" height="64" rx="18" fill="#121826"/><path d="M20 44 30 20h4l10 24h-5.1l-2-5.2H27.1L25 44H20Zm8.6-9.3h6.8L32 25.6l-3.4 9.1Z" fill="#7dd3fc"/><path d="m41 19 4.6 8-4.6 8h-5.4l4.6-8-4.6-8H41Z" fill="#f59e0b"/></svg>`;

export { STARTER_FAVICON_SVG };

// The one workspace-file builder; re-exported so every starter keeps importing it from here.
export { createWorkspaceFile } from "../types/workspaceFiles";

/**
 * The Vite range every Vite-based starter installs, so a bump is one line
 * instead of one per starter (the last one missed a file).
 */
export const STARTER_VITE_VERSION = "^8.1.3";

/** The dev/build/preview scripts of a plain Vite lesson, served where the preview looks. */
const VITE_LESSON_SCRIPTS = {
  dev: "vite --host 0.0.0.0 --port 4173",
  build: "vite build",
  preview: "vite preview --host 0.0.0.0 --port 4173",
};

export function createHtmlCssLessonPackageJson(): string {
  return createViteSpaPackageJson("html-css-lesson");
}

/**
 * Shared, editable page styles for the minimal framework starters so each
 * "hello world" lesson looks consistent while staying self-contained.
 */
export function createMinimalLessonStyles(accentColor: string): string {
  return `:root {
  color-scheme: light dark;
  --accent: ${accentColor};
}

body {
  margin: 0;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}

.page {
  max-width: 40rem;
  margin: 0 auto;
  padding: 3rem 1.5rem;
  line-height: 1.6;
}

h1 {
  margin: 0 0 0.75rem;
  font-size: 2.5rem;
}

code {
  padding: 0.1rem 0.35rem;
  border-radius: 0.35rem;
  background: rgba(127, 127, 127, 0.18);
}

button {
  margin-top: 1rem;
  padding: 0.55rem 1.1rem;
  font: inherit;
  color: #fff;
  background: var(--accent);
  border: none;
  border-radius: 0.5rem;
  cursor: pointer;
}

button:hover {
  filter: brightness(1.05);
}
`;
}

/**
 * A Vite lesson's package.json. With no `dependencies` the key is left out
 * entirely (JSON.stringify drops an undefined value), which is the html-css
 * lesson's manifest: Vite and nothing else.
 */
export function createViteSpaPackageJson(
  name: string,
  dependencies?: Record<string, string>,
  devDependencies: Record<string, string> = {},
): string {
  return JSON.stringify(
    {
      name,
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: VITE_LESSON_SCRIPTS,
      dependencies,
      devDependencies: {
        vite: STARTER_VITE_VERSION,
        ...devDependencies,
      },
    },
    null,
    2,
  );
}
