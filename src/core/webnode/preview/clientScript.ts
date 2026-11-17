// The script the gateway injects first into every HTML document of a preview:
// a runtime-backed `WebSocket` (so Vite's HMR client reaches the dev server),
// a refusal of the page's own service worker registrations, the hand-off of a fresh control port when the service worker lost its own,
// reload on request from the editor, and error forwarding to the editor. Every
// message to the editor names the editor's origin as its target, and messages
// from the parent are accepted only from that origin, so a page that frames
// the preview cannot hand it a control port or read what it reports.
//
// The source is plain ES2020 kept in a string (not a stringified function) so
// no bundler, minifier or coverage tool can rewrite it on the way into a page.

/** What the injected client does besides WebSockets. */
export interface PreviewClientScriptOptions {
  /** Forward uncaught errors, unhandled rejections and (unless "exceptions-only") `console.error`. */
  forwardPreviewErrors: boolean | "exceptions-only";
  /** The editor's origin (`https://example.com`): the only parent the client talks to. */
  editorOrigin: string;
}

/** The source of the injected client: a self-contained IIFE, safe to run twice. */
export function createPreviewClientScript(options: PreviewClientScriptOptions): string {
  const config = JSON.stringify({
    forwardPreviewErrors: options.forwardPreviewErrors,
    editorOrigin: options.editorOrigin,
  }).replace(/</g, "\\u003c");
  return `(function (config) {
"use strict";
if (window.__webnodePreviewClient) return;
Object.defineProperty(window, "__webnodePreviewClient", { value: true });

var parentWindow = window.parent !== window ? window.parent : null;
var editorOrigin = config.editorOrigin;
var serviceWorker = typeof navigator !== "undefined" && navigator.serviceWorker ? navigator.serviceWorker : null;
var encoder = new TextEncoder();

/* ── WebSocket ─────────────────────────────────────────────────────────── */

var NativeWebSocket = window.WebSocket;
var LOCAL_HOSTNAMES = { "localhost": true, "127.0.0.1": true, "0.0.0.0": true, "[::1]": true };
var CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;
var TOKEN = /^[!#$%&'*+.^_|~0-9A-Za-z-]+$/;

function syntaxError(message) {
  return new DOMException("Failed to construct 'WebSocket': " + message, "SyntaxError");
}

function resolveSocketUrl(url) {
  var parsed;
  try {
    parsed = new URL(String(url), location.href);
  } catch (error) {
    throw syntaxError("The URL '" + url + "' is invalid.");
  }
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  else if (parsed.protocol === "https:") parsed.protocol = "wss:";
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw syntaxError("The URL's scheme must be either 'http', 'https', 'ws', or 'wss'. '" + parsed.protocol.slice(0, -1) + "' is not allowed.");
  }
  parsed.hash = "";
  return parsed;
}

function normalizeProtocols(protocols) {
  var list = protocols === undefined ? [] : typeof protocols === "string" ? [protocols] : Array.prototype.slice.call(protocols).map(String);
  var seen = {};
  for (var i = 0; i < list.length; i++) {
    if (!TOKEN.test(list[i])) throw syntaxError("The subprotocol '" + list[i] + "' is invalid.");
    var key = list[i].toLowerCase();
    if (seen[key]) throw syntaxError("The subprotocol '" + list[i] + "' is duplicated.");
    seen[key] = true;
  }
  return list;
}

function isRuntimeUrl(url) {
  return url.host === location.host || LOCAL_HOSTNAMES[url.hostname] === true;
}

function makeCloseEvent(code, reason, wasClean) {
  if (typeof CloseEvent === "function") {
    return new CloseEvent("close", { code: code, reason: reason, wasClean: wasClean });
  }
  var event = new Event("close");
  Object.defineProperties(event, { code: { value: code }, reason: { value: reason }, wasClean: { value: wasClean } });
  return event;
}

var HANDLERS = ["open", "message", "error", "close"];
/* The gateway ports of the sockets still open, told "going away" when the page unloads. */
var openPorts = new Set();

class WebSocket extends EventTarget {
  #url;
  #origin;
  #state = CONNECTING;
  #protocol = "";
  #extensions = "";
  #binaryType = "blob";
  #buffered = 0;
  #port = null;
  #handlers = { open: null, message: null, error: null, close: null };
  #blobChain = null;

  constructor(url, protocols) {
    var resolved = resolveSocketUrl(url);
    var list = normalizeProtocols(protocols);
    if (!isRuntimeUrl(resolved) && typeof NativeWebSocket === "function") {
      return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    }
    super();
    this.#url = resolved.href;
    this.#origin = resolved.origin;
    for (var i = 0; i < HANDLERS.length; i++) {
      var type = HANDLERS[i];
      this.addEventListener(type, this.#runHandler.bind(this, type));
    }
    var controller = serviceWorker && serviceWorker.controller;
    if (!controller) {
      var self = this;
      setTimeout(function () { self.#onGateway({ type: "error" }); self.#onGateway({ type: "close", code: 1006, reason: "", wasClean: false }); }, 0);
      return;
    }
    var channel = new MessageChannel();
    this.#port = channel.port1;
    openPorts.add(this.#port);
    this.#port.onmessage = (event) => this.#onGateway(event.data);
    controller.postMessage({ type: "webnode:ws", url: this.#url, protocols: list, port: channel.port2 }, [channel.port2]);
  }

  #runHandler(type, event) {
    var handler = this.#handlers[type];
    if (typeof handler === "function") handler.call(this, event);
  }

  #onGateway(data) {
    if (!data || this.#state === CLOSED) return;
    if (data.type === "open") {
      this.#state = OPEN;
      this.#protocol = data.protocol || "";
      this.#extensions = data.extensions || "";
      this.dispatchEvent(new Event("open"));
    } else if (data.type === "message") {
      if (this.#state !== OPEN) return;
      var payload = data.data;
      if (typeof payload !== "string" && this.#binaryType === "blob") payload = new Blob([payload]);
      this.dispatchEvent(new MessageEvent("message", { data: payload, origin: this.#origin }));
    } else if (data.type === "sent") {
      this.#buffered = Math.max(0, this.#buffered - data.bytes);
    } else if (data.type === "error") {
      this.dispatchEvent(new Event("error"));
    } else if (data.type === "close") {
      this.#state = CLOSED;
      if (this.#port) { openPorts.delete(this.#port); this.#port.onmessage = null; this.#port.close(); this.#port = null; }
      this.dispatchEvent(makeCloseEvent(data.code, data.reason || "", !!data.wasClean));
    }
  }

  get url() { return this.#url; }
  get readyState() { return this.#state; }
  get protocol() { return this.#protocol; }
  get extensions() { return this.#extensions; }
  get bufferedAmount() { return this.#buffered; }
  get binaryType() { return this.#binaryType; }
  set binaryType(value) { if (value === "blob" || value === "arraybuffer") this.#binaryType = value; }
  get onopen() { return this.#handlers.open; }
  set onopen(value) { this.#handlers.open = typeof value === "function" ? value : null; }
  get onmessage() { return this.#handlers.message; }
  set onmessage(value) { this.#handlers.message = typeof value === "function" ? value : null; }
  get onerror() { return this.#handlers.error; }
  set onerror(value) { this.#handlers.error = typeof value === "function" ? value : null; }
  get onclose() { return this.#handlers.close; }
  set onclose(value) { this.#handlers.close = typeof value === "function" ? value : null; }

  send(data) {
    if (arguments.length === 0) throw new TypeError("Failed to execute 'send' on 'WebSocket': 1 argument required, but only 0 present.");
    if (this.#state === CONNECTING) throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", "InvalidStateError");
    var message, size;
    if (data instanceof ArrayBuffer) {
      message = data.slice(0);
      size = message.byteLength;
    } else if (ArrayBuffer.isView(data)) {
      message = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
      size = message.byteLength;
    } else if (typeof Blob === "function" && data instanceof Blob) {
      message = data;
      size = data.size;
    } else {
      message = String(data);
      size = encoder.encode(message).length;
    }
    this.#buffered += size;
    if (this.#state !== OPEN) return;
    var port = this.#port;
    var post = function (value) {
      if (!port) return;
      if (typeof value === "string") port.postMessage({ type: "send", data: value });
      else port.postMessage({ type: "send", data: value }, [value]);
    };
    if (message instanceof ArrayBuffer || typeof message === "string") {
      if (this.#blobChain) this.#blobChain = this.#blobChain.then(function () { post(message); });
      else post(message);
    } else {
      var read = message.arrayBuffer();
      var previous = this.#blobChain || Promise.resolve();
      var chain = previous.then(function () { return read; }).then(post, function () {});
      this.#blobChain = chain;
      var socket = this;
      chain.then(function () { if (socket.#blobChain === chain) socket.#blobChain = null; });
    }
  }

  close(code, reason) {
    if (code !== undefined) {
      code = Number(code);
      if (!(code === 1000 || (Number.isInteger(code) && code >= 3000 && code <= 4999))) {
        throw new DOMException("Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. " + code + " is neither.", "InvalidAccessError");
      }
    }
    if (reason !== undefined) {
      reason = String(reason);
      if (encoder.encode(reason).length > 123) {
        throw new DOMException("Failed to execute 'close' on 'WebSocket': The close reason must not be greater than 123 UTF-8 bytes.", "SyntaxError");
      }
    }
    if (this.#state === CLOSING || this.#state === CLOSED) return;
    var wasConnecting = this.#state === CONNECTING;
    this.#state = CLOSING;
    if (!this.#port) return;
    if (wasConnecting) this.#port.postMessage({ type: "close" });
    else this.#port.postMessage({ type: "close", code: code === undefined && reason !== undefined ? 1000 : code, reason: reason || "" });
  }
}

var CONSTANTS = { CONNECTING: { value: CONNECTING, enumerable: true }, OPEN: { value: OPEN, enumerable: true }, CLOSING: { value: CLOSING, enumerable: true }, CLOSED: { value: CLOSED, enumerable: true } };
Object.defineProperties(WebSocket, CONSTANTS);
Object.defineProperties(WebSocket.prototype, CONSTANTS);
Object.defineProperty(WebSocket, Symbol.hasInstance, {
  value: function (value) {
    if (typeof NativeWebSocket === "function" && value instanceof NativeWebSocket) return true;
    return Function.prototype[Symbol.hasInstance].call(WebSocket, value);
  },
});
Object.defineProperty(window, "WebSocket", { value: WebSocket, writable: true, configurable: true, enumerable: false });

/* Leaving the page closes its sockets with 1001 (going away), as a browser does. */
window.addEventListener("pagehide", function () {
  openPorts.forEach(function (port) {
    try { port.postMessage({ type: "close", code: 1001, reason: "" }); } catch (error) { /* already gone */ }
  });
});

/* ── a page's own service worker ────────────────────────────────────────── */

/* The preview's own service worker serves this origin; a page's worker would
   replace it (same scope) and the host does not serve the page's script. So a
   registration fails at once, saying why, instead of with a MIME-type error. */
if (serviceWorker && typeof serviceWorker.register === "function") {
  try {
    Object.defineProperty(serviceWorker, "register", {
      configurable: true,
      writable: true,
      value: function register() {
        return Promise.reject(new DOMException("Failed to register a ServiceWorker: previews do not support page service workers.", "NotSupportedError"));
      },
    });
  } catch (error) { /* left as the browser has it */ }
}

/* ── control port hand-off ─────────────────────────────────────────────── */

var asking = false;
var askTimer = 0;
var askTries = 0;

function stopAsking() {
  asking = false;
  clearInterval(askTimer);
}

function requestPort() {
  if (!parentWindow || asking) return;
  asking = true;
  askTries = 0;
  var ask = function () {
    if (++askTries > 5) { stopAsking(); return; }
    parentWindow.postMessage({ type: "webnode:preview-connect" }, editorOrigin);
  };
  ask();
  askTimer = setInterval(ask, 1000);
}

window.addEventListener("message", function (event) {
  if (!parentWindow || event.source !== parentWindow || event.origin !== editorOrigin) return;
  var data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "webnode:reload") {
    location.reload();
  } else if (data.type === "webnode:preview-port" && asking) {
    var port = data.port || (event.ports && event.ports[0]);
    var controller = serviceWorker && serviceWorker.controller;
    if (!port || !controller) return;
    stopAsking();
    controller.postMessage({ type: "webnode:attach", control: port }, [port]);
  }
});

if (serviceWorker) {
  serviceWorker.addEventListener("message", function (event) {
    if (event.data && event.data.type === "webnode:need-port") requestPort();
  });
  if (typeof serviceWorker.startMessages === "function") serviceWorker.startMessages();
}

/* ── error forwarding ──────────────────────────────────────────────────── */

var MAX_STRING = 10000;

function forward(payload) {
  if (!parentWindow) return;
  payload.pathname = location.pathname;
  payload.search = location.search;
  payload.hash = location.hash;
  try {
    parentWindow.postMessage({ type: "webnode:preview-message", payload: payload }, editorOrigin);
  } catch (error) {
    /* A payload that still cannot be cloned is dropped rather than thrown into the page. */
  }
}

function truncate(text) {
  return text.length > MAX_STRING ? text.slice(0, MAX_STRING) + "…" : text;
}

function describe(value) {
  try {
    return String(value);
  } catch (error) {
    return Object.prototype.toString.call(value);
  }
}

function cloneSafe(value) {
  if (typeof value === "string") return truncate(value);
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString() + "n";
  if (typeof value === "symbol" || typeof value === "function") return truncate(describe(value));
  if (value instanceof Error) return { name: value.name, message: truncate(String(value.message)), stack: value.stack ? truncate(String(value.stack)) : undefined };
  try {
    return structuredClone(value);
  } catch (error) {
    return truncate(describe(value));
  }
}

function errorFields(error, fallback) {
  if (error instanceof Error) return { message: String(error.message), stack: error.stack ? String(error.stack) : undefined };
  return { message: error === undefined ? fallback : truncate(describe(error)), stack: undefined };
}

if (config.forwardPreviewErrors) {
  window.addEventListener("error", function (event) {
    var fields = errorFields(event.error, event.message || "Script error.");
    forward({ type: "PREVIEW_UNCAUGHT_EXCEPTION", message: event.message || fields.message, stack: fields.stack });
  });
  window.addEventListener("unhandledrejection", function (event) {
    var fields = errorFields(event.reason, "Unhandled promise rejection");
    forward({ type: "PREVIEW_UNHANDLED_REJECTION", message: fields.message, stack: fields.stack });
  });
  if (config.forwardPreviewErrors !== "exceptions-only" && typeof console !== "undefined") {
    var originalError = console.error;
    console.error = function () {
      try {
        var args = Array.prototype.slice.call(arguments).map(cloneSafe);
        forward({ type: "PREVIEW_CONSOLE_ERROR", args: args, stack: new Error().stack });
      } catch (error) {
        /* Forwarding never breaks the page's own logging. */
      }
      return originalError.apply(this, arguments);
    };
  }
}
})(${config});
`;
}
