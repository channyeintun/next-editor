// One HTTP request from the preview, carried to the server over a fresh
// ByteChannel and its response streamed back: head as soon as it is parsed,
// body chunks as they arrive, an HTML document buffered and given the preview
// scripts. Also the header policy (isolation headers, hop-by-hop stripping, the
// preview origin restated as the server's own and back) and the 502 page shown
// when no server answers.
import { toSystemErrorRecord } from "../errors";
import type { ByteChannel } from "../process/runtime";
import {
  allowNonceInHeaders,
  createNonce,
  decodeHtmlBody,
  injectScripts,
  isCspHeader,
  isInjectableHtml,
} from "./htmlInject";
import {
  BodyDecoder,
  ResponseHeadParser,
  headerValue,
  responseFraming,
  serializeRequestHead,
} from "./http1";
import type { ResponseHead } from "./http1";
import type { HeaderList } from "./protocol";

/** The isolation policy the preview origin answers with. */
export type PreviewCoep = "require-corp" | "credentialless" | "none";

/** One request from the preview page. */
export interface HttpExchangeRequest {
  method: string;
  /** Path and query. */
  url: string;
  headers: HeaderList;
  body: Uint8Array | null;
  /** The preview origin's host, when the service worker said it. */
  pageHost?: string | null;
}

/** Where the response goes. Exactly one of `end`/`error` follows a `head`, or `error` alone. */
export interface HttpExchangeSink {
  head(status: number, statusText: string, headers: HeaderList): void;
  chunk(bytes: Uint8Array): void;
  end(): void;
  error(message: string): void;
}

export interface HttpExchangeOptions {
  connect(port: number): Promise<ByteChannel>;
  serverPort: number;
  /** The script sources to inject into HTML, in order (empty ones are skipped). */
  scripts(): string[];
  /** The client script alone, for the gateway's own error pages. */
  clientScript: string;
  coep: PreviewCoep;
}

const encoder = new TextEncoder();

/** Response headers that describe the hop, not the resource. */
function isHopByHopResponseHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith("proxy-") ||
    lower === "connection" ||
    lower === "keep-alive" ||
    lower === "transfer-encoding" ||
    lower === "upgrade" ||
    lower === "trailer"
  );
}

/**
 * The request destinations that load a document. Only their responses get the
 * client script: a `fetch()`, an XHR or an HTML fragment gets the server's
 * bytes as they are.
 */
const DOCUMENT_DESTINATIONS = new Set(["document", "iframe", "frame", "embed", "object"]);

function isDocumentRequest(headers: HeaderList): boolean {
  const destination = headerValue(headers, "sec-fetch-dest");
  // A service worker from before it restated Sec-Fetch-Dest sent page loads only that way.
  return destination === null || DOCUMENT_DESTINATIONS.has(destination.trim().toLowerCase());
}

/** The names the server's own origin goes by. */
const SERVER_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/**
 * `value` as a path on the preview when it is an absolute URL on the server's
 * own origin (`http://localhost:<serverPort>/x`, which is the Host the server
 * sees), else `value` unchanged. Sent to the page as is, such a URL would take
 * the preview to the visitor's own machine.
 */
