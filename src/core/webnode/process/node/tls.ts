// The `tls` builtin. webnode never speaks TLS itself: the browser terminates
// TLS for `fetch` (https to other hosts) and the preview is already HTTPS.
// So `connect` and `createServer` throw an error naming themselves;
// `TLSSocket` exists (a `net.Socket` with `encrypted`) for `instanceof` checks;
// `checkServerIdentity` and `convertALPNProtocols` are real; the trust store
// (`rootCertificates`) is empty because no certificates ship with webnode.
import { Buffer } from "./buffer";
import { invalidArgType, makeNodeError, outOfRange } from "./internalErrors";
import { unsupported } from "./net/errors";
import { addressToBigInt, isIP } from "./net/ip";
import { Server as NetServer } from "./net/server";
import { Socket, type SocketOptions } from "./net/socket";

/** `tls.DEFAULT_CIPHERS`, Node 22's default cipher list. */
export const DEFAULT_CIPHERS =
  "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:" +
  "ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:" +
  "ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:" +
  "DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:" +
  "ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:" +
  "!PSK:!SRP:!CAMELLIA";
export const DEFAULT_ECDH_CURVE = "auto";
export const DEFAULT_MIN_VERSION = "TLSv1.2";
export const DEFAULT_MAX_VERSION = "TLSv1.3";
export const CLIENT_RENEG_LIMIT = 3;
export const CLIENT_RENEG_WINDOW = 600;

/** `tls.rootCertificates`: empty, since webnode ships no trust store (the browser holds it). */
export const rootCertificates: readonly string[] = Object.freeze([]);

/** `tls.getCiphers()`: empty, since webnode has no TLS implementation of its own. */
export function getCiphers(): string[] {
  return [];
}

/** `tls.SecureContext`: an opaque context; nothing in webnode consumes it. */
export class SecureContext {
  readonly context: object = {};
}

/** `tls.createSecureContext(options)`: an opaque `SecureContext`. */
export function createSecureContext(options?: object): SecureContext {
  if (options !== undefined && (typeof options !== "object" || options === null)) {
    throw invalidArgType("options", "Object", options);
  }
  return new SecureContext();
}

/** `tls.TLSSocket`: for `instanceof` only; wrapping a socket in TLS is not possible here. */
export class TLSSocket extends Socket {
  readonly encrypted = true;
  authorized = false;
  authorizationError: Error | null = null;
  alpnProtocol: string | false = false;
  servername: string | false = false;

  constructor(socket?: unknown, options?: SocketOptions) {
    if (socket !== undefined && socket !== null) {
      throw unsupported("new tls.TLSSocket(socket)", "webnode has no TLS implementation");
    }
    super(options);
  }

  /** No peer certificate exists without a TLS session. */
  getPeerCertificate(): null {
    return null;
  }

  getCipher(): null {
    return null;
  }

  getProtocol(): null {
    return null;
  }
}

/** `tls.Server`: cannot be created (no TLS implementation). */
export class Server extends NetServer {
  constructor() {
    super();
    throw unsupported("tls.Server", "webnode has no TLS implementation");
  }
}

/** `tls.connect`: throws; a raw TLS connection cannot be made from a browser. */
export function connect(..._args: unknown[]): never {
  throw unsupported("tls.connect", "raw TLS connections cannot be made from a browser");
}

/** `tls.createServer`: throws; webnode has no TLS implementation. */
export function createServer(..._args: unknown[]): never {
  throw unsupported("tls.createServer", "webnode has no TLS implementation");
}

/** `tls.convertALPNProtocols(protocols, out)`: the length-prefixed wire form. */
export function convertALPNProtocols(protocols: unknown, out: { ALPNProtocols?: unknown }): void {
  if (Array.isArray(protocols)) {
    const parts: Uint8Array[] = [];
    for (const protocol of protocols) {
      const bytes = Buffer.from(String(protocol));
      if (bytes.length > 255) {
        throw outOfRange(
          "The byte length of the protocol at index 0",
          "less than or equal to 255",
          bytes.length,
          true,
        );
      }
      parts.push(Buffer.from([bytes.length]), bytes);
    }
    out.ALPNProtocols = Buffer.concat(parts);
  } else if (protocols instanceof Uint8Array) {
    out.ALPNProtocols = Buffer.from(protocols);
  } else if (ArrayBuffer.isView(protocols)) {
    out.ALPNProtocols = Buffer.from(
      protocols.buffer.slice(protocols.byteOffset, protocols.byteOffset + protocols.byteLength),
    );
  }
}

function unfqdn(host: string): string {
  return host.replace(/[.]$/, "");
}

function splitHost(host: string): string[] {
  return unfqdn(host)
    .replace(/[A-Z]/g, (c) => String.fromCharCode(32 + c.charCodeAt(0)))
    .split(".");
}

