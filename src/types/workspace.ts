export interface WorkspaceFile {
  path: string;
  name: string;
  language: string;
  content: string;
}

export type WorkspaceLessonType = "node.js" | "html-css";

export interface WorkspaceProject {
  id: string;
  name: string;
  lessonType: WorkspaceLessonType;
  entryFilePath: string;
  folders: string[];
  files: Record<string, WorkspaceFile>;
}

export interface WorkspaceRecordingSnapshot {
  project: WorkspaceProject;
  activeFilePath: string;
}

export interface WorkspaceRecordingEvent {
  timestamp: number;
  snapshot: WorkspaceRecordingSnapshot;
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function areWorkspaceFilesEqual(
  left: Record<string, WorkspaceFile>,
  right: Record<string, WorkspaceFile>,
): boolean {
  const leftPaths = Object.keys(left).sort((firstPath, secondPath) =>
    firstPath.localeCompare(secondPath),
  );
  const rightPaths = Object.keys(right).sort((firstPath, secondPath) =>
    firstPath.localeCompare(secondPath),
  );

  if (!areStringArraysEqual(leftPaths, rightPaths)) {
    return false;
  }

  return leftPaths.every((path) => {
    const leftFile = left[path];
    const rightFile = right[path];

    return (
      leftFile.path === rightFile.path &&
      leftFile.name === rightFile.name &&
      leftFile.language === rightFile.language &&
      leftFile.content === rightFile.content
    );
  });
}

export function areWorkspaceProjectsEqual(
  left: WorkspaceProject,
  right: WorkspaceProject,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.lessonType === right.lessonType &&
    left.entryFilePath === right.entryFilePath &&
    areStringArraysEqual(left.folders, right.folders) &&
    areWorkspaceFilesEqual(left.files, right.files)
  );
}

export function areWorkspaceSnapshotsEqual(
  left: WorkspaceRecordingSnapshot,
  right: WorkspaceRecordingSnapshot,
): boolean {
  return (
    left.activeFilePath === right.activeFilePath &&
    areWorkspaceProjectsEqual(left.project, right.project)
  );
}

export const DEFAULT_WORKSPACE_ENTRY_PATH = "index.html";
export const DEFAULT_WORKSPACE_APP_PATH = "src/App.tsx";

export const DEFAULT_WORKSPACE_FILE_CONTENT = `<html>
  <h1>Hello world</h1>
</html>`;

