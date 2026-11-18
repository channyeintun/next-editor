// A Vite + React project from the registry: install, dev server, render, a
// click, and an edit that arrives by HMR with the component's state kept.
// Every step throws when it does not hold.
import type { HarnessApi } from "../webnode-harness";

export default async function (api: HarnessApi) {
  await api.call("mount", {
    "package.json": {
      file: {
        contents: JSON.stringify({
          name: "react-lesson",
          private: true,
          version: "0.0.0",
          type: "module",
          scripts: { dev: "vite" },
          dependencies: { react: "18.3.1", "react-dom": "18.3.1" },
          devDependencies: {
            "@vitejs/plugin-react": process.env.PLUGIN ?? "4.3.4",
            vite: process.env.VITE ?? "5.4.21",
          },
        }),
      },
    },
    "vite.config.js": {
      file: {
        contents: `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nexport default defineConfig({ plugins: [react()] });\n`,
      },
    },
    "index.html": {
      file: {
        contents: `<!doctype html><html><head><meta charset="utf-8"><title>React</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>`,
      },
    },
    src: {
      directory: {
        "main.jsx": {
          file: {
            contents: `import { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\nimport "./styles.css";\ncreateRoot(document.getElementById("root")).render(<App />);\n`,
          },
        },
        "App.jsx": {
          file: {
            contents: `import { useState } from "react";\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return <main><h1 id="title">Hello Vite</h1><button id="b" onClick={() => setCount(count + 1)}>count is {count}</button></main>;\n}\n`,
          },
        },
        "styles.css": { file: { contents: `body { font-family: sans-serif; }\n` } },
      },
    },
  });
  let started = Date.now();
  const install = await api.sh("pnpm install", { timeoutMs: 300000 });
  api.check(
    `pnpm install exits 0 (${Date.now() - started} ms)`,
    install.code === 0,
    `exit ${install.code}${install.timedOut ? ", timed out" : ""}: ${JSON.stringify(install.output.slice(-800))}`,
  );
  started = Date.now();
  const runner = await api.terminal("sh", ["-lc", "pnpm dev"]);
  await runner.expect("vite says it is ready", /ready in/, 90000);
  const server = await api.server({ port: 5173, runner, timeoutMs: 15000 });
  console.log(`     server announced ${Date.now() - started} ms after pnpm dev`);
  const preview = await api.preview(server.url);
  await preview.expect(
    "the app renders",
    (view) =>
      view.title === "React" && view.text === "Hello Vite count is 0" && view.overlay === null,
    90000,
  );
  await preview.click("#b");
  await preview.expect(
    "a click updates the state",
    (view) => view.text === "Hello Vite count is 1",
    5000,
  );
  const edit = await api.sh(
    `sed -i 's/Hello Vite/Hello HMR/' src/App.jsx && grep -c HMR src/App.jsx`,
    { timeoutMs: 10000 },
  );
  api.check(
    "the edit is on disk",
    edit.code === 0 && edit.output.trim() === "1",
    JSON.stringify(edit),
  );
  started = Date.now();
  await preview.expect(
    "HMR shows the edit and keeps the state",
    (view) => view.text === "Hello HMR count is 1" && view.overlay === null,
    20000,
  );
  console.log(`     HMR in ${Date.now() - started} ms`);
}
