// The page a preview origin shows before its service worker can reach the
// runtime: it asks the editor (its parent window) for a control port, registers
// the service worker of the editor's build, hands the port to that worker, and
// reloads into the preview.
import { BUILD_PARAMETER, STALE_BUILD_MESSAGE } from "../buildId";
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

/** What the page says when the host no longer serves the editor's build. */
const STALE_TEXT = `${STALE_BUILD_MESSAGE[0].toUpperCase()}${STALE_BUILD_MESSAGE.slice(1)}.`;

/**
 * The page's script, taking a connection only from a parent at `editorOrigin`.
 * The service worker it registers is the one of the editor's build (the editor
 * names it with the port): a worker of another build could speak another
 * protocol to the editor's gateway. The worker's URL names that build, so the
 * browser's own update check never swaps in a newer build's worker either: the
 * host of a newer build refuses an older one's URL with 409.
 */
const script = (editorOrigin: string) => `(function () {
  "use strict";
  var EDITOR = ${JSON.stringify(editorOrigin)};
  var WORKER = ${JSON.stringify(PREVIEW_SERVICE_WORKER_PATH)};
  var BUILD_PARAMETER = ${JSON.stringify(BUILD_PARAMETER)};
  var STALE = ${JSON.stringify(STALE_TEXT)};
  var msg = document.getElementById("msg");
  var note = document.getElementById("note");
  var spin = document.getElementById("spin");
  function show(text, detail, keepSpinner) {
    msg.textContent = text;
    note.textContent = detail || "";
    if (!keepSpinner) spin.style.display = "none";
  }
  // The editor shows this beside the preview: the page itself may be hidden.
  function fail(text, detail) {
    show(text, detail);
    if (window.parent !== window) {
      window.parent.postMessage({
        type: "webnode:preview-message",
        payload: { type: "preview_unavailable", message: detail ? text + " " + detail : text }
      }, EDITOR);
    }
  }
  if (!("serviceWorker" in navigator)) {
    fail("This browser cannot show the preview.", "Service workers are unavailable here (a private window can disable them).");
    return;
  }
  if (window.parent === window) {
    show("Open this preview from the editor.");
    return;
  }
  // Resolves with the registration's worker once it is the worker at url.
  function activeWorker(registration, url) {
    return new Promise(function (resolve, reject) {
      function check() {
        var active = registration.active;
        if (active && active.scriptURL === url) { resolve(active); return; }
        var next = registration.installing || registration.waiting;
        if (!next) { reject(new Error("The preview's service worker did not start.")); return; }
        next.addEventListener("statechange", function onChange() {
          if (next.state !== "activated" && next.state !== "redundant") return;
          next.removeEventListener("statechange", onChange);
          check();
        });
      }
      check();
    });
  }
  function startWorker(build) {
    var path = build ? WORKER + "?" + BUILD_PARAMETER + "=" + encodeURIComponent(build) : WORKER;
    return navigator.serviceWorker
      .register(path, { scope: "/" })
      .then(function (registration) { return activeWorker(registration, new URL(path, location.href).href); })
      .catch(function (error) {
        // The host serves a newer build than the editor's: say so, not a script error.
        return fetch(path, { cache: "no-store" }).then(
          function (response) { throw response.status === 409 ? { stale: true } : error; },
          function () { throw error; }
        );
      });
  }
  var started = Date.now();
  var waiting = false;
  var stopped = false;
  var waitTimer = 0;
  var askTimer = 0;
  window.addEventListener("message", function (event) {
    if (stopped || waiting || event.source !== window.parent || event.origin !== EDITOR) return;
    var data = event.data;
    if (!data || data.type !== "webnode:preview-port") return;
    var port = data.port || (event.ports && event.ports[0]);
    if (!port) return;
    waiting = true;
    startWorker(typeof data.build === "string" ? data.build : "").then(function (worker) {
      var reply = new MessageChannel();
      reply.port1.onmessage = function (answer) {
        if (answer.data && answer.data.type === "webnode:attached") location.reload();
      };
      worker.postMessage({ type: "webnode:attach", control: port, reply: reply.port2 }, [port, reply.port2]);
      // No answer from the worker: go back to asking.
      clearTimeout(waitTimer);
      waitTimer = setTimeout(function () { waiting = false; }, 3000);
    }, function (error) {
      stopped = true;
      clearInterval(askTimer);
      if (error && error.stale) {
        fail("The preview could not start.", STALE);
        return;
      }
      // A browser that blocks third-party cookies refuses a service worker in an embedded page.
      fail(
        "The preview could not start.",
        String((error && error.message) || error) + " If this browser blocks third-party cookies, allow them for " + location.host + "."
      );
    });
  });
  function ask() {
    if (waiting || stopped) return;
    window.parent.postMessage({ type: "webnode:preview-connect" }, EDITOR);
    if (Date.now() - started > 15000) {
      note.textContent = "The editor has not answered yet. Still trying…";
    }
  }
  ask();
  askTimer = setInterval(ask, 1000);
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
