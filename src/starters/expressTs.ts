import { collectWorkspaceFolders, type WorkspaceProject } from "../types/workspace";
import { createMinimalLessonStyles, createWorkspaceFile } from "./shared";

export function createStarterExpressTsWorkspace(): WorkspaceProject {
  const files = {
    "package.json": createWorkspaceFile(
      "package.json",
      JSON.stringify(
        {
          name: "express-ts-lesson",
          private: true,
          version: "0.0.0",
          type: "module",
          scripts: {
            // tsx runs the TypeScript entry directly (no build step) and reloads
            // on save, so the WebContainer's `npm run dev` boots the API server.
            dev: "tsx watch src/server.ts",
            start: "tsx src/server.ts",
          },
          dependencies: {
            express: "^5.1.0",
          },
          devDependencies: {
            "@types/express": "^5.0.0",
            "@types/node": "^22.10.2",
            tsx: "^4.19.2",
            typescript: "^5.7.2",
          },
        },
        null,
        2,
      ),
    ),
    "tsconfig.json": createWorkspaceFile(
      "tsconfig.json",
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            types: ["node"],
          },
          include: ["src"],
        },
        null,
        2,
      ),
    ),
    "src/server.ts": createWorkspaceFile(
      "src/server.ts",
      `import express, { type Request, type Response } from "express";

const app = express();
const port = 3000;

// Parse JSON request bodies and serve the static landing page from public/.
app.use(express.json());
app.use(express.static("public"));

interface Todo {
  id: number;
  title: string;
  done: boolean;
}

// A tiny in-memory store so the API has something to return. Restarting the
// server resets it — persistence is out of scope for a hello-world backend.
const todos: Todo[] = [
  { id: 1, title: "Learn Express", done: true },
  { id: 2, title: "Build a JSON API", done: false },
];

// GET /api/health — a simple liveness check.
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// GET /api/todos — list every todo.
app.get("/api/todos", (_req: Request, res: Response) => {
  res.json(todos);
});

// POST /api/todos — add a todo from a JSON body like { "title": "..." }.
// Send the header "Content-Type: application/json" so express.json() parses the
// body; without it req.body is undefined, so read it defensively.
app.post("/api/todos", (req: Request, res: Response) => {
  const title = (req.body as { title?: string } | undefined)?.title;

  if (!title) {
    res.status(400).json({ error: "title is required" });
    return;
  }

  const todo: Todo = { id: todos.length + 1, title, done: false };
  todos.push(todo);
  res.status(201).json(todo);
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
    <title>Express + TypeScript Lesson</title>
  </head>
  <body>
    <main class="page">
      <h1>Express + TypeScript</h1>
      <p>
        A minimal JSON backend. Try these endpoints from the
        <strong>API</strong> tab in the preview panel:
      </p>
      <ul>
        <li><code>GET /api/health</code> — server status</li>
        <li><code>GET /api/todos</code> — list todos</li>
        <li>
          <code>POST /api/todos</code> — add a todo with a JSON body like
          <code>{ "title": "Ship it" }</code>
        </li>
      </ul>
    </main>
  </body>
</html>
`,
    ),
    "public/styles.css": createWorkspaceFile(
      "public/styles.css",
      createMinimalLessonStyles("#22a06b"),
    ),
  };

  return {
    id: "express-ts-workspace",
    name: "Express + TypeScript Lesson",
    lessonType: "express-ts",
    entryFilePath: "src/server.ts",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}
