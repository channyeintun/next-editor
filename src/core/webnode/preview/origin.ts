// The preview origins: one per runtime session and server port, shaped
// `<sessionId>-<port>.<base host>` (dev: `http://k3j2h1-5173.localhost:5173`).
// Building them, recognising them, and minting session ids.

/** The origin every preview host hangs under. */
export interface PreviewBase {
  protocol: "http:" | "https:";
  /** `host[:port]`, as `URL.host` spells it. */
  host: string;
}

/** A recognised preview origin. */
export interface PreviewOrigin {
  sessionId: string;
  port: number;
}

const SESSION_ID = /^[a-z0-9]+$/;
const LABEL = /^([a-z0-9]+)-([1-9][0-9]{0,4})$/;
const SESSION_ID_LENGTH = 10;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function isPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** `base.host` as a URL normalises it (default port dropped, lower case). */
function normalizedHost(base: PreviewBase): string {
  return new URL(`${base.protocol}//${base.host}`).host;
}

/** The root URL (`…/`) of the preview of `port` in session `sessionId`. */
export function previewUrl(base: PreviewBase, sessionId: string, port: number): string {
  if (!SESSION_ID.test(sessionId)) {
    throw new TypeError(`webnode: invalid preview session id "${sessionId}"`);
  }
  if (!isPort(port)) {
    throw new RangeError(`webnode: invalid preview port ${port}`);
  }
  return `${base.protocol}//${sessionId}-${port}.${normalizedHost(base)}/`;
}

/** The session and port `origin` stands for, or null when it is not a preview origin under `base`. */
export function parsePreviewOrigin(origin: string, base: PreviewBase): PreviewOrigin | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== base.protocol || url.origin !== origin.replace(/\/$/, "")) {
    return null;
  }
  const suffix = `.${normalizedHost(base)}`;
  if (!url.host.endsWith(suffix)) {
    return null;
  }
  const match = LABEL.exec(url.host.slice(0, -suffix.length));
  if (!match) {
    return null;
  }
  const port = Number(match[2]);
  return isPort(port) ? { sessionId: match[1], port } : null;
}

/** The label of the host that runs the kernel and every process: `runtime.<base host>`. */
const RUNTIME_LABEL = "runtime";

/**
 * The origin every runtime's kernel and processes run on. It is not the
 * editor's, so the programs a lesson runs can reach none of the editor's
 * cookies, storage or API.
 */
export function runtimeOrigin(base: PreviewBase): string {
  return `${base.protocol}//${RUNTIME_LABEL}.${normalizedHost(base)}`;
}

/** Whether `hostname` (no port) is a preview or runtime host under `baseHostname`. */
export function isWebnodeHostname(hostname: string, baseHostname: string): boolean {
  const host = hostname.toLowerCase();
  const base = baseHostname.toLowerCase();
  if (!host.endsWith(`.${base}`)) {
    return false;
  }
  const label = host.slice(0, -base.length - 1);
  return label === RUNTIME_LABEL || LABEL.test(label);
}

/** A fresh random session id: lowercase letters and digits. */
export function createSessionId(): string {
  let id = "";
  while (id.length < SESSION_ID_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(SESSION_ID_LENGTH))) {
      // 252 = 7 × 36: rejecting the top 4 values keeps every character equally likely.
      if (byte < 252 && id.length < SESSION_ID_LENGTH) {
        id += ALPHABET[byte % 36];
      }
    }
  }
  return id;
}
