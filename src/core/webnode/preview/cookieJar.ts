// The preview's cookies. A service worker cannot hand cookies to the browser
// (a synthesized Response drops `Set-Cookie`) or read them off a request (a
// FetchEvent's Request carries no `Cookie`), so the preview service worker
// keeps its own jar: `Set-Cookie` from each response goes in, and the matching
// cookies go out as `Cookie` on each forwarded request (RFC 6265 §5.3-5.4).
//
// The jar lives in the service worker's memory only. It does not survive the
// worker being stopped (browsers stop idle service workers after about 30 s),
// so a preview's session cookies last as long as the worker does. The page
// never sees these cookies (`document.cookie` is the browser's own jar), which
// keeps HttpOnly cookies out of the page's reach as they should be.

/** One stored cookie. */
interface StoredCookie {
  name: string;
  value: string;
  path: string;
  /** Epoch milliseconds, or null for a session cookie. */
  expires: number | null;
  httpOnly: boolean;
  created: number;
}

/** The parts of one `Set-Cookie` line the jar honours. */
export interface ParsedSetCookie {
  name: string;
  value: string;
  /** The `Path` attribute, when it is valid (starts with `/`). */
  path: string | null;
  /** From `Max-Age` (preferred) or `Expires`; null for a session cookie. */
  expires: number | null;
  /** The `Domain` attribute, lower case without a leading dot, or null. */
  domain: string | null;
  httpOnly: boolean;
}

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** Parses one `Set-Cookie` header value, or null when it is not a cookie. */
export function parseSetCookie(line: string, now: number): ParsedSetCookie | null {
  const [pair, ...attributes] = line.split(";");
  const equals = pair.indexOf("=");
  const name = (equals === -1 ? "" : pair.slice(0, equals)).trim();
  const value = (equals === -1 ? pair : pair.slice(equals + 1)).trim();
  if (equals === -1 || hasControlCharacter(name + value)) {
    return null;
  }
  const cookie: ParsedSetCookie = {
    name,
    value,
    path: null,
    expires: null,
    domain: null,
    httpOnly: false,
  };
  let maxAge: number | null = null;
  let expires: number | null = null;
  for (const attribute of attributes) {
    const at = attribute.indexOf("=");
    const key = (at === -1 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
    const raw = at === -1 ? "" : attribute.slice(at + 1).trim();
    if (key === "max-age" && /^-?\d+$/.test(raw)) {
      const seconds = Number(raw);
      maxAge = seconds <= 0 ? 0 : now + seconds * 1000;
    } else if (key === "expires") {
      const time = Date.parse(raw);
      if (!Number.isNaN(time)) {
        expires = time;
      }
    } else if (key === "path") {
      cookie.path = raw.startsWith("/") ? raw : null;
    } else if (key === "domain" && raw !== "") {
      cookie.domain = raw.replace(/^\./, "").toLowerCase();
    } else if (key === "httponly") {
      cookie.httpOnly = true;
    }
  }
  cookie.expires = maxAge ?? expires;
  return cookie;
}

/** The default cookie path for a request path (RFC 6265 §5.1.4). */
export function defaultCookiePath(requestPath: string): string {
  if (!requestPath.startsWith("/")) {
    return "/";
  }
  const slash = requestPath.lastIndexOf("/");
  return slash <= 0 ? "/" : requestPath.slice(0, slash);
}

/** True when `requestPath` path-matches `cookiePath` (RFC 6265 §5.1.4). */
export function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) {
    return true;
  }
  return (
    requestPath.startsWith(cookiePath) &&
    (cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/")
  );
}

/** An in-memory cookie jar for one origin's host. */
export class CookieJar {
  readonly #host: string;
  readonly #cookies = new Map<string, StoredCookie>();
  #counter = 0;

  /** `host` is the origin's hostname, lower case, without a port. */
  constructor(host: string) {
    this.#host = host.toLowerCase();
  }

  /** Stores (or deletes, when expired) the cookies of `Set-Cookie` lines from a response to `requestPath`. */
  store(lines: string[], requestPath: string, now = Date.now()): void {
    for (const line of lines) {
      const parsed = parseSetCookie(line, now);
      if (!parsed) {
        continue;
      }
      // A cookie for another domain is refused; one for this host's own domain
      // (or a parent of it) is kept as this host's: the jar serves one origin.
      if (
        parsed.domain !== null &&
        parsed.domain !== this.#host &&
        !this.#host.endsWith(`.${parsed.domain}`)
      ) {
        continue;
      }
      const path = parsed.path ?? defaultCookiePath(requestPath);
      const key = `${parsed.name}\0${path}`;
      const previous = this.#cookies.get(key);
      if (parsed.expires !== null && parsed.expires <= now) {
        this.#cookies.delete(key);
        continue;
      }
      this.#cookies.set(key, {
        name: parsed.name,
        value: parsed.value,
        path,
        expires: parsed.expires,
        httpOnly: parsed.httpOnly,
        created: previous?.created ?? this.#counter++,
      });
    }
  }

  /** The `Cookie` header value for a request to `requestPath`, or null when no cookie matches. */
  header(requestPath: string, now = Date.now()): string | null {
    const matching: StoredCookie[] = [];
    for (const [key, cookie] of this.#cookies) {
      if (cookie.expires !== null && cookie.expires <= now) {
        this.#cookies.delete(key);
        continue;
      }
      if (pathMatches(requestPath, cookie.path)) {
        matching.push(cookie);
      }
    }
    if (matching.length === 0) {
      return null;
    }
    // Longer paths first, then older cookies first (RFC 6265 §5.4).
    matching.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
    return matching
      .map((cookie) => (cookie.name === "" ? cookie.value : `${cookie.name}=${cookie.value}`))
      .join("; ");
  }
}
