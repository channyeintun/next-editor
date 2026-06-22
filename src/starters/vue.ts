import { collectWorkspaceFolders, type WorkspaceProject } from "../types/workspace";
import { createMinimalLessonStyles, createViteSpaPackageJson, createWorkspaceFile } from "./shared";

export function createStarterVueWorkspace(): WorkspaceProject {
  const files = {
    "package.json": createWorkspaceFile(
      "package.json",
      createViteSpaPackageJson("vue-lesson", { vue: "^3.5.0" }, { "@vitejs/plugin-vue": "^6.0.7" }),
    ),
    "vite.config.js": createWorkspaceFile(
      "vite.config.js",
      `import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
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
    <title>Vue Lesson</title>
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
      `import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";

createApp(App).mount("#app");
`,
    ),
    "src/App.vue": createWorkspaceFile(
      "src/App.vue",
      `<script setup>
import { ref } from "vue";

const count = ref(0);
</script>

<template>
  <main class="page">
    <h1>Hello Vue</h1>
    <p>Edit <code>src/App.vue</code> to get started.</p>
    <button type="button" @click="count++">Count is {{ count }}</button>
  </main>
</template>
`,
    ),
    "src/style.css": createWorkspaceFile("src/style.css", createMinimalLessonStyles("#42b883")),
  };

  return {
    id: "vue-workspace",
    name: "Vue Lesson",
    lessonType: "vue",
    entryFilePath: "src/App.vue",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}
