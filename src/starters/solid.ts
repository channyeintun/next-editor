import { collectWorkspaceFolders, type WorkspaceProject } from "../types/workspace";
import { createMinimalLessonStyles, createViteSpaPackageJson, createWorkspaceFile } from "./shared";

export function createStarterSolidWorkspace(): WorkspaceProject {
  const files = {
    "package.json": createWorkspaceFile(
      "package.json",
      createViteSpaPackageJson(
        "solid-lesson",
        { "solid-js": "^1.9.0" },
        { "vite-plugin-solid": "^2.11.0" },
      ),
    ),
    "vite.config.js": createWorkspaceFile(
      "vite.config.js",
      `import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
});
`,
    ),
    "index.html": createWorkspaceFile(
      "index.html",
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Solid Lesson</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/index.jsx"></script>
  </body>
</html>
`,
    ),
    "src/index.jsx": createWorkspaceFile(
      "src/index.jsx",
      `import { render } from "solid-js/web";
import App from "./App.jsx";
import "./style.css";

render(() => <App />, document.getElementById("root"));
`,
    ),
    "src/App.jsx": createWorkspaceFile(
      "src/App.jsx",
      `import { createSignal } from "solid-js";

export default function App() {
  const [count, setCount] = createSignal(0);

  return (
    <main class="page">
      <h1>Hello Solid</h1>
      <p>Edit <code>src/App.jsx</code> to get started.</p>
      <button type="button" onClick={() => setCount(count() + 1)}>
        Count is {count()}
      </button>
    </main>
  );
}
`,
    ),
    "src/style.css": createWorkspaceFile("src/style.css", createMinimalLessonStyles("#2c4f7c")),
  };

  return {
    id: "solid-workspace",
    name: "Solid Lesson",
    lessonType: "solid",
    entryFilePath: "src/App.jsx",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}
