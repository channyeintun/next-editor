import { collectWorkspaceFolders, type WorkspaceProject } from "../types/workspace";
import { createMinimalLessonStyles, createWorkspaceFile } from "./shared";

export function createStarterAlpineExpressWorkspace(): WorkspaceProject {
  const files = {
    "package.json": createWorkspaceFile(
      "package.json",
      JSON.stringify(
        {
          name: "alpine-express-lesson",
          private: true,
          version: "0.0.0",
          type: "module",
          scripts: {
            dev: "node server.js",
            start: "node server.js",
          },
          dependencies: {
            express: "^5.1.0",
          },
        },
        null,
        2,
      ),
    ),
    "server.js": createWorkspaceFile(
      "server.js",
      `import express from "express";

const app = express();
const port = 3000;

// Serve the static HTML/CSS from the public/ folder.
app.use(express.static("public"));

// Alpine AJAX submits the form, then merges the element whose id matches the
// form's x-target ("result") out of this response into the page. So the
// fragment we send back must contain an element with that same id.
app.get("/api/time", (req, res) => {
  res.send(
    \`<div id="result"><p>Server time: \${new Date().toLocaleTimeString()}</p></div>\`,
  );
});

app.listen(port, "0.0.0.0", () => {
  console.log(\`Server running on http://localhost:\${port}\`);
});
`,
    ),
    "public/index.html": createWorkspaceFile(
      "public/index.html",
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/styles.css" />
    <!-- Alpine AJAX must load BEFORE Alpine core so it can register its
         directives; both use defer, which runs them in document order. The live
         preview injects its recorder <script> into fragment responses too, but
         Alpine AJAX parses responses with DOMParser, so those scripts never
         re-execute on a merge. -->
    <script
      defer
      src="https://cdn.jsdelivr.net/npm/@imacrayon/alpine-ajax@0.12.0/dist/cdn.min.js"
    ></script>
    <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js"></script>
    <title>Alpine AJAX + Express Lesson</title>
  </head>
  <body>
    <main class="page" x-data>
      <h1>Hello Alpine AJAX</h1>
      <p>This form asks the Express server for the current time.</p>
      <form x-target="result" method="get" action="/api/time">
        <button type="submit">Get server time</button>
      </form>
      <div id="result"></div>
    </main>
  </body>
</html>
`,
    ),
    "public/styles.css": createWorkspaceFile(
      "public/styles.css",
      createMinimalLessonStyles("#37b6ce"),
    ),
  };

  return {
    id: "alpine-express-workspace",
    name: "Alpine AJAX + Express Lesson",
    lessonType: "alpine-express",
    entryFilePath: "public/index.html",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}
