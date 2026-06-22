import { collectWorkspaceFolders, type WorkspaceProject } from "../types/workspace";
import { createMinimalLessonStyles, createViteSpaPackageJson, createWorkspaceFile } from "./shared";

export function createStarterSvelteWorkspace(): WorkspaceProject {
  const files = {
    "package.json": createWorkspaceFile(
      "package.json",
      createViteSpaPackageJson(
        "svelte-lesson",
        {},
        { "@sveltejs/vite-plugin-svelte": "^7.1.2", svelte: "^5.0.0" },
      ),
    ),
    "svelte.config.js": createWorkspaceFile(
      "svelte.config.js",
      `import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess(),
};
`,
    ),
    "vite.config.js": createWorkspaceFile(
      "vite.config.js",
      `import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
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
    <title>Svelte Lesson</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`,
    ),
    "src/main.js": createWorkspaceFile(
      "src/main.js",
      `import { mount } from "svelte";
import App from "./App.svelte";
import "./style.css";

const app = mount(App, { target: document.getElementById("app") });

export default app;
`,
    ),
    "src/App.svelte": createWorkspaceFile(
      "src/App.svelte",
      `<script>
  let count = $state(0);
</script>

<main class="page">
  <h1>Hello Svelte</h1>
  <p>Edit <code>src/App.svelte</code> to get started.</p>
  <button type="button" onclick={() => count++}>Count is {count}</button>
</main>
`,
    ),
    "src/style.css": createWorkspaceFile("src/style.css", createMinimalLessonStyles("#ff3e00")),
  };

  return {
    id: "svelte-workspace",
    name: "Svelte Lesson",
    lessonType: "svelte",
    entryFilePath: "src/App.svelte",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}
