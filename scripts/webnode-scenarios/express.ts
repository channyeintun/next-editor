// Express 4 from the registry: install, start, and a page whose own POST to
// the server comes back. Every step throws when it does not hold.
import type { HarnessApi } from "../webnode-harness";

export default async function (api: HarnessApi) {
  await api.call("mount", {
    "package.json": {
      file: {
        contents: JSON.stringify({
          name: "ex",
          private: true,
          type: "module",
          scripts: { dev: "node server.js" },
          dependencies: { express: "4.21.2" },
        }),
      },
    },
    "server.js": {
      file: {
        contents: `import express from "express";
const app = express();
app.use(express.json());
app.get("/", (req, res) => res.send("<!doctype html><html><head><title>t</title></head><body><h1 id='h'>Hello from Express</h1><script>fetch('/api/echo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({n:21})}).then(r=>r.json()).then(j=>{document.getElementById('h').textContent+=' '+j.doubled})</script></body></html>"));
app.post("/api/echo", (req, res) => res.json({ doubled: req.body.n * 2 }));
app.listen(3000, () => console.log("listening on 3000"));
`,
      },
    },
  });
  const started = Date.now();
  const install = await api.sh("pnpm install", { timeoutMs: 180000 });
  api.check(
    `pnpm install exits 0 (${Date.now() - started} ms)`,
    install.code === 0 && install.output.includes("+ express 4.21.2"),
    `exit ${install.code}${install.timedOut ? ", timed out" : ""}: ${JSON.stringify(install.output.slice(-800))}`,
  );
  const runner = await api.terminal("sh", ["-lc", "pnpm dev"]);
  await runner.expect("the server says it listens", /listening on 3000\r\n/, 30000);
  const server = await api.server({ port: 3000, runner, timeoutMs: 15000 });
  const preview = await api.preview(server.url);
  await preview.expect(
    "the page shows the answer to its own POST",
    (view) => view.text === "Hello from Express 42",
    20000,
  );
}
