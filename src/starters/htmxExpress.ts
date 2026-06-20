import { collectWorkspaceFolders, type WorkspaceProject } from "../types/workspace";
import { createMinimalLessonStyles, createWorkspaceFile } from "./shared";

export function createStarterHtmxExpressWorkspace(): WorkspaceProject {
  const files = {
    "package.json": createWorkspaceFile(
      "package.json",
      JSON.stringify(
        {
          name: "htmx-express-lesson",
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

// HTMX swaps this HTML fragment into the page when the button is clicked.
app.get("/api/time", (req, res) => {
  res.send(\`<p>Server time: \${new Date().toLocaleTimeString()}</p>\`);
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
    <script src="https://unpkg.com/htmx.org@2.0.4"></script>
    <script>
      // The live preview injects a bootstrap <script> (declaring globals like
      // __WC_ENV__) into every HTML response, including the fragments htmx swaps
      // in. Re-executing it throws "Identifier '__WC_ENV__' has already been
      // declared", so tell htmx to leave scripts inside swapped content inert.
      htmx.config.allowScriptTags = false;
    </script>
    <title>HTMX + Express Lesson</title>
  </head>
  <body>
    <main class="page">
      <h1>Hello HTMX</h1>
      <p>This button asks the Express server for the current time.</p>
      <button type="button" hx-get="/api/time" hx-target="#result" hx-swap="innerHTML">
        Get server time
      </button>
      <div id="result"></div>
    </main>
  </body>
</html>
`,
    ),
    "public/styles.css": createWorkspaceFile(
      "public/styles.css",
      createMinimalLessonStyles("#3d72d7"),
    ),
  };

  return {
    id: "htmx-express-workspace",
    name: "HTMX + Express Lesson",
    lessonType: "htmx-express",
    entryFilePath: "public/index.html",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}