export function previewLocation(value: string, serverPort: number): string {
  const trimmed = value.trim();
  if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(trimmed)) {
    return value;
  }
  let url: URL;
  try {
    url = new URL(trimmed, `http://localhost:${serverPort}/`);
  } catch {
    return value;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return value;
  }
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!SERVER_HOSTNAMES.has(url.hostname) || port !== serverPort) {
    return value;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** A `Refresh` value (`5; url=…`) with its URL mapped by `previewLocation`. */
function previewRefresh(value: string, serverPort: number): string {
  const match = /^(.*?\burl\s*=\s*)(["']?)(.*?)\2(\s*)$/i.exec(value);
  return match
    ? `${match[1]}${match[2]}${previewLocation(match[3], serverPort)}${match[2]}${match[4]}`
    : value;
}

/**
 * The page's headers as the server should see them. The server is reached as
 * `localhost:<serverPort>` (its Host), so an Origin or Referer on the preview
 * origin is restated on that origin: a CSRF check that compares Origin with
 * Host then passes for the page's own requests, as it does on a dev machine.
 */
export function serverRequestHeaders(
  headers: HeaderList,
  pageHost: string | null,
  serverPort: number,
): HeaderList {
  if (!pageHost) {
    return headers;
  }
  const serverOrigin = `http://localhost:${serverPort}`;
  return headers.map(([name, value]) => {
    const lower = name.toLowerCase();
    if (lower !== "origin" && lower !== "referer") {
      return [name, value];
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return [name, value];
    }
    if (url.host !== pageHost || (url.protocol !== "http:" && url.protocol !== "https:")) {
      return [name, value];
    }
    return [
      name,
      lower === "origin" ? serverOrigin : `${serverOrigin}${url.pathname}${url.search}`,
    ];
  });
}

/**
 * The headers handed back to the page: hop-by-hop ones removed, isolation ones
 * set, and, with `serverPort`, redirects to the server's own origin made paths
 * on the preview.
 */
export function previewResponseHeaders(
  headers: HeaderList,
  coep: PreviewCoep,
  serverPort?: number,
): HeaderList {
  const out: HeaderList = [];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (
      isHopByHopResponseHeader(lower) ||
      lower === "cross-origin-resource-policy" ||
      lower === "cross-origin-embedder-policy"
    ) {
      continue;
    }
    if (serverPort !== undefined && (lower === "location" || lower === "content-location")) {
      out.push([name, previewLocation(value, serverPort)]);
    } else if (serverPort !== undefined && lower === "refresh") {
      out.push([name, previewRefresh(value, serverPort)]);
    } else {
      out.push([name, value]);
    }
  }
  out.push(["Cross-Origin-Resource-Policy", "cross-origin"]);
  if (coep !== "none") {
    out.push(["Cross-Origin-Embedder-Policy", coep]);
  }
  return out;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** The self-contained page answered when the server cannot be reached. */
export function badGatewayPage(clientScript: string, title: string, detail: string): string {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>502 Bad Gateway</title>` +
    `<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;` +
    `background:#1f2127;color:#c9ccd3;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}` +
    `main{max-width:32rem;padding:16px;text-align:center}h1{font-size:16px;font-weight:600;margin:0 0 8px}` +
    `p{margin:0;color:#8d919a}</style></head><body><main><h1>${escapeHtml(title)}</h1>` +
    `<p>${escapeHtml(detail)}</p></main></body></html>`;
  return injectScripts(html, [clientScript]);
}

/** Starts the exchange. `cancel` drops the connection; nothing more reaches `sink` after it. */
export function startHttpExchange(
  options: HttpExchangeOptions,
  request: HttpExchangeRequest,
  sink: HttpExchangeSink,
): { cancel(): void } {
  const { serverPort, coep } = options;
  const method = request.method.toUpperCase();
  let channel: ByteChannel | null = null;
  let settled = false;
  let cancelled = false;
  let headSent = false;
  const headParser = new ResponseHeadParser();
  let head: ResponseHead | null = null;
  let decoder: BodyDecoder | null = null;
  let htmlParts: Uint8Array[] | null = null;
  const isDocument = isDocumentRequest(request.headers);

  function release(): void {
    if (channel) {
      channel.onData = null;
      channel.onEnd = null;
      channel.onClose = null;
      channel.destroy();
    }
  }

  function badGateway(title: string, detail: string): void {
    settled = true;
    release();
    const body = encoder.encode(badGatewayPage(options.clientScript, title, detail));
    sink.head(
      502,
      "Bad Gateway",
      previewResponseHeaders(
        [
          ["Content-Type", "text/html; charset=utf-8"],
          ["Cache-Control", "no-store"],
          ["Content-Length", String(body.length)],
        ],
        coep,
      ),
    );
    sink.chunk(body);
    sink.end();
  }

  function fail(error: unknown): void {
    if (settled) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (!headSent) {
      badGateway(
        "The server sent an invalid response",
        `The server on port ${serverPort} did not answer with valid HTTP: ${message}`,
      );
      return;
    }
    settled = true;
    release();
    sink.error(message);
  }

  function sendHead(responseHead: ResponseHead, headers: HeaderList): void {
    headSent = true;
    sink.head(
      responseHead.status,
      responseHead.statusText,
      previewResponseHeaders(headers, coep, serverPort),
    );
  }

  async function finishHtml(responseHead: ResponseHead, parts: Uint8Array[]): Promise<void> {
    const raw = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      raw.set(part, offset);
      offset += part.length;
    }
    let body = raw;
    let headers = responseHead.headers;
    try {
      // A server CSP would block the injected inline scripts: they carry a
      // nonce the policy is rewritten to allow.
      const nonce = responseHead.headers.some(([name]) => isCspHeader(name))
        ? createNonce()
        : undefined;
      const html = injectScripts(
        await decodeHtmlBody(raw, responseHead.headers),
        options.scripts(),
        nonce,
      );
      body = encoder.encode(html);
      const contentType = headerValue(responseHead.headers, "content-type") ?? "text/html";
      const allowed = nonce
        ? allowNonceInHeaders(responseHead.headers, nonce)
        : responseHead.headers;
      headers = allowed.filter(([name]) => {
        const lower = name.toLowerCase();
        return (
          lower !== "content-encoding" && lower !== "content-length" && lower !== "content-type"
        );
      });
      headers.push(["Content-Type", `${contentType.split(";")[0].trim()}; charset=utf-8`]);
      headers.push(["Content-Length", String(body.length)]);
    } catch {
      // A body that does not decode goes back exactly as the server sent it.
    }
    if (cancelled) {
      return;
    }
    sendHead(responseHead, headers);
    if (body.length > 0) {
      sink.chunk(body);
    }
    sink.end();
  }

  function complete(): void {
    settled = true;
    release();
    if (!head) {
      return;
    }
    if (htmlParts) {
      void finishHtml(head, htmlParts);
      return;
    }
    sink.end();
  }

  function onData(input: Uint8Array): void {
    let chunk = input;
    while (!decoder) {
      const parsed = headParser.feed(chunk);
      if (!parsed) {
        return;
      }
      chunk = parsed.rest;
      if (parsed.head.status >= 100 && parsed.head.status < 200 && parsed.head.status !== 101) {
        continue; // An interim response; the real one follows.
      }
      head = parsed.head;
      const framing = responseFraming(method, head);
      decoder = new BodyDecoder(framing);
      if (isDocument && framing.kind !== "none" && isInjectableHtml(head.headers)) {
        htmlParts = [];
      } else {
        sendHead(head, head.headers);
      }
    }
    if (!decoder.done) {
      decoder.feed(chunk, (data) => {
        if (htmlParts) {
          htmlParts.push(data.slice());
        } else {
          sink.chunk(data.slice());
        }
      });
    }
    if (decoder.done) {
      complete();
    }
  }

  function onEof(): void {
    if (settled) {
      return;
    }
    if (!decoder) {
      badGateway(
        "The server closed the connection",
        `The server on port ${serverPort} closed the connection before sending a response.`,
      );
      return;
    }
    try {
      decoder.finish();
    } catch (error) {
      fail(error);
      return;
    }
    complete();
  }

  options.connect(serverPort).then(
    (opened) => {
      if (cancelled) {
        opened.destroy();
        return;
      }
      channel = opened;
      opened.onData = (chunk) => {
        if (settled) {
          return;
        }
        try {
          onData(chunk);
        } catch (error) {
          fail(error);
        }
      };
      opened.onEnd = onEof;
      opened.onClose = onEof;
      const bodyLength =
        request.body !== null
          ? request.body.length
          : method === "POST" || method === "PUT" || method === "PATCH"
            ? 0
            : null;
      opened.write(
        serializeRequestHead(
          method,
          request.url,
          serverPort,
          serverRequestHeaders(request.headers, request.pageHost ?? null, serverPort),
          bodyLength,
        ),
      );
      if (request.body !== null && request.body.length > 0) {
        opened.write(request.body);
      }
    },
    (error: unknown) => {
      if (cancelled) {
        return;
      }
      const code = toSystemErrorRecord(error)?.code;
      if (code === "ECONNREFUSED") {
        badGateway(
          `No server is listening on port ${serverPort}`,
          "Start the dev server, then reload the preview.",
        );
      } else {
        badGateway(
          `Could not connect to port ${serverPort}`,
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  );

  return {
    cancel(): void {
      if (cancelled) {
        return;
      }
      cancelled = true;
      settled = true;
      release();
    },
  };
}