function check(hostParts: string[], pattern: string, wildcards: boolean): boolean {
  if (!pattern) {
    return false;
  }
  const patternParts = splitHost(pattern);
  if (hostParts.length !== patternParts.length || patternParts.includes("")) {
    return false;
  }
  if (patternParts.some((part) => /[^!-\u007F]/u.test(part))) {
    return false;
  }
  for (let i = hostParts.length - 1; i > 0; i -= 1) {
    if (hostParts[i] !== patternParts[i]) {
      return false;
    }
  }
  const hostSubdomain = hostParts[0];
  const patternSubdomain = patternParts[0];
  const patternSubdomainParts = patternSubdomain.split("*", 3);
  if (patternSubdomainParts.length === 1 || patternSubdomain.includes("xn--")) {
    return hostSubdomain === patternSubdomain;
  }
  if (!wildcards || patternSubdomainParts.length > 2 || patternParts.length <= 2) {
    return false;
  }
  const [prefix, suffix] = patternSubdomainParts;
  if (prefix.length + suffix.length > hostSubdomain.length) {
    return false;
  }
  return hostSubdomain.startsWith(prefix) && hostSubdomain.endsWith(suffix);
}

function splitAltNames(altNames: string): string[] {
  if (!altNames.includes('"')) {
    return altNames.split(", ");
  }
  const result: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < altNames.length; i++) {
    const char = altNames[i];
    if (quoted) {
      if (char === "\\") {
        current += altNames[++i] ?? "";
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === "," && altNames[i + 1] === " ") {
      result.push(current);
      current = "";
      i++;
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

/** A certificate as `checkServerIdentity` reads it. */
export interface PeerCertificateLike {
  subject?: { CN?: string | string[] };
  subjectaltname?: string;
  [key: string]: unknown;
}

/**
 * `tls.checkServerIdentity(hostname, cert)`: undefined when the certificate's
 * names (or IP addresses) cover `hostname`, else `ERR_TLS_CERT_ALTNAME_INVALID`.
 */
export function checkServerIdentity(
  hostname: string,
  cert: PeerCertificateLike,
): Error | undefined {
  const subject = cert.subject;
  const altNames = cert.subjectaltname;
  const dnsNames: string[] = [];
  const ips: (bigint | null)[] = [];
  if (altNames) {
    for (const name of splitAltNames(altNames)) {
      if (name.startsWith("DNS:")) {
        dnsNames.push(name.slice(4));
      } else if (name.startsWith("IP Address:")) {
        ips.push(addressToBigInt(name.slice(11)));
      }
    }
  }
  let valid = false;
  let reason = "Unknown reason";
  const host = unfqdn(`${hostname}`);
  if (isIP(host)) {
    const value = addressToBigInt(host);
    valid = ips.some((ip) => ip !== null && ip === value);
    if (!valid) {
      const listed = altNames
        ? splitAltNames(altNames)
            .filter((name) => name.startsWith("IP Address:"))
            .map((name) => name.slice(11))
        : [];
      reason = `IP: ${host} is not in the cert's list: ${listed.join(", ")}`;
    }
  } else if (dnsNames.length > 0 || subject?.CN) {
    const hostParts = splitHost(host);
    const wildcard = (pattern: string) => check(hostParts, pattern, true);
    if (dnsNames.length > 0) {
      valid = dnsNames.some(wildcard);
      if (!valid) {
        reason = `Host: ${host}. is not in the cert's altnames: ${altNames}`;
      }
    } else {
      const cn = subject?.CN;
      if (Array.isArray(cn)) {
        valid = cn.some(wildcard);
      } else if (cn) {
        valid = wildcard(cn);
      }
      if (!valid) {
        reason = `Host: ${host}. is not cert's CN: ${String(cn)}`;
      }
    }
  } else {
    reason = "Cert does not contain a DNS name";
  }
  if (valid) {
    return undefined;
  }
  const error = makeNodeError(
    "ERR_TLS_CERT_ALTNAME_INVALID",
    `Hostname/IP does not match certificate's altnames: ${reason}`,
    Error,
  ) as Error & { reason: string; host: string; cert: PeerCertificateLike };
  error.reason = reason;
  error.host = host;
  error.cert = cert;
  return error;
}

/** What `require("tls")` returns. */
const tls = {
  CLIENT_RENEG_LIMIT,
  CLIENT_RENEG_WINDOW,
  DEFAULT_CIPHERS,
  DEFAULT_ECDH_CURVE,
  DEFAULT_MIN_VERSION,
  DEFAULT_MAX_VERSION,
  getCiphers,
  rootCertificates,
  convertALPNProtocols,
  checkServerIdentity,
  createSecureContext,
  SecureContext,
  TLSSocket,
  Server,
  createServer,
  connect,
};

export default tls;
