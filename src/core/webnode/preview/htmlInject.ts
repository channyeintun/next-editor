// Putting the preview's scripts into an HTML response: deciding whether a
// response can be rewritten, decoding its body (charset, gzip/deflate), and
// inserting the `<script>` tags at the top of the document, and letting those
// tags past the server's Content-Security-Policy with a per-response nonce.
import { headerValue, headerValues } from "./http1";
import type { HeaderList } from "./protocol";

/** The content codings the gateway can undo before injecting. */
const DECODABLE = new Set(["gzip", "x-gzip", "deflate"]);

/** The media type of a `content-type` value, lower case, without parameters. */
export function mediaType(contentType: string | null): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

/** The content codings applied to a body, in the order they were applied (`identity` dropped). */
export function contentCodings(headers: HeaderList): string[] {
  return headerValues(headers, "content-encoding")
    .flatMap((value) => value.split(","))
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== "" && coding !== "identity");
}

/** True when a response with `headers` is HTML the gateway can decode and inject into. */
export function isInjectableHtml(headers: HeaderList): boolean {
  if (mediaType(headerValue(headers, "content-type")) !== "text/html") {
    return false;
  }
  return contentCodings(headers).every((coding) => DECODABLE.has(coding));
}

async function decompress(bytes: Uint8Array, format: CompressionFormat): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decoderFor(contentType: string | null): TextDecoder {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? "")?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset);
    } catch {
      // An unknown label falls back to UTF-8, as a browser does.
    }
  }
  return new TextDecoder("utf-8");
}

/** Undoes the content codings of an injectable HTML body and decodes it to text. */
export async function decodeHtmlBody(body: Uint8Array, headers: HeaderList): Promise<string> {
  let bytes = body;
  for (const coding of contentCodings(headers).reverse()) {
    bytes = await decompress(bytes, coding === "deflate" ? "deflate" : "gzip");
  }
  return decoderFor(headerValue(headers, "content-type")).decode(bytes);
}

/** Makes `source` safe inside a `<script>` element: no `</script` can end it early. */
export function escapeScriptSource(source: string): string {
  return source.replace(/<\/(script)/gi, "<\\/$1");
}

/**
 * Inserts one `<script>` per non-empty source right after the opening `<head…>`
 * tag, else after `<html…>`, else after the doctype, else at the very start.
 * With `nonce`, each tag carries it (see `allowNonceInPolicy`).
 */
export function injectScripts(html: string, sources: string[], nonce?: string): string {
  const open = nonce ? `<script nonce="${nonce}">` : "<script>";
  const tags = sources
    .filter((source) => source !== "")
    .map((source) => `${open}${escapeScriptSource(source)}</script>`)
    .join("");
  if (tags === "") {
    return html;
  }
  for (const pattern of [/<head(?=[\s/>])[^>]*>/i, /<html(?=[\s/>])[^>]*>/i, /<!doctype[^>]*>/i]) {
    const match = pattern.exec(html);
    if (match) {
      const at = match.index + match[0].length;
      return html.slice(0, at) + tags + html.slice(at);
    }
  }
  return tags + html;
}

/** A fresh CSP nonce: 16 random bytes, base64. */
export function createNonce(): string {
  let binary = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** True for a source list that already allows every inline script. */
function allowsAnyInline(sources: string[]): boolean {
  const lower = sources.map((source) => source.toLowerCase());
  return (
    lower.includes("'unsafe-inline'") &&
    !lower.some(
      (source) =>
        source.startsWith("'nonce-") || source.startsWith("'sha") || source === "'strict-dynamic'",
    )
  );
}

/**
 * One serialized CSP (a header value may hold several, comma-separated) with
 * `'nonce-<nonce>'` added where it decides inline `<script>` elements:
 * `script-src-elem` and `script-src` when present, else `default-src`. A list
 * that already allows any inline script is left alone (a nonce would switch
 * its `'unsafe-inline'` off), and `'none'` is replaced by the nonce.
 */
export function allowNonceInPolicy(policy: string, nonce: string): string {
  const directives = policy.split(";").map((directive) => directive.trim().split(/\s+/));
  const names = directives.map((parts) => parts[0]?.toLowerCase() ?? "");
  const targets = names.some((name) => name === "script-src" || name === "script-src-elem")
    ? ["script-src", "script-src-elem"]
    : ["default-src"];
  const token = `'nonce-${nonce}'`;
  return directives
    .map((parts, index) => {
      if (!targets.includes(names[index])) {
        return parts.join(" ");
      }
      const sources = parts.slice(1).filter((source) => source.toLowerCase() !== "'none'");
      if (allowsAnyInline(sources)) {
        return parts.join(" ");
      }
      return [parts[0], ...sources, token].join(" ");
    })
    .filter((directive) => directive !== "")
    .join("; ");
}

/** True for a header that carries a CSP the browser enforces or reports on. */
export function isCspHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "content-security-policy" || lower === "content-security-policy-report-only";
}

/**
 * `headers` with every CSP header rewritten to allow `nonce`. A `<meta>` CSP
 * needs no change: it only governs what comes after it, and the scripts are
 * injected right after `<head>`.
 */
export function allowNonceInHeaders(headers: HeaderList, nonce: string): HeaderList {
  return headers.map(([name, value]) =>
    isCspHeader(name)
      ? [
          name,
          value
            .split(",")
            .map((policy) => allowNonceInPolicy(policy, nonce))
            .join(", "),
        ]
      : [name, value],
  );
}
