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

/** The encoding a byte order mark at the start of `bytes` names, or null. */
function bomEncoding(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return "utf-16be";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return "utf-16le";
  }
  return null;
}

/**
 * The charset a `<meta charset>` or `<meta http-equiv="Content-Type">` in the
 * first 1024 bytes names, as a browser's prescan finds it, or null. ASCII is
 * enough to find it: every encoding a page may name there keeps ASCII as is.
 */
function metaCharset(bytes: Uint8Array): string | null {
  let head = "";
  for (const byte of bytes.subarray(0, 1024)) {
    head += String.fromCharCode(byte);
  }
  const charset = /<meta\b[^>]*?\bcharset\s*=\s*["']?\s*([^"'\s;/>]+)/i.exec(head)?.[1];
  if (!charset) {
    return null;
  }
  // A page that says it is UTF-16 in ASCII bytes is not: browsers read it as UTF-8.
  return /^utf-16/i.test(charset) ? "utf-8" : charset;
}

/** A decoder for `label`, or null when the label names no encoding. */
function decoderNamed(label: string | null | undefined): TextDecoder | null {
  if (!label) {
    return null;
  }
  try {
    return new TextDecoder(label);
  } catch {
    return null;
  }
}

/**
 * The decoder a browser would use for an HTML body: a byte order mark first,
 * then the Content-Type charset, then a `<meta>` in the document, else UTF-8.
 * An unknown label is passed over, as a browser does.
 */
function decoderFor(bytes: Uint8Array, contentType: string | null): TextDecoder {
  const headerCharset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? "")?.[1];
  return (
    decoderNamed(bomEncoding(bytes)) ??
    decoderNamed(headerCharset) ??
    decoderNamed(metaCharset(bytes)) ??
    new TextDecoder("utf-8")
  );
}

/** Undoes the content codings of an injectable HTML body and decodes it to text. */
export async function decodeHtmlBody(body: Uint8Array, headers: HeaderList): Promise<string> {
  let bytes = body;
  for (const coding of contentCodings(headers).reverse()) {
    bytes = await decompress(bytes, coding === "deflate" ? "deflate" : "gzip");
  }
  return decoderFor(bytes, headerValue(headers, "content-type")).decode(bytes);
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
