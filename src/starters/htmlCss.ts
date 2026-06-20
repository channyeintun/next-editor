import {
  collectWorkspaceFolders,
  DEFAULT_WORKSPACE_ENTRY_PATH,
  type WorkspaceProject,
} from "../types/workspace";
import { createHtmlCssLessonPackageJson, createWorkspaceFile } from "./shared";

export function createStarterHtmlCssWorkspace(): WorkspaceProject {
  const files = {
    "package.json": createWorkspaceFile("package.json", createHtmlCssLessonPackageJson()),
    "index.html": createWorkspaceFile(
      "index.html",
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/styles.css" />
    <title>HTML/CSS Lesson</title>
  </head>
  <body>
    <main class="page">
      <h1>Hello world</h1>
      <p>Edit <code>index.html</code> and <code>styles.css</code> to get started.</p>
      <p><a href="/about.html">Go to the About page &rarr;</a></p>
    </main>
  </body>
</html>`,
    ),
    "about.html": createWorkspaceFile(
      "about.html",
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/styles.css" />
    <title>About &middot; HTML/CSS Lesson</title>
  </head>
  <body>
    <main class="page">
      <h1>About</h1>
      <p>This page is served by Vite inside the WebContainer, so links between pages work.</p>
      <p><a href="/">&larr; Back home</a></p>
    </main>
  </body>
</html>`,
    ),
    "styles.css": createWorkspaceFile(
      "styles.css",
      `:root {
  color-scheme: light dark;
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
  font-size: 2.5rem;
  margin: 0 0 0.75rem;
}

a {
  color: #2563eb;
}

code {
  padding: 0.1rem 0.35rem;
  border-radius: 0.35rem;
  background: rgba(127, 127, 127, 0.18);
}`,
    ),
  };

  return {
    id: "html-css-workspace",
    name: "HTML/CSS Lesson",
    lessonType: "html-css",
    entryFilePath: DEFAULT_WORKSPACE_ENTRY_PATH,
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}
