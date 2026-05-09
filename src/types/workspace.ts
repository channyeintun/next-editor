export interface WorkspaceFile {
  path: string;
  name: string;
  language: string;
  content: string;
}

export interface WorkspaceProject {
  id: string;
  name: string;
  entryFilePath: string;
  files: Record<string, WorkspaceFile>;
}

export interface WorkspaceRecordingSnapshot {
  project: WorkspaceProject;
  activeFilePath: string;
}

export const DEFAULT_WORKSPACE_ENTRY_PATH = "index.html";
export const DEFAULT_WORKSPACE_APP_PATH = "src/App.jsx";

export const DEFAULT_WORKSPACE_FILE_CONTENT = `<html>
  <h1>Hello world</h1>
</html>`;

export function normalizeWorkspacePath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .trim();
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
  const segments = normalizedPath.split("/");

  return {
    path: normalizedPath,
    name: segments[segments.length - 1] || normalizedPath,
    language: inferLanguageFromPath(normalizedPath),
    content,
  };
}

export function createStarterWorkspaceProject(): WorkspaceProject {
  return {
    id: "starter-workspace",
    name: "Next Editor SPA",
    entryFilePath: DEFAULT_WORKSPACE_APP_PATH,
    files: {
      "package.json": createWorkspaceFile(
        "package.json",
        JSON.stringify(
          {
            name: "next-editor-webcontainer-starter",
            private: true,
            version: "0.0.0",
            type: "module",
            scripts: {
              dev: "vite --host 0.0.0.0 --port 4173",
              build: "vite build",
              preview: "vite preview --host 0.0.0.0 --port 4173",
            },
            dependencies: {
              react: "^19.2.0",
              "react-dom": "^19.2.0",
            },
            devDependencies: {
              "@vitejs/plugin-react": "^6.0.1",
              vite: "^8.0.11",
            },
          },
          null,
          2,
        ),
      ),
      "index.html": createWorkspaceFile(
        "index.html",
        `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Next Editor Starter</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>`,
      ),
      "vite.config.js": createWorkspaceFile(
        "vite.config.js",
        `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});`,
      ),
      "src/main.jsx": createWorkspaceFile(
        "src/main.jsx",
        `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);`,
      ),
      "src/App.jsx": createWorkspaceFile(
        "src/App.jsx",
        `export default function App() {
  return (
    <main className="app-shell">
      <p className="eyebrow">WebContainer Runtime</p>
      <h1>Next Editor starter project is running.</h1>
      <p>
        Edit files from the sidebar and the preview will update through the
        in-browser Vite runtime.
      </p>
    </main>
  );
}`,
      ),
      "src/styles.css": createWorkspaceFile(
        "src/styles.css",
        `:root {
  color: #e2e8f0;
  background: radial-gradient(circle at top, #1e293b, #020617 65%);
  font-family: "IBM Plex Sans", system-ui, sans-serif;
}

body {
  margin: 0;
  min-height: 100vh;
}

#root {
  min-height: 100vh;
}

.app-shell {
  min-height: 100vh;
  display: grid;
  align-content: center;
  gap: 1rem;
  padding: 3rem;
}

.eyebrow {
  margin: 0;
  color: #38bdf8;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}

h1,
p {
  margin: 0;
  max-width: 40rem;
}`,
      ),
    },
  };
}

export function createSingleFileWorkspace(
  content = DEFAULT_WORKSPACE_FILE_CONTENT,
): WorkspaceProject {
  return {
    id: "default-workspace",
    name: "Next Editor Workspace",
    entryFilePath: DEFAULT_WORKSPACE_ENTRY_PATH,
    files: {
      [DEFAULT_WORKSPACE_ENTRY_PATH]: createWorkspaceFile(
        DEFAULT_WORKSPACE_ENTRY_PATH,
        content,
      ),
    },
  };
}
