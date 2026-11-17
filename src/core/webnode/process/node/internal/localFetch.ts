// `fetch` for a server inside the runtime. The browser's own fetch cannot see a
// port a process listens on, so a request to localhost goes through the `http`
// client (real HTTP/1.1 over a kernel connection) and comes back as a Response.
import http from "../http";
import { isLocalHost } from "../net/ip";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODILESS_STATUSES = new Set([101, 204, 205, 304]);
const MAX_REDIRECTS = 20;

interface IncomingLike {
  statusCode?: number;
  statusMessage?: string;
  rawHeaders: string[];
  headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (value?: unknown) => void): unknown;
  resume(): unknown;
  destroy(error?: Error): unknown;
}

function failed(cause: unknown): TypeError {
  return Object.assign(new TypeError("fetch failed"), { cause });
}

/**
 * The request headers to send: the `Request`'s, which a browser has already
 * stripped of the names it forbids a page to set (Cookie, Origin, Referer …),
 * plus the caller's own, read without that filter. Node's fetch sends them all,
 * and here the request never leaves the runtime.
 */
function requestHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  request: Request,
): Headers {
  const headers = new Headers(request.headers);
  const own =
    init?.headers !== undefined
      ? new Headers(init.headers)
      : input instanceof Request
        ? input.headers
        : null;
  own?.forEach((value, name) => {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  });
  return headers;
}

/** Undici drops these when a redirect goes to another origin. */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/**
 * A `Response` built by a page has Set-Cookie removed from its headers. The
 * one handed back keeps the headers as they arrived, as Node's fetch does,
 * clones included.
 */
function withHeaders(response: Response, headers: Headers): Response {
  const clone = response.clone.bind(response);
  Object.defineProperty(response, "headers", { value: headers });
  Object.defineProperty(response, "clone", {
    value: () => withHeaders(clone(), new Headers(headers)),
  });
  return response;
}

function send(
  request: Request,
  requestHeaderBag: Headers,
  body: Uint8Array | null,
  redirects: number,
): Promise<Response> {
  const url = new URL(request.url);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    requestHeaderBag.forEach((value, name) => {
      headers[name] = value;
    });
    if (body && headers["content-length"] === undefined) {
      headers["content-length"] = String(body.byteLength);
    }

    const outgoing = http.request(
      {
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
      },
      (incoming: unknown) => {
        const response = incoming as IncomingLike;
        const status = response.statusCode ?? 0;
        const location = response.headers.location;

        if (REDIRECT_STATUSES.has(status) && typeof location === "string") {
          if (request.redirect === "error") {
            response.resume();
            reject(failed(new Error("unexpected redirect")));
            return;
          }
          if (request.redirect === "follow") {
            response.resume();
            if (redirects >= MAX_REDIRECTS) {
              reject(failed(new Error("redirect count exceeded")));
              return;
            }
            const keepsMethod = status === 307 || status === 308;
            const target = new URL(location, url);
            const nextHeaders = new Headers(requestHeaderBag);
            if (target.origin !== url.origin) {
              for (const name of CREDENTIAL_HEADERS) {
                nextHeaders.delete(name);
              }
            }
            const next = new Request(target, {
              method: keepsMethod ? request.method : "GET",
              headers: nextHeaders,
              body: keepsMethod && body ? (body as BodyInit) : undefined,
              redirect: request.redirect,
              signal: request.signal,
            });
            fetchLocalOrNative(next, nextHeaders, keepsMethod ? body : null, redirects + 1).then(
              resolve,
              reject,
            );
            return;
          }
        }

        const responseHeaders = new Headers();
        for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
          try {
            responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
          } catch {
            // A header value `Headers` will not carry is left out.
          }
        }
        const bodiless = request.method === "HEAD" || BODILESS_STATUSES.has(status);
        const stream = bodiless
          ? null
          : new ReadableStream<Uint8Array>({
              start(controller) {
                response.on("data", (chunk) =>
                  controller.enqueue(new Uint8Array(chunk as Uint8Array)),
                );
                response.on("end", () => controller.close());
                response.on("error", (error) => controller.error(error));
              },
              cancel() {
                response.destroy();
              },
            });
        if (bodiless) {
          response.resume();
        }
        try {
          const result = new Response(stream, {
            status,
            statusText: response.statusMessage ?? "",
            headers: responseHeaders,
          });
          Object.defineProperty(result, "url", { value: request.url });
          Object.defineProperty(result, "redirected", { value: redirects > 0 });
          resolve(withHeaders(result, responseHeaders));
        } catch (error) {
          reject(failed(error));
        }
      },
    );

    outgoing.on("error", (error: unknown) => reject(failed(error)));
    const abort = () => {
      outgoing.destroy();
      reject(request.signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
    };
    if (request.signal.aborted) {
      abort();
      return;
    }
    request.signal.addEventListener("abort", abort, { once: true });
    if (body) {
      outgoing.write(body);
    }
    outgoing.end();
  });
}

let nativeFetch: typeof fetch | null = null;

function isLocalUrl(url: URL): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    isLocalHost(url.hostname.replace(/^\[|\]$/g, ""))
  );
}

function fetchLocalOrNative(
  request: Request,
  headers: Headers,
  body: Uint8Array | null,
  redirects: number,
): Promise<Response> {
  if (isLocalUrl(new URL(request.url))) {
    return send(request, headers, body, redirects);
  }
  return nativeFetch!(request);
}

/**
 * Wraps `native` so requests to the runtime's own localhost reach the servers
 * its processes listen with; every other request goes to `native` untouched.
 */
export function createFetch(native: typeof fetch): typeof fetch {
  nativeFetch = native;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let target: URL;
    try {
      target = new URL(input instanceof Request ? input.url : String(input));
    } catch {
      return native(input, init);
    }
    if (!isLocalUrl(target)) {
      return native(input, init);
    }
    const request = new Request(input, init);
    const headers = requestHeaders(input, init, request);
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
    return send(request, headers, body, 0);
  };
}
