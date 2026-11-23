// A preview in a browser tab of its own, as the editor's "Open preview in a
// new tab" link opens one: no opener and no window above it, so no editor to
// ask for a control port. The browser stops the preview's idle service worker
// (Chrome: after 30 s), and the worker's port goes with it. The tab has to go
// on working then: with the editor's own preview frame open, and with it
// closed. No install: the server is node:http.
//
// The tab finds the preview's worker only where the browser lets it share the
// framed preview's storage. Playwright turns third-party storage partitioning
// off, so the harness's own page passes. Against a local Worker
// (WEBNODE_HARNESS_TARGET=http://localhost:…) the harness's own
// --disable-features replaces Playwright's list, partitioning is on as in a
// visitor's Chrome, and every *.localhost is a site of its own: the tab shows
// the connect page there, as it does from a dev server. A deployment's
// preview hosts are on the editor's site, where the tab works either way.
import type { HarnessApi } from "../webnode-harness";

const SERVER = `import { createServer } from "node:http";
let hits = 0;
createServer((request, response) => {
  if (request.url === "/api/hits") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ hits: ++hits }));
    return;
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end("<!doctype html><html><head><title>tab</title></head><body><h1>Preview tab</h1></body></html>");
}).listen(3000, () => console.log("listening on 3000"));
`;

export default async function (api: HarnessApi) {
  await api.call("mount", { "server.mjs": { file: { contents: SERVER } } });
  const runner = await api.terminal("node", ["server.mjs"]);
  await runner.expect("the server says it listens", /listening on 3000\r\n/, 30000);
  const server = await api.server({ port: 3000, runner, timeoutMs: 15000 });
  const preview = await api.preview(server.url);
  await preview.expect(
    "the editor's frame shows the page",
    (view) => view.text === "Preview tab",
    20000,
  );

  // The link the editor's preview toolbar renders, clicked as a visitor clicks it.
  await api.page.evaluate((href) => {
    const link = document.createElement("a");
    link.id = "open-preview-tab";
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open preview in a new tab";
    document.body.prepend(link);
  }, server.url);
  const [tab] = await Promise.all([
    api.page.waitForEvent("popup"),
    api.page.click("#open-preview-tab"),
  ]);
  await tab.waitForLoadState();
  const heading = () => tab.textContent("h1", { timeout: 10000 }).catch(() => null);
  const shown = await heading();
  api.check(
    "the tab shows the page",
    shown === "Preview tab",
    `at ${tab.url()} it shows ${JSON.stringify(shown ?? (await tab.title().catch(() => "")))}`,
  );
  api.check(
    "the tab has no window above it and no opener",
    await tab.evaluate(() => window.parent === window && window.opener === null),
  );

  // What the browser does to an idle worker, without the wait. The worker that
  // answers the next request is a new one: it has no port.
  const devtools = await tab.context().newCDPSession(tab);
  let onStopped: (() => void) | null = null;
  devtools.on("ServiceWorker.workerVersionUpdated", (event) => {
    for (const version of event.versions) {
      if (version.runningStatus === "stopped") {
        onStopped?.();
      }
    }
  });
  await devtools.send("ServiceWorker.enable");
  const stopWorker = async () => {
    const stopped = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      onStopped = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
    await devtools.send("ServiceWorker.stopAllWorkers");
    const done = await stopped;
    onStopped = null;
    if (!done) {
      throw new Error("the service worker did not stop");
    }
  };
  /** The count the server answers the tab's own request with; minus the status when it fails. */
  const hits = () =>
    tab.evaluate(async () => {
      const response = await fetch("/api/hits");
      return response.ok ? ((await response.json()) as { hits: number }).hits : -response.status;
    });

  api.check("the tab's request is answered", (await hits()) === 1);

  await api.section("the worker stopped, the editor's frame open", async () => {
    await stopWorker();
    const answer = await hits();
    api.check("the tab's request is answered", answer === 2, `got ${answer}`);
  });

  await api.closePreview();

  await api.section("the worker stopped, the editor's frame closed", async () => {
    await stopWorker();
    const answer = await hits();
    api.check("the tab's request is answered", answer > 0, `got ${answer}`);
    // The port the tab handed over is replaced: a second stop is survived too.
    await stopWorker();
    const again = await hits();
    api.check("and again after a second stop", again === answer + 1, `got ${again}`);
  });

  await api.section("the worker stopped, the tab reloaded", async () => {
    await stopWorker();
    await tab.reload();
    const shown = await heading();
    api.check("the tab shows the page", shown === "Preview tab", `it shows ${shown}`);
    await stopWorker();
    const answer = await hits();
    api.check("the reloaded tab's request is answered", answer > 0, `got ${answer}`);
  });

  await tab.close();
}
