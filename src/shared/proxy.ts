// Shared same-origin HTTPS fetch proxy for the Worker and Vite development server.
// It intentionally accepts public hosts, so each outbound request must be validated
// before it is sent and the response body must remain bounded while streaming.

const BLOCKED_HOSTS = new Set(["localhost"]);
export const MAX_PROXY_REDIRECTS = 5;
export const MAX_PROXY_RESPONSE_BYTES = 200 * 1024 * 1024;
export const PROXY_TIMEOUT_MS = 15_000;

function isBlockedIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return true;
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Rejects literal loopback, private, link-local, multicast, and reserved hosts. */
export function isPubliclyRoutableHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".local")) return false;
  if (isBlockedIpv4(host)) return false;

  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare.includes(":")) {
    return !(
      bare === "::" ||
      bare === "::1" ||
      bare.startsWith("fe80:") ||
      bare.startsWith("fc") ||
      bare.startsWith("fd") ||
      bare.startsWith("ff")
    );
  }
  return true;
}

function validateTarget(url: URL): string | null {
  if (url.protocol !== "https:") return "Only https: URLs may be proxied.";
  if (url.username || url.password) return "URLs with credentials may not be proxied.";
  if (url.port && url.port !== "443") return "Only the standard HTTPS port may be proxied.";
  if (!isPubliclyRoutableHost(url.hostname)) return `Host '${url.hostname}' is not allowed.`;
  return null;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function parseContentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (!raw) return null;
  const length = Number(raw);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

function limitBody(
  body: ReadableStream<Uint8Array>,
  abortController: AbortController,
  onFinished: () => void,
): ReadableStream<Uint8Array> {
  let bytes = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > MAX_PROXY_RESPONSE_BYTES) {
          abortController.abort();
          onFinished();
          throw new Error("Upstream response exceeds the proxy size limit.");
        }
        controller.enqueue(chunk);
      },
      flush() {
        onFinished();
      },
    }),
  );
}

export interface ProxyResult {
  status: number;
  body?: ReadableStream<Uint8Array>;
  contentType?: string;
  error?: string;
}

/** Reads a bounded proxy body for consumers that must persist bytes (such as R2 image ingestion). */
export async function readProxyBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("Consumer size limit exceeded");
        throw new Error("Upstream response exceeds the consumer size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/** Validates and fetches an external URL without buffering its successful response. */
export async function proxyUrl(rawUrl: string | null): Promise<ProxyResult> {
  if (!rawUrl) return { status: 400, error: "Missing required 'url' query parameter." };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { status: 400, error: "Invalid 'url' query parameter." };
  }
  const initialError = validateTarget(url);
  if (initialError) return { status: 400, error: initialError };

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), PROXY_TIMEOUT_MS);
  let responseStreamOwnsTimeout = false;
  try {
    for (let redirectCount = 0; redirectCount <= MAX_PROXY_REDIRECTS; redirectCount += 1) {
      let response: Response;
      try {
        response = await fetch(url.toString(), {
          redirect: "manual",
          signal: abortController.signal,
          headers: { Accept: "*/*" },
        });
      } catch (cause) {
        return { status: 502, error: `Upstream fetch failed: ${String(cause)}` };
      }

      if (isRedirect(response.status)) {
        if (redirectCount === MAX_PROXY_REDIRECTS) {
          return { status: 502, error: "Upstream exceeded the redirect limit." };
        }
        const location = response.headers.get("location");
        if (!location) return { status: 502, error: "Upstream redirect had no location." };
        try {
          url = new URL(location, url);
        } catch {
          return { status: 502, error: "Upstream redirect had an invalid location." };
        }
        const redirectError = validateTarget(url);
        if (redirectError) return { status: 400, error: redirectError };
        continue;
      }

      if (!response.ok) {
        return { status: 502, error: `Upstream responded with HTTP ${response.status}.` };
      }
      const contentLength = parseContentLength(response);
      if (contentLength !== null && contentLength > MAX_PROXY_RESPONSE_BYTES) {
        return { status: 413, error: "Upstream response exceeds the proxy size limit." };
      }
      if (!response.body) return { status: 502, error: "Upstream response had no body." };
      responseStreamOwnsTimeout = true;
      return {
        status: 200,
        body: limitBody(response.body, abortController, () => clearTimeout(timeout)),
        contentType: response.headers.get("content-type") ?? "",
      };
    }
    return { status: 502, error: "Upstream exceeded the redirect limit." };
  } finally {
    if (!responseStreamOwnsTimeout) clearTimeout(timeout);
  }
}