const STARTER_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><rect width="64" height="64" rx="18" fill="#121826"/><path d="M20 44 30 20h4l10 24h-5.1l-2-5.2H27.1L25 44H20Zm8.6-9.3h6.8L32 25.6l-3.4 9.1Z" fill="#7dd3fc"/><path d="m41 19 4.6 8-4.6 8h-5.4l4.6-8-4.6-8H41Z" fill="#f59e0b"/></svg>`;
const STARTER_REACT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-11.5 -10.23174 23 20.46348" aria-hidden="true"><circle cx="0" cy="0" r="2.05" fill="#61dafb"/><g stroke="#61dafb" stroke-width="1" fill="none"><ellipse rx="11" ry="4.2"/><ellipse rx="11" ry="4.2" transform="rotate(60)"/><ellipse rx="11" ry="4.2" transform="rotate(120)"/></g></svg>`;
const STARTER_VITE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="vite-a" x1="6" x2="38" y1="8" y2="52" gradientUnits="userSpaceOnUse"><stop stop-color="#41d1ff"/><stop offset="1" stop-color="#bd34fe"/></linearGradient><linearGradient id="vite-b" x1="24" x2="42" y1="14" y2="48" gradientUnits="userSpaceOnUse"><stop stop-color="#ffea83"/><stop offset=".5" stop-color="#ffdd35"/><stop offset="1" stop-color="#ffa800"/></linearGradient></defs><path fill="url(#vite-a)" d="M56 10 34.7 52.3a3 3 0 0 1-5.4 0L8 10.1a1.7 1.7 0 0 1 2-2.4l21.4 3.8a1.7 1.7 0 0 0 .6 0L54 7.7a1.7 1.7 0 0 1 2 2.3Z"/><path fill="url(#vite-b)" d="m41.9 14.3-15.7 3.1a.9.9 0 0 0-.7.8l-1 17a.9.9 0 0 0 1.1.9l4.4-1 2.6-11.2a.9.9 0 0 1 1.7-.1l1.6 3.8a.9.9 0 0 0 1 .5l5-.9a.9.9 0 0 0 .7-.8l.8-11.1a.9.9 0 0 0-1-.9Z"/></svg>`;

export function createStarterWorkspacePackageJson(projectName: string): string {
  const normalizedProjectName = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return JSON.stringify(
    {
      name: normalizedProjectName || "next-editor-react-starter",
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: {
        dev: "vite --host 0.0.0.0 --port 4173",
        build: "tsgo -p tsconfig.json --noEmit && vite build",
        preview: "vite preview --host 0.0.0.0 --port 4173",
      },
      dependencies: {
        react: "^19.2.5",
        "react-dom": "^19.2.5",
      },
      devDependencies: {
        "@typescript/native-preview": "7.0.0-dev.20260512.1",
        "@types/react": "^19.2.14",
        "@types/react-dom": "^19.2.3",
        "@vitejs/plugin-react": "^6.0.1",
        typescript: "~6.0.2",
        vite: "^8.0.11",
      },
    },
    null,
    2,
  );
}

export function normalizeWorkspacePath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .trim();
}

export function normalizeWorkspaceFolderPath(path: string): string {
  return normalizeWorkspacePath(path).replace(/\/+$/, "");
}

export function getWorkspaceBaseName(path: string): string {
  const normalizedPath = normalizeWorkspacePath(path);
  const segments = normalizedPath.split("/");
  return segments[segments.length - 1] || normalizedPath;
}

export function getParentWorkspacePath(path: string): string {
  const normalizedPath = normalizeWorkspacePath(path);
  const segments = normalizedPath.split("/");
  segments.pop();
  return segments.join("/");
}

export function joinWorkspacePath(parentPath: string, name: string): string {
  const normalizedParentPath = normalizeWorkspaceFolderPath(parentPath);
  const normalizedName = normalizeWorkspacePath(name);

  if (!normalizedParentPath) {
    return normalizedName;
  }

  return normalizeWorkspacePath(`${normalizedParentPath}/${normalizedName}`);
}

export function collectWorkspaceFolders(
  filePaths: string[],
  extraFolders: string[] = [],
): string[] {
  const folders = new Set<string>();

  const addFolderPath = (folderPath: string) => {
    let currentPath = normalizeWorkspaceFolderPath(folderPath);

    while (currentPath) {
      folders.add(currentPath);
      currentPath = getParentWorkspacePath(currentPath);
    }
  };

  for (const folderPath of extraFolders) {
    addFolderPath(folderPath);
  }

  for (const filePath of filePaths) {
    addFolderPath(getParentWorkspacePath(filePath));
  }

  return Array.from(folders).sort((left, right) => left.localeCompare(right));
}

export function inferLanguageFromPath(path: string): string {
  const normalizedPath = normalizeWorkspacePath(path).toLowerCase();

  if (normalizedPath.endsWith(".tsx") || normalizedPath.endsWith(".ts")) {
    return "typescript";
  }

  if (normalizedPath.endsWith(".jsx") || normalizedPath.endsWith(".js")) {
    return "javascript";
  }

  if (normalizedPath.endsWith(".json")) {
    return "json";
  }

  if (normalizedPath.endsWith(".css")) {
    return "css";
  }

  if (normalizedPath.endsWith(".md")) {
    return "markdown";
  }

  if (normalizedPath.endsWith(".html")) {
    return "html";
  }

  return "plaintext";
}

function createWorkspaceFile(path: string, content: string): WorkspaceFile {
  const normalizedPath = normalizeWorkspacePath(path);

  return {
    path: normalizedPath,
    name: getWorkspaceBaseName(normalizedPath),
    language: inferLanguageFromPath(normalizedPath),
    content,
  };
}

export function createStarterWorkspaceProject(): WorkspaceProject {
  const files = {
    "package.json": createWorkspaceFile(
      "package.json",
      createStarterWorkspacePackageJson("next-editor-react-starter"),
    ),
    "index.html": createWorkspaceFile(
      "index.html",
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Next Editor SPA</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`,
    ),
    "tsconfig.json": createWorkspaceFile(
      "tsconfig.json",
      `{
  "compilerOptions": {
    "target": "es2023",
    "module": "esnext",
    "lib": ["ES2023", "DOM"],
    "types": ["vite/client"],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}`,
    ),
    "vite.config.ts": createWorkspaceFile(
      "vite.config.ts",
      `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});`,
    ),
    "public/favicon.svg": createWorkspaceFile(
      "public/favicon.svg",
      STARTER_FAVICON_SVG,
    ),
    "src/assets/react.svg": createWorkspaceFile(
      "src/assets/react.svg",
      STARTER_REACT_SVG,
    ),
    "src/assets/vite.svg": createWorkspaceFile(
      "src/assets/vite.svg",
      STARTER_VITE_SVG,
    ),
    "src/main.tsx": createWorkspaceFile(
      "src/main.tsx",
      `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);`,
    ),
    "src/App.tsx": createWorkspaceFile(
      "src/App.tsx",
      `import { useState } from "react";
import reactLogo from "./assets/react.svg";
import viteLogo from "./assets/vite.svg";
import "./App.css";

function App() {
  const [count, setCount] = useState(0);

  return (
    <main className="app-shell">
      <section className="hero">
        <div className="hero-mark">
          <div className="hero-orb" aria-hidden="true" />
          <img src={reactLogo} className="hero-react" alt="React logo" />
          <img src={viteLogo} className="hero-vite" alt="Vite logo" />
        </div>
        <p className="eyebrow">React SPA</p>
        <h1>Get started</h1>
        <p className="intro">
          Edit <code>src/App.tsx</code> and save to test <code>HMR</code>.
        </p>
        <button
          type="button"
          className="counter"
          onClick={() => setCount((currentCount) => currentCount + 1)}
        >
          Count is {count}
        </button>
      </section>

      <section className="cards">
        <a className="card" href="https://vite.dev/" target="_blank">
          <span className="card-label">Tooling</span>
          <strong>Explore Vite</strong>
          <span>Fast builds, instant HMR, simple config.</span>
        </a>
        <a className="card" href="https://react.dev/" target="_blank">
          <span className="card-label">Framework</span>
          <strong>Learn React</strong>
          <span>Components, state, and the modern React model.</span>
        </a>
      </section>
    </main>
  );
}

export default App;`,
    ),
    "src/App.css": createWorkspaceFile(
      "src/App.css",
      `.app-shell {
  display: grid;
  gap: 2rem;
  min-height: 100svh;
  padding: 2rem;
}

.hero {
  display: grid;
  justify-items: center;
  align-content: center;
  gap: 1rem;
  min-height: min(40rem, 72svh);
  text-align: center;
}

.hero-mark {
  position: relative;
  width: 11rem;
  height: 11rem;
}

.hero-orb {
  position: absolute;
  inset: 0;
  border-radius: 38% 62% 44% 56% / 40% 37% 63% 60%;
  background:
    radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.95), rgba(255, 255, 255, 0.08) 26%, transparent 27%),
    linear-gradient(160deg, rgba(113, 230, 255, 0.85), rgba(73, 110, 255, 0.95));
  box-shadow: 0 18px 48px rgba(73, 110, 255, 0.18);
}

.hero-react,
.hero-vite {
  position: absolute;
  inset-inline: 0;
  margin: 0 auto;
}

.hero-react {
  top: 1.9rem;
  width: 3.2rem;
  height: 3.2rem;
  transform: perspective(2000px) rotateZ(318deg) rotateX(44deg) rotateY(39deg) scale(1.15);
}

.hero-vite {
  top: 6.2rem;
  width: 3rem;
  height: 3rem;
  transform: perspective(2000px) rotateZ(302deg) rotateX(40deg) rotateY(39deg) scale(0.82);
}

.eyebrow {
  margin: 0;
  color: var(--accent);
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.22em;
  text-transform: uppercase;
}

.intro {
  max-width: 38rem;
}

.counter {
  border: 2px solid transparent;
  border-radius: 999px;
  background: var(--accent-bg);
  color: var(--accent);
  cursor: pointer;
  padding: 0.75rem 1rem;
  transition: border-color 0.2s ease, transform 0.2s ease;
}

.counter:hover {
  border-color: var(--accent-border);
  transform: translateY(-1px);
}

.counter:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
}

.card {
  display: grid;
  gap: 0.45rem;
  padding: 1.25rem;
  border: 1px solid var(--border);
  border-radius: 1.25rem;
  background: var(--card-bg);
  color: inherit;
  text-decoration: none;
  transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}

.card:hover {
  border-color: var(--accent-border);
  box-shadow: var(--shadow);
  transform: translateY(-2px);
}

.card strong {
  color: var(--text-h);
  font-size: 1.05rem;
}

.card-label {
  color: var(--accent);
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

@media (max-width: 768px) {
  .app-shell {
    padding: 1.25rem;
  }

  .hero {
    min-height: 32rem;
  }

  .cards {
    grid-template-columns: 1fr;
  }
}`,
    ),
    "src/index.css": createWorkspaceFile(
      "src/index.css",
      `:root {
  --text: #64748b;
  --text-h: #0f172a;
  --bg: #f8fafc;
  --border: #dbe4f0;
  --code-bg: #e8eef7;
  --accent: #2563eb;
  --accent-bg: rgba(37, 99, 235, 0.1);
  --accent-border: rgba(37, 99, 235, 0.35);
  --card-bg: rgba(255, 255, 255, 0.76);
  --shadow: rgba(15, 23, 42, 0.08) 0 20px 40px -20px;
  font-family: "Avenir Next", "Segoe UI", sans-serif;
  line-height: 1.5;
  font-weight: 400;
  color: var(--text);
  background:
    radial-gradient(circle at top left, rgba(125, 211, 252, 0.35), transparent 30%),
    radial-gradient(circle at top right, rgba(59, 130, 246, 0.18), transparent 25%),
    linear-gradient(180deg, #f8fafc 0%, #eef4fb 100%);
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

@media (prefers-color-scheme: dark) {
  :root {
    --text: #94a3b8;
    --text-h: #e2e8f0;
    --bg: #020617;
    --border: #1e293b;
    --code-bg: #111827;
    --accent: #7dd3fc;
    --accent-bg: rgba(125, 211, 252, 0.12);
    --accent-border: rgba(125, 211, 252, 0.32);
    --card-bg: rgba(15, 23, 42, 0.72);
    --shadow: rgba(2, 6, 23, 0.45) 0 24px 48px -20px;
    background:
      radial-gradient(circle at top left, rgba(37, 99, 235, 0.25), transparent 26%),
      radial-gradient(circle at top right, rgba(14, 165, 233, 0.16), transparent 22%),
      linear-gradient(180deg, #020617 0%, #0f172a 100%);
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 320px;
}

#root {
  min-height: 100svh;
}

h1,
p {
  margin: 0;
}

h1 {
  color: var(--text-h);
  font-size: clamp(3rem, 7vw, 5.2rem);
  letter-spacing: -0.06em;
  line-height: 0.95;
}

code,
button {
  font: inherit;
}

code {
  padding: 0.15rem 0.45rem;
  border-radius: 0.5rem;
  background: var(--code-bg);
  color: var(--text-h);
}`,
    ),
  };

  return {
    id: "starter-workspace",
    name: "Next Editor Node.js",
    lessonType: "node.js",
    entryFilePath: DEFAULT_WORKSPACE_APP_PATH,
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}

export function createSingleFileWorkspace(
  content = DEFAULT_WORKSPACE_FILE_CONTENT,
): WorkspaceProject {
  return {
    id: "default-workspace",
    name: "Next Editor Workspace",
    lessonType: "html-css",
    entryFilePath: DEFAULT_WORKSPACE_ENTRY_PATH,
    folders: collectWorkspaceFolders([DEFAULT_WORKSPACE_ENTRY_PATH]),
    files: {
      [DEFAULT_WORKSPACE_ENTRY_PATH]: createWorkspaceFile(
        DEFAULT_WORKSPACE_ENTRY_PATH,
        content,
      ),
    },
  };
}