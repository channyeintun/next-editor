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

/** The last two labels of a hostname: what two hosts of one site have in common. */
function siteOf(hostname: string): string {
  return hostname.toLowerCase().split(".").slice(-2).join(".");
}

/**
 * Whether hosts under `baseHostname` are another site than the editor at
 * `editorHostname` (both without a port). The runtime's hosts run lesson code;
 * on the editor's own site that code could plant cookies for the editor's
 * domain (taking over or locking a visitor's session) and share a process
 * with the editor's page, which no header can undo. So a deployment gives them
 * a registrable domain of their own, as StackBlitz does with
 * webcontainer-api.io.
 *
 * Without the public suffix list this compares the last two labels, which is
 * exact for one-label suffixes (`.dev`, `.com`) and refuses, wrongly but
 * safely, two different domains under a two-label suffix (`a.co.uk`,
 * `b.co.uk`). Development is exempt: every `*.localhost` name is its own site.
 */
export function isSeparateSite(editorHostname: string, baseHostname: string): boolean {
  const base = baseHostname.toLowerCase();
  if (base === "localhost" || base.endsWith(".localhost")) {
    return true;
  }
  return siteOf(editorHostname) !== siteOf(base);
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
