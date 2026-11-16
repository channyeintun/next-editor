// The page a preview origin shows before its service worker can reach the
// runtime: it registers the worker, asks the editor (its parent window) for a
// control port, hands that port to the worker, and reloads into the preview.
import { PREVIEW_SERVICE_WORKER_PATH } from "./protocol";

/**
 * The global the host's server sets, ahead of a script it serves, to the
 * editor's origin (hostResponses.ts).
 */
export const EDITOR_ORIGIN_GLOBAL = "__WEBNODE_EDITOR_ORIGIN__";

/** The editor origin this script was served for; an origin no window has when it was not told. */
export function servedEditorOrigin(): string {
  const origin = (globalThis as Record<string, unknown>)[EDITOR_ORIGIN_GLOBAL];
  return typeof origin === "string" ? origin : "about:invalid";
}

/** The page's script, taking a connection only from a parent at `editorOrigin`. */
const script = (editorOrigin: string) => `(function () {
  "use strict";
  var EDITOR = ${JSON.stringify(editorOrigin)};
  var msg = document.getElementById("msg");
  var note = document.getElementById("note");
  var spin = document.getElementById("spin");
  function show(text, detail, keepSpinner) {
    msg.textContent = text;
    note.textContent = detail || "";
    if (!keepSpinner) spin.style.display = "none";
  }
  if (!("serviceWorker" in navigator)) {
    show("This browser cannot show the preview.", "Service workers are unavailable here (a private window can disable them).");
    return;
  }
  navigator.serviceWorker
    .register(${JSON.stringify(PREVIEW_SERVICE_WORKER_PATH)}, { scope: "/" })
    .then(function () { return navigator.serviceWorker.ready; })
    .then(function (registration) {
      var worker = registration.active || navigator.serviceWorker.controller;
      if (window.parent === window) {
        show("Open this preview from the editor.");
        return;
      }
      var started = Date.now();
      var waiting = false;
      var waitTimer = 0;
      window.addEventListener("message", function (event) {
        if (waiting || event.source !== window.parent || event.origin !== EDITOR) return;
        var data = event.data;
        if (!data || data.type !== "webnode:preview-port") return;
        var port = data.port || (event.ports && event.ports[0]);
        if (!port || !worker) return;
        waiting = true;
        var reply = new MessageChannel();
        reply.port1.onmessage = function (answer) {
          if (answer.data && answer.data.type === "webnode:attached") location.reload();
        };
        worker.postMessage({ type: "webnode:attach", control: port, reply: reply.port2 }, [port, reply.port2]);
        // No answer from the worker: go back to asking.
        clearTimeout(waitTimer);
        waitTimer = setTimeout(function () { waiting = false; }, 3000);
      });
      function ask() {
        if (waiting) return;
        window.parent.postMessage({ type: "webnode:preview-connect" }, EDITOR);
        if (Date.now() - started > 15000) {
          note.textContent = "The editor has not answered yet. Still trying…";
        }
      }
      ask();
      setInterval(ask, 1000);
    })
    .catch(function (error) {
      show("The preview could not start.", String((error && error.message) || error));
    });
})();`;

/**
 * A complete, self-contained HTML document: "Connecting to preview…". Only a
 * parent window at `editorOrigin` can hand it a connection to a runtime, so no
 * other site can put its own content on a preview origin.
 */
export function createPreviewConnectHtml(editorOrigin: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Connecting to preview…</title>
<style>
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;background:#2a2d33;color:#d4d7dd;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.box{display:flex;flex-direction:column;align-items:center;gap:12px;padding:16px;text-align:center;max-width:32rem}
.spin{width:20px;height:20px;border:2px solid #4b4f58;border-top-color:#d4d7dd;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation-duration:2.4s}}
.note{min-height:1.5em;color:#9a9ea7;font-size:12px}
</style>
</head>
<body>
<div class="box" role="status" aria-live="polite">
<div class="spin" id="spin" aria-hidden="true"></div>
<div id="msg">Connecting to preview…</div>
<div class="note" id="note"></div>
</div>
<script>${script(editorOrigin).replace(/<\/script/gi, "<\\/script")}</script>
</body>
</html>
`;
}

/** The connect page the preview service worker serves: for the editor it was served for. */
export const PREVIEW_CONNECT_HTML = createPreviewConnectHtml(servedEditorOrigin());
