// The `url` builtin, ported from Node's lib/url.js and lib/internal/url.js
// (MIT): the legacy `Url` parser (parse/format/resolve/resolveObject), the
// WHATWG `URL`/`URLSearchParams` (the platform's own), `format` of a WHATWG
// URL, `fileURLToPath`/`pathToFileURL`, `domainToASCII`/`domainToUnicode`
// and `urlToHttpOptions`.
import punycode from "punycode/";
import { PLATFORM } from "../platform";
import {
  invalidArgType,
  invalidArgValue,
  kValidateObjectAllowArray,
  kValidateObjectAllowFunction,
  makeNodeError,
  missingArgs,
  validateObject,
  validateString,
} from "./internalErrors";
import { posix as posixPath, win32 as win32Path } from "./path";
import querystring, { encodeStr, hexTable, type ParsedUrlQuery } from "./querystring";

/** The WHATWG URL class (the platform's own, as `require("url").URL === URL`). */
export const URL = globalThis.URL;
/** The WHATWG URLSearchParams class. */
export const URLSearchParams = globalThis.URLSearchParams;

// Protocols that can allow "unsafe" and "unwise" chars.
const unsafeProtocol = new Set(["javascript", "javascript:"]);
// Protocols that never have a hostname.
const hostlessProtocol = new Set(["javascript", "javascript:"]);
// Protocols that always contain a // bit.
const slashedProtocol = new Set([
  "http",
  "http:",
  "https",
  "https:",
  "ftp",
  "ftp:",
  "gopher",
  "gopher:",
  "file",
  "file:",
  "ws",
  "ws:",
  "wss",
  "wss:",
]);

const CHAR_SPACE = 32;
const CHAR_TAB = 9;
const CHAR_CARRIAGE_RETURN = 13;
const CHAR_LINE_FEED = 10;
const CHAR_NO_BREAK_SPACE = 160;
const CHAR_ZERO_WIDTH_NOBREAK_SPACE = 65279;
const CHAR_HASH = 35;
const CHAR_FORWARD_SLASH = 47;
const CHAR_LEFT_SQUARE_BRACKET = 91;
const CHAR_RIGHT_SQUARE_BRACKET = 93;
const CHAR_LEFT_ANGLE_BRACKET = 60;
const CHAR_RIGHT_ANGLE_BRACKET = 62;
const CHAR_LEFT_CURLY_BRACKET = 123;
const CHAR_RIGHT_CURLY_BRACKET = 125;
const CHAR_QUESTION_MARK = 63;
const CHAR_DOUBLE_QUOTE = 34;
const CHAR_SINGLE_QUOTE = 39;
const CHAR_PERCENT = 37;
const CHAR_SEMICOLON = 59;
const CHAR_BACKWARD_SLASH = 92;
const CHAR_CIRCUMFLEX_ACCENT = 94;
const CHAR_GRAVE_ACCENT = 96;
const CHAR_VERTICAL_LINE = 124;
const CHAR_AT = 64;
const CHAR_COLON = 58;
const CHAR_LOWERCASE_A = 97;
const CHAR_LOWERCASE_Z = 122;

function invalidUrl(input: string): TypeError {
  const error = makeNodeError<TypeError & { input?: string }>(
    "ERR_INVALID_URL",
    "Invalid URL",
    TypeError,
  );
  error.input = input;
  return error;
}

/** A legacy URL object, as `url.parse` returns. */
export interface Url {
  protocol: string | null;
  slashes: boolean | null;
  auth: string | null;
  host: string | null;
  port: string | null;
  hostname: string | null;
  hash: string | null;
  search: string | null;
  query: string | ParsedUrlQuery | null;
  pathname: string | null;
  path: string | null;
  href: string | null;
  parse(url: string, parseQueryString?: boolean, slashesDenoteHost?: boolean): Url;
  format(): string;
  resolve(relative: string): string;
  resolveObject(relative: string | Url): Url;
  parseHost(): void;
}

/** The legacy `Url` constructor (callable with or without `new`, as in Node). */
export interface UrlConstructor {
  new (): Url;
  (this: Url): void;
  prototype: Url;
}

/** `url.Url`. */
const Url = function Url(this: Url) {
  this.protocol = null;
  this.slashes = null;
  this.auth = null;
  this.host = null;
  this.port = null;
  this.hostname = null;
  this.hash = null;
  this.search = null;
  this.query = null;
  this.pathname = null;
  this.path = null;
  this.href = null;
} as unknown as UrlConstructor;

// Reference: RFC 3986, RFC 1808, RFC 2396
const protocolPattern = /^[a-z0-9.+-]+:/i;
const portPattern = /:[0-9]*$/;
const hostPattern = /^\/\/[^@/]+@[^@/]+/;

// Special case for a simple path URL
const simplePathPattern = /^(\/\/?(?!\/)[^?\s]*)(\?[^\s]*)?$/;

const hostnameMaxLen = 255;

// The intersection of WHATWG's forbidden host code points and the host loop's
// characters, plus ':', '@', '[' and ']' (spoofing).
const forbiddenHostChars = /[\0\t\n\r #%/:<>?@[\\\]^|]/;
// For IPv6, permit '[', ']', and ':'.
const forbiddenHostCharsIpv6 = /[\0\t\n\r #%/<>?@\\^|]/;

/** `url.parse(urlString, parseQueryString, slashesDenoteHost)`. */
function urlParse(url: unknown, parseQueryString?: boolean, slashesDenoteHost?: boolean): Url {
  if (url instanceof Url) {
    return url;
  }
  const urlObject = new Url();
  urlObject.parse(url as string, parseQueryString, slashesDenoteHost);
  return urlObject;
}

function isIpv6Hostname(hostname: string): boolean {
  return (
    hostname.charCodeAt(0) === CHAR_LEFT_SQUARE_BRACKET &&
    hostname.charCodeAt(hostname.length - 1) === CHAR_RIGHT_SQUARE_BRACKET
  );
}

/**
 * IDNA ToASCII of a hostname the way Node's legacy parser does it: ASCII
 * labels pass through; anything else goes through the URL host parser, and a
 * failure gives "".
 */
function hostnameToASCII(hostname: string): string {
  // oxlint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(hostname) && !/(^|\.)xn--/i.test(hostname)) {
    return hostname;
  }
  return domainToASCII(hostname);
}

Url.prototype.parse = function parse(
  this: Url,
  url: string,
  parseQueryString?: boolean,
  slashesDenoteHost?: boolean,
): Url {
  validateString(url, "url");

  // Copy chrome, IE, opera backslash-handling behavior: backslashes before
  // the query string become forward slashes.
  let hasHash = false;
  let hasAt = false;
  let start = -1;
  let end = -1;
  let rest = "";
  let lastPos = 0;
  for (let i = 0, inWs = false, split = false; i < url.length; ++i) {
    const code = url.charCodeAt(i);

    // Find first and last non-whitespace characters for trimming
    const isWs =
      code < 33 || code === CHAR_NO_BREAK_SPACE || code === CHAR_ZERO_WIDTH_NOBREAK_SPACE;
    if (start === -1) {
      if (isWs) {
        continue;
      }
      lastPos = start = i;
    } else if (inWs) {
      if (!isWs) {
        end = -1;
        inWs = false;
      }
    } else if (isWs) {
      end = i;
      inWs = true;
    }

    // Only convert backslashes while we haven't seen a split character
    if (!split) {
      switch (code) {
        case CHAR_AT:
          hasAt = true;
          break;
        case CHAR_HASH:
          hasHash = true;
          split = true;
          break;
        case CHAR_QUESTION_MARK:
          split = true;
          break;
        case CHAR_BACKWARD_SLASH:
          if (i - lastPos > 0) {
            rest += url.slice(lastPos, i);
          }
          rest += "/";
          lastPos = i + 1;
          break;
        default:
          break;
      }
    } else if (!hasHash && code === CHAR_HASH) {
      hasHash = true;
    }
  }

  // Check if string was non-empty (including strings with only whitespace)
  if (start !== -1) {
    if (lastPos === start) {
      // We didn't convert any backslashes
      if (end === -1) {
        rest = start === 0 ? url : url.slice(start);
      } else {
        rest = url.slice(start, end);
      }
    } else if (end === -1 && lastPos < url.length) {
      // We converted some backslashes and have only part of the entire string
      rest += url.slice(lastPos);
    } else if (end !== -1 && lastPos < end) {
      // We converted some backslashes and have only part of the entire string
      rest += url.slice(lastPos, end);
    }
  }

  if (!slashesDenoteHost && !hasHash && !hasAt) {
    // Try fast path regexp
    const simplePath = simplePathPattern.exec(rest);
    if (simplePath) {
      this.path = rest;
      this.href = rest;
      this.pathname = simplePath[1];
      if (simplePath[2]) {
        this.search = simplePath[2];
        if (parseQueryString) {
          this.query = querystring.parse(this.search.slice(1));
        } else {
          this.query = this.search.slice(1);
        }
      } else if (parseQueryString) {
        this.search = null;
        this.query = Object.create(null) as ParsedUrlQuery;
      }
      return this;
    }
  }

  const protoMatch = protocolPattern.exec(rest);
  let proto: string | undefined;
  let lowerProto: string | undefined;
  if (protoMatch) {
    proto = protoMatch[0];
    lowerProto = proto.toLowerCase();
    this.protocol = lowerProto;
    rest = rest.slice(proto.length);
  }

  // Figure out if it's got a host. user@server is *always* a hostname, and
  // //foo/bar resolves as host=foo, path=bar, as browsers do.
  let slashes: boolean | undefined;
  if (slashesDenoteHost || proto || hostPattern.test(rest)) {
    slashes =
      rest.charCodeAt(0) === CHAR_FORWARD_SLASH && rest.charCodeAt(1) === CHAR_FORWARD_SLASH;
    if (slashes && !(proto && hostlessProtocol.has(lowerProto as string))) {
      rest = rest.slice(2);
      this.slashes = true;
    }
  }

  if (
    !hostlessProtocol.has(lowerProto as string) &&
    (slashes || (proto && !slashedProtocol.has(proto)))
  ) {
    // There's a hostname: the first /, ?, ; or # ends it. Left of the last
    // '@', non-host characters are allowed unless a host-ending character
    // comes first:
    //   http://a@b@c/ => user:a@b host:c
    //   http://a@b?@c => user:a host:b path:/?@c
    let hostEnd = -1;
    let atSign = -1;
    let nonHost = -1;
    for (let i = 0; i < rest.length; ++i) {
      switch (rest.charCodeAt(i)) {
        case CHAR_TAB:
        case CHAR_LINE_FEED:
        case CHAR_CARRIAGE_RETURN:
          // WHATWG URL removes tabs, newlines, and carriage returns. Let's do that too.
          rest = rest.slice(0, i) + rest.slice(i + 1);
          i -= 1;
          break;
        case CHAR_SPACE:
        case CHAR_DOUBLE_QUOTE:
        case CHAR_PERCENT:
        case CHAR_SINGLE_QUOTE:
        case CHAR_SEMICOLON:
        case CHAR_LEFT_ANGLE_BRACKET:
        case CHAR_RIGHT_ANGLE_BRACKET:
        case CHAR_BACKWARD_SLASH:
        case CHAR_CIRCUMFLEX_ACCENT:
        case CHAR_GRAVE_ACCENT:
        case CHAR_LEFT_CURLY_BRACKET:
        case CHAR_VERTICAL_LINE:
        case CHAR_RIGHT_CURLY_BRACKET:
          // Characters that are never ever allowed in a hostname from RFC 2396
          if (nonHost === -1) {
            nonHost = i;
          }
          break;
        case CHAR_HASH:
        case CHAR_FORWARD_SLASH:
        case CHAR_QUESTION_MARK:
          // Find the first instance of any host-ending characters
          if (nonHost === -1) {
            nonHost = i;
          }
          hostEnd = i;
          break;
        case CHAR_AT:
          // Either an explicit point the auth cannot go past was found, or
          // the last '@' decides.
          atSign = i;
          nonHost = -1;
          break;
        default:
          break;
      }
      if (hostEnd !== -1) {
        break;
      }
    }
    start = 0;
    if (atSign !== -1) {
      this.auth = decodeURIComponent(rest.slice(0, atSign));
      start = atSign + 1;
    }
    if (nonHost === -1) {
      this.host = rest.slice(start);
      rest = "";
    } else {
      this.host = rest.slice(start, nonHost);
      rest = rest.slice(nonHost);
    }

    // pull out port.
    this.parseHost();

    // There is a hostname, so even an empty one is present.
    if (typeof this.hostname !== "string") {
      this.hostname = "";
    }

    const hostname: string = this.hostname;

    // If hostname begins with [ and ends with ], assume it's an IPv6 address.
    const ipv6Hostname = isIpv6Hostname(hostname);

    // validate a little.
    if (!ipv6Hostname) {
      rest = getHostname(this, rest, hostname, url);
    }

    if ((this.hostname as string).length > hostnameMaxLen) {
      this.hostname = "";
    } else {
      // Hostnames are always lower case.
      this.hostname = (this.hostname as string).toLowerCase();
    }

    if (this.hostname !== "") {
      if (ipv6Hostname) {
        if (forbiddenHostCharsIpv6.test(this.hostname)) {
          throw invalidUrl(url);
        }
      } else {
        // IDNA: punycode the labels with non-ASCII characters.
        this.hostname = hostnameToASCII(this.hostname);

        // An empty hostname now, or a forbidden character, can only come
        // from toASCII: refuse rather than repair (spoofing).
        if (this.hostname === "" || forbiddenHostChars.test(this.hostname)) {
          throw invalidUrl(url);
        }
      }
    }

    const p = this.port ? ":" + this.port : "";
    const h = this.hostname || "";
    this.host = h + p;

    // Strip [ and ] from the hostname; the host field still retains them.
    if (ipv6Hostname) {
      this.hostname = this.hostname.slice(1, -1);
      if (rest[0] !== "/") {
        rest = "/" + rest;
      }
    }
  }

  // Now rest is set to the post-host stuff. Escape the "autoEscape"
  // characters, even where encodeURIComponent would not.
  if (!unsafeProtocol.has(lowerProto as string)) {
    rest = autoEscapeStr(rest);
  }

  let questionIdx = -1;
  let hashIdx = -1;
  for (let i = 0; i < rest.length; ++i) {
    const code = rest.charCodeAt(i);
    if (code === CHAR_HASH) {
      this.hash = rest.slice(i);
      hashIdx = i;
      break;
    } else if (code === CHAR_QUESTION_MARK && questionIdx === -1) {
      questionIdx = i;
    }
  }

  if (questionIdx !== -1) {
    if (hashIdx === -1) {
      this.search = rest.slice(questionIdx);
      this.query = rest.slice(questionIdx + 1);
    } else {
      this.search = rest.slice(questionIdx, hashIdx);
      this.query = rest.slice(questionIdx + 1, hashIdx);
    }
    if (parseQueryString) {
      this.query = querystring.parse(this.query);
    }
  } else if (parseQueryString) {
    // No query string, but parseQueryString still requested
    this.search = null;
    this.query = Object.create(null) as ParsedUrlQuery;
  }

  const useQuestionIdx = questionIdx !== -1 && (hashIdx === -1 || questionIdx < hashIdx);
  const firstIdx = useQuestionIdx ? questionIdx : hashIdx;
  if (firstIdx === -1) {
    if (rest.length > 0) {
      this.pathname = rest;
    }
  } else if (firstIdx > 0) {
    this.pathname = rest.slice(0, firstIdx);
  }
  if (slashedProtocol.has(lowerProto as string) && this.hostname && !this.pathname) {
    this.pathname = "/";
  }

  // To support http.request
  if (this.pathname || this.search) {
    const p = this.pathname || "";
    const s = this.search || "";
    this.path = p + s;
  }

  // Finally, reconstruct the href based on what has been validated.
  this.href = this.format();
  return this;
};

let warnInvalidPort = true;

function emitDeprecation(message: string, code: string): void {
  const process = (
    globalThis as {
      process?: { emitWarning?: (message: string, type: string, code: string) => void };
    }
  ).process;
  if (typeof process?.emitWarning === "function") {
    process.emitWarning(message, "DeprecationWarning", code);
  }
}

function getHostname(self: Url, rest: string, hostname: string, url: string): string {
  for (let i = 0; i < hostname.length; ++i) {
    const code = hostname.charCodeAt(i);
    const isValid =
      code !== CHAR_FORWARD_SLASH &&
      code !== CHAR_BACKWARD_SLASH &&
      code !== CHAR_HASH &&
      code !== CHAR_QUESTION_MARK &&
      code !== CHAR_COLON;

    if (!isValid) {
      // A leftover starting with ':' is an invalid port. Node 22 is lenient
      // about it: it warns once (DEP0170) and moves it into the path.
      if (warnInvalidPort && code === CHAR_COLON) {
        warnInvalidPort = false;
        emitDeprecation(
          `The URL ${url} is invalid. Future versions of Node.js will throw an error.`,
          "DEP0170",
        );
      }
      self.hostname = hostname.slice(0, i);
      return `/${hostname.slice(i)}${rest}`;
    }
  }
  return rest;
}

// Escaped characters; empty strings fill the unused entries.
// prettier-ignore
const escapedCodes = [
  /* 0 - 9 */ "", "", "", "", "", "", "", "", "", "%09",
  /* 10 - 19 */ "%0A", "", "", "%0D", "", "", "", "", "", "",
  /* 20 - 29 */ "", "", "", "", "", "", "", "", "", "",
  /* 30 - 39 */ "", "", "%20", "", "%22", "", "", "", "", "%27",
  /* 40 - 49 */ "", "", "", "", "", "", "", "", "", "",
  /* 50 - 59 */ "", "", "", "", "", "", "", "", "", "",
  /* 60 - 69 */ "%3C", "", "%3E", "", "", "", "", "", "", "",
  /* 70 - 79 */ "", "", "", "", "", "", "", "", "", "",
  /* 80 - 89 */ "", "", "", "", "", "", "", "", "", "",
  /* 90 - 99 */ "", "", "%5C", "", "%5E", "", "%60", "", "", "",
  /* 100 - 109 */ "", "", "", "", "", "", "", "", "", "",
  /* 110 - 119 */ "", "", "", "", "", "", "", "", "", "",
  /* 120 - 125 */ "", "", "", "%7B", "%7C", "%7D",
];

// Escapes RFC 2396's delimiters and unwise characters, and single quotes
// (XSS).
function autoEscapeStr(rest: string): string {
  let escaped = "";
  let lastEscapedPos = 0;
  for (let i = 0; i < rest.length; ++i) {
    // `escaped` holds the string up to the last escaped character.
    const escapedChar = escapedCodes[rest.charCodeAt(i)];
    if (escapedChar) {
      // Concat if there are ordinary characters in the middle.
      if (i > lastEscapedPos) {
        escaped += rest.slice(lastEscapedPos, i);
      }
      escaped += escapedChar;
      lastEscapedPos = i + 1;
    }
  }
  if (lastEscapedPos === 0) {
    // Nothing has been escaped.
    return rest;
  }
  // There are ordinary characters at the end.
  if (lastEscapedPos < rest.length) {
    escaped += rest.slice(lastEscapedPos);
  }
  return escaped;
}

/** `url.format` options for a WHATWG URL. */
export interface URLFormatOptions {
  auth?: boolean;
  fragment?: boolean;
  search?: boolean;
  unicode?: boolean;
}

/** `url.format(urlObject | string | URL, options)`. */
function urlFormat(urlObject: unknown, options?: URLFormatOptions): string {
  // A string is parsed first, so url.format() cleans up wonky URLs.
  let legacy: unknown = urlObject;
  if (typeof urlObject === "string") {
    legacy = urlParse(urlObject);
  } else if (typeof urlObject !== "object" || urlObject === null) {
    throw invalidArgType("urlObject", ["Object", "string"], urlObject);
  } else if (urlObject instanceof URL) {
    let fragment = true;
    let unicode = false;
    let search = true;
    let auth = true;

    if (options) {
      validateObject(options, "options");
      if (options.fragment != null) {
        fragment = Boolean(options.fragment);
      }
      if (options.unicode != null) {
        unicode = Boolean(options.unicode);
      }
      if (options.search != null) {
        search = Boolean(options.search);
      }
      if (options.auth != null) {
        auth = Boolean(options.auth);
      }
    }
    return formatWhatwg(urlObject.href, fragment, unicode, search, auth);
  }
  return Url.prototype.format.call(legacy as Url);
}

/** The WHATWG serializer with parts left out, as Node's `url.format(URL, options)`. */
function formatWhatwg(
  href: string,
  fragment: boolean,
  unicode: boolean,
  search: boolean,
  auth: boolean,
): string {
  const out = new URL(href);
  if (!fragment) {
    out.hash = "";
  }
  if (!search) {
    out.search = "";
  }
  if (!auth) {
    out.username = "";
    out.password = "";
  }
  let result = out.href;
  if (unicode && out.hostname !== "") {
    const credentials = out.username
      ? `${out.username}${out.password ? `:${out.password}` : ""}@`
      : out.password
        ? `:${out.password}@`
        : "";
    const prefix = `${out.protocol}//${credentials}`;
    if (result.startsWith(prefix + out.hostname)) {
      result =
        prefix + domainToUnicode(out.hostname) + result.slice(prefix.length + out.hostname.length);
    }
  }
  return result;
}

// Characters that need no escaping in `auth`:
// ! - . _ ~ ' ( ) * : digits alpha
// prettier-ignore
const noEscapeAuth = new Int8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0x00 - 0x0F
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0x10 - 0x1F
  0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, // 0x20 - 0x2F
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, // 0x30 - 0x3F
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 0x40 - 0x4F
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, // 0x50 - 0x5F
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 0x60 - 0x6F
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0, // 0x70 - 0x7F
]);

Url.prototype.format = function format(this: Url): string {
  let auth = this.auth || "";
  if (auth) {
    auth = encodeStr(auth, noEscapeAuth, hexTable);
    auth += "@";
  }

  let protocol = this.protocol || "";
  if (protocol && protocol.charCodeAt(protocol.length - 1) !== CHAR_COLON) {
    protocol += ":";
  }

  let pathname = this.pathname || "";
  let hash = this.hash || "";
  let host = "";
  let query = "";

  if (this.host) {
    host = auth + this.host;
  } else if (this.hostname) {
    host =
      auth +
      (this.hostname.includes(":") && !isIpv6Hostname(this.hostname)
        ? "[" + this.hostname + "]"
        : this.hostname);
    if (this.port) {
      host += ":" + this.port;
    }
  }

  if (this.query !== null && typeof this.query === "object") {
    query = querystring.stringify(this.query);
  }
  let search = this.search || (query && "?" + query) || "";

  if (pathname.includes("#") || pathname.includes("?")) {
    let newPathname = "";
    let lastPos = 0;
    const len = pathname.length;
    for (let i = 0; i < len; i++) {
      const code = pathname.charCodeAt(i);
      if (code === CHAR_HASH || code === CHAR_QUESTION_MARK) {
        if (i > lastPos) {
          newPathname += pathname.slice(lastPos, i);
        }
        newPathname += code === CHAR_HASH ? "%23" : "%3F";
        lastPos = i + 1;
      }
    }
    if (lastPos < len) {
      newPathname += pathname.slice(lastPos);
    }
    pathname = newPathname;
  }

  // Only the slashedProtocols get the //. Not mailto:, xmpp:, etc. unless
  // they had them to begin with.
  if (this.slashes || slashedProtocol.has(protocol)) {
    if (this.slashes || host) {
      if (pathname && pathname.charCodeAt(0) !== CHAR_FORWARD_SLASH) {
        pathname = "/" + pathname;
      }
      host = "//" + host;
    } else if (protocol.length >= 4 && protocol.startsWith("file")) {
      host = "//";
    }
  }

  // Escape '#' in search.
  if (search.includes("#")) {
    search = search.replaceAll("#", "%23");
  }

  if (hash && hash.charCodeAt(0) !== CHAR_HASH) {
    hash = "#" + hash;
  }
  if (search && search.charCodeAt(0) !== CHAR_QUESTION_MARK) {
    search = "?" + search;
  }

  return protocol + host + pathname + search + hash;
};

/** `url.resolve(from, to)`. */
function urlResolve(source: string, relative: string): string {
  return urlParse(source, false, true).resolve(relative);
}

Url.prototype.resolve = function resolve(this: Url, relative: string): string {
  return this.resolveObject(urlParse(relative, false, true)).format();
};

/** `url.resolveObject(from, to)`. */
function urlResolveObject(source: string, relative: string | Url): string | Url {
  if (!source) {
    return relative;
  }
  return urlParse(source, false, true).resolveObject(relative);
}

type UrlRecord = Url & Record<string, unknown>;

Url.prototype.resolveObject = function resolveObject(this: Url, relativeArg: string | Url): Url {
  let relative: Url;
  if (typeof relativeArg === "string") {
    const rel = new Url();
    rel.parse(relativeArg, false, true);
    relative = rel;
  } else {
    relative = relativeArg;
  }

  const result = new Url();
  Object.assign(result, this);

  // Hash is always overridden, no matter what; even href="" removes it.
  result.hash = relative.hash;

  // If the relative url is empty, then there's nothing left to do here.
  if (relative.href === "") {
    result.href = result.format();
    return result;
  }

  // Hrefs like //foo/bar always cut to the protocol.
  if (relative.slashes && !relative.protocol) {
    // Take everything except the protocol from relative
    const relativeWithoutProtocol: Record<string, unknown> = {};
    for (const key of Object.keys(relative)) {
      if (key !== "protocol") {
        relativeWithoutProtocol[key] = (relative as UrlRecord)[key];
      }
    }
    Object.assign(result, relativeWithoutProtocol);

    // urlParse appends trailing / to urls like http://www.example.com
    if (slashedProtocol.has(result.protocol as string) && result.hostname && !result.pathname) {
      result.path = result.pathname = "/";
    }

    result.href = result.format();
    return result;
  }

  if (relative.protocol && relative.protocol !== result.protocol) {
    // Changing to a known protocol: unless it is file:, there must be a host
    // (and a path, if there was one). file: drops the host. Anything else is
    // taken as absolute.
    if (!slashedProtocol.has(relative.protocol)) {
      Object.assign(result, relative);
      result.href = result.format();
      return result;
    }

    result.protocol = relative.protocol;
    if (
      !relative.host &&
      !/^file:?$/.test(relative.protocol) &&
      !hostlessProtocol.has(relative.protocol)
    ) {
      const relPath = (relative.pathname || "").split("/");
      while (relPath.length && !(relative.host = relPath.shift() as string));
      relative.host ||= "";
      relative.hostname ||= "";
      if (relPath[0] !== "") {
        relPath.unshift("");
      }
      if (relPath.length < 2) {
        relPath.unshift("");
      }
      result.pathname = relPath.join("/");
    } else {
      result.pathname = relative.pathname;
    }
    result.search = relative.search;
    result.query = relative.query;
    result.host = relative.host || "";
    result.auth = relative.auth;
    result.hostname = relative.hostname || relative.host;
    result.port = relative.port;
    // To support http.request
    if (result.pathname || result.search) {
      const p = result.pathname || "";
      const s = result.search || "";
      result.path = p + s;
    }
    result.slashes ||= relative.slashes;
    result.href = result.format();
    return result;
  }

  const isSourceAbs = result.pathname && result.pathname.charAt(0) === "/";
  const isRelAbs = relative.host || (relative.pathname && relative.pathname.charAt(0) === "/");
  let mustEndAbs: unknown = isRelAbs || isSourceAbs || (result.host && relative.pathname);
  const removeAllDots = mustEndAbs;
  let srcPath: (string | undefined)[] = (result.pathname && result.pathname.split("/")) || [];
  const relPath: (string | undefined)[] = (relative.pathname && relative.pathname.split("/")) || [];
  const noLeadingSlashes = result.protocol && !slashedProtocol.has(result.protocol);

  // In a non-slashed url, relative links like ../.. can crawl up to the
  // hostname too (strange). The first path part goes into host later.
  if (noLeadingSlashes) {
    result.hostname = "";
    result.port = null;
    if (result.host) {
      if (srcPath[0] === "") {
        srcPath[0] = result.host;
      } else {
        srcPath.unshift(result.host);
      }
    }
    result.host = "";
    if (relative.protocol) {
      relative.hostname = null;
      relative.port = null;
      result.auth = null;
      if (relative.host) {
        if (relPath[0] === "") {
          relPath[0] = relative.host;
        } else {
          relPath.unshift(relative.host);
        }
      }
      relative.host = null;
    }
    mustEndAbs &&= relPath[0] === "" || srcPath[0] === "";
  }

  if (isRelAbs) {
    // it's absolute.
    if (relative.host || relative.host === "") {
      if (result.host !== relative.host) {
        result.auth = null;
      }
      result.host = relative.host;
      result.port = relative.port;
    }
    if (relative.hostname || relative.hostname === "") {
      if (result.hostname !== relative.hostname) {
        result.auth = null;
      }
      result.hostname = relative.hostname;
    }
    result.search = relative.search;
    result.query = relative.query;
    srcPath = relPath;
    // Fall through to the dot-handling below.
  } else if (relPath.length) {
    // It's relative: drop the current file, take the new path.
    srcPath ||= [];
    srcPath.pop();
    srcPath = srcPath.concat(relPath);
    result.search = relative.search;
    result.query = relative.query;
  } else if (relative.search !== null && relative.search !== undefined) {
    // Just pull out the search, like href='?foo'.
    if (noLeadingSlashes) {
      result.hostname = result.host = srcPath.shift() as string;
      // The auth can get stuck in host, as in
      // url.resolveObject('mailto:local1@domain1', 'local2@domain2')
      const authInHost = result.host && result.host.indexOf("@") > 0 && result.host.split("@");
      if (authInHost) {
        result.auth = authInHost.shift() as string;
        result.host = result.hostname = authInHost.shift() as string;
      }
    }
    result.search = relative.search;
    result.query = relative.query;
    // To support http.request
    if (result.pathname !== null || result.search !== null) {
      result.path = (result.pathname ? result.pathname : "") + (result.search ? result.search : "");
    }
    result.href = result.format();
    return result;
  }

  if (!srcPath.length) {
    // No path at all. All other things were already handled above.
    result.pathname = null;
    // To support http.request
    if (result.search) {
      result.path = "/" + result.search;
    } else {
      result.path = null;
    }
    result.href = result.format();
    return result;
  }

  // A url ending in . or .. gets a trailing slash; ending in anything else
  // non-slashy, it must not.
  let last = srcPath[srcPath.length - 1];
  const hasTrailingSlash =
    ((result.host || relative.host || srcPath.length > 1) && (last === "." || last === "..")) ||
    last === "";

  // Strip single dots and resolve double dots; going above the root leaves
  // `up` > 0.
  let up = 0;
  for (let i = srcPath.length - 1; i >= 0; i--) {
    last = srcPath[i];
    if (last === ".") {
      srcPath.splice(i, 1);
    } else if (last === "..") {
      srcPath.splice(i, 1);
      up++;
    } else if (up) {
      srcPath.splice(i, 1);
      up--;
    }
  }

  // If the path is allowed to go above the root, restore leading ..s
  if (!mustEndAbs && !removeAllDots) {
    while (up--) {
      srcPath.unshift("..");
    }
  }

  if (mustEndAbs && srcPath[0] !== "" && (!srcPath[0] || srcPath[0].charAt(0) !== "/")) {
    srcPath.unshift("");
  }

  if (hasTrailingSlash && srcPath.join("/").at(-1) !== "/") {
    srcPath.push("");
  }

  const isAbsolute = srcPath[0] === "" || (srcPath[0] && srcPath[0].charAt(0) === "/");

  // put the host back
  if (noLeadingSlashes) {
    result.hostname = result.host = isAbsolute
      ? ""
      : srcPath.length
        ? (srcPath.shift() as string)
        : "";
    // The auth can get stuck in host, as in
    // url.resolveObject('mailto:local1@domain1', 'local2@domain2')
    const authInHost = result.host && result.host.indexOf("@") > 0 ? result.host.split("@") : false;
    if (authInHost) {
      result.auth = authInHost.shift() as string;
      result.host = result.hostname = authInHost.shift() as string;
    }
  }

  mustEndAbs ||= result.host && srcPath.length;

  if (mustEndAbs && !isAbsolute) {
    srcPath.unshift("");
  }

  if (!srcPath.length) {
    result.pathname = null;
    result.path = null;
  } else {
    result.pathname = srcPath.join("/");
  }

  // To support request.http
  if (result.pathname !== null || result.search !== null) {
    result.path = (result.pathname ? result.pathname : "") + (result.search ? result.search : "");
  }
  result.auth = relative.auth || result.auth;
  result.slashes ||= relative.slashes;
  result.href = result.format();
  return result;
};

Url.prototype.parseHost = function parseHost(this: Url): void {
  let host = this.host as string;
  const portMatch = portPattern.exec(host);
  if (portMatch) {
    const port = portMatch[0];
    if (port !== ":") {
      this.port = port.slice(1);
    }
    host = host.slice(0, host.length - port.length);
  }
  if (host) {
    this.hostname = host;
  }
};

/**
 * The value the URL host setter leaves for `domain` on a special URL, or ""
 * when the setter rejects it (Node: ada's `set_hostname` on `ws://x`).
 */
function hostSetterResult(domain: string): string {
  const first = new URL("ws://a");
  first.hostname = domain;
  const second = new URL("ws://b");
  second.hostname = domain;
  // A rejected value leaves each URL's own host in place.
  return first.hostname === second.hostname ? first.hostname : "";
}

/** `url.domainToASCII(domain)`: the punycoded host, or "" when invalid. */
export function domainToASCII(domain: string): string {
  if (arguments.length < 1) {
    throw missingArgs("domain");
  }
  const input = `${domain}`;
  if (input === "") {
    return "";
  }
  return hostSetterResult(input);
}

/** `url.domainToUnicode(domain)`: the Unicode host, or "" when invalid. */
export function domainToUnicode(domain: string): string {
  if (arguments.length < 1) {
    throw missingArgs("domain");
  }
  const input = `${domain}`;
  if (input === "") {
    return "";
  }
  const ascii = hostSetterResult(input);
  if (ascii === "") {
    return "";
  }
  return punycode.toUnicode(ascii);
}

/** The options object `http.request` takes, from a WHATWG URL. */
export interface HttpOptions {
  protocol: string;
  hostname: string;
  hash: string;
  search: string;
  pathname: string;
  path: string;
  href: string;
  port?: number;
  auth?: string;
  [key: string]: unknown;
}

/** `url.urlToHttpOptions(url)`. */
export function urlToHttpOptions(url: URL): HttpOptions {
  validateObject(url, "url", kValidateObjectAllowArray | kValidateObjectAllowFunction);
  const { hostname, pathname, port, username, password, search } = url;
  const options: HttpOptions = Object.assign(Object.create(null) as object, {
    ...url, // In case the url object was extended by the user.
    protocol: url.protocol,
    hostname: hostname && hostname[0] === "[" ? hostname.slice(1, -1) : hostname,
    hash: url.hash,
    search,
    pathname,
    path: `${pathname || ""}${search || ""}`,
    href: url.href,
  }) as unknown as HttpOptions;
  if (port !== "") {
    options.port = Number(port);
  }
  if (username || password) {
    options.auth = `${decodeURIComponent(username)}:${decodeURIComponent(password)}`;
  }
  return options;
}

/** A WHATWG URL, told apart from a legacy one by its missing `auth`/`path`. */
function isURL(self: unknown): self is URL {
  const candidate = self as Record<string, unknown> | null | undefined;
  return Boolean(
    candidate?.href &&
    candidate.protocol &&
    candidate.auth === undefined &&
    candidate.path === undefined,
  );
}

function invalidFileUrlPath(reason: string, input: unknown): TypeError {
  const error = makeNodeError<TypeError & { input?: unknown }>(
    "ERR_INVALID_FILE_URL_PATH",
    `File URL path ${reason}`,
    TypeError,
  );
  error.input = input;
  return error;
}

function getPathFromURLWin32(url: URL): string {
  const hostname = url.hostname;
  let pathname = url.pathname;
  for (let n = 0; n < pathname.length; n++) {
    if (pathname[n] === "%") {
      const third = (pathname.codePointAt(n + 2) as number) | 0x20;
      if (
        (pathname[n + 1] === "2" && third === 102) || // 2f 2F /
        (pathname[n + 1] === "5" && third === 99) // 5c 5C \
      ) {
        throw invalidFileUrlPath("must not include encoded \\ or / characters", url);
      }
    }
  }
  pathname = pathname.replace(/\//g, "\\");
  if (pathname.includes("%")) {
    pathname = decodeURIComponent(pathname);
  }
  if (hostname !== "") {
    // A hostname makes it a UNC path; decode an IDN (`xn--`) host.
    return `\\\\${domainToUnicode(hostname)}${pathname}`;
  }
  // Otherwise, it's a local path that requires a drive letter
  const letter = (pathname.codePointAt(1) as number) | 0x20;
  const sep = pathname.charAt(2);
  if (letter < CHAR_LOWERCASE_A || letter > CHAR_LOWERCASE_Z || sep !== ":") {
    throw invalidFileUrlPath("must be absolute", url);
  }
  return pathname.slice(1);
}

function getPathFromURLPosix(url: URL): string {
  if (url.hostname !== "") {
    throw makeNodeError<TypeError>(
      "ERR_INVALID_FILE_URL_HOST",
      `File URL host must be "localhost" or empty on ${PLATFORM}`,
      TypeError,
    );
  }
  const pathname = url.pathname;
  for (let n = 0; n < pathname.length; n++) {
    if (pathname[n] === "%") {
      const third = (pathname.codePointAt(n + 2) as number) | 0x20;
      if (pathname[n + 1] === "2" && third === 102) {
        throw invalidFileUrlPath("must not include encoded / characters", url);
      }
    }
  }
  return pathname.includes("%") ? decodeURIComponent(pathname) : pathname;
}

/** `url.fileURLToPath(url, { windows })`: posix semantics unless `windows` is set. */
export function fileURLToPath(path: string | URL, options?: { windows?: boolean }): string {
  const windows = options?.windows;
  let url: URL;
  if (typeof path === "string") {
    url = new URL(path);
  } else if (!isURL(path)) {
    throw invalidArgType("path", ["string", "URL"], path);
  } else {
    url = path;
  }
  if (url.protocol !== "file:") {
    throw makeNodeError<TypeError>(
      "ERR_INVALID_URL_SCHEME",
      "The URL must be of scheme file",
      TypeError,
    );
  }
  return windows ? getPathFromURLWin32(url) : getPathFromURLPosix(url);
}

// `pathToFileURL` percent-encodes what the pathname setter would not keep:
// '%' (the only character it does not encode), '\\' on posix (it turns it
// into '/'), and newline, CR and tab (it strips them).
function encodePathChars(filepath: string, windows: boolean): string {
  if (filepath.includes("%")) {
    filepath = filepath.replace(/%/g, "%25");
  }
  // In posix, backslash is a valid character in paths:
  if (!windows && filepath.includes("\\")) {
    filepath = filepath.replace(/\\/g, "%5C");
  }
  if (filepath.includes("\n")) {
    filepath = filepath.replace(/\n/g, "%0A");
  }
  if (filepath.includes("\r")) {
    filepath = filepath.replace(/\r/g, "%0D");
  }
  if (filepath.includes("\t")) {
    filepath = filepath.replace(/\t/g, "%09");
  }
  return filepath;
}

/**
 * `url.pathToFileURL(path, { windows })`: resolves `path` against the working
 * directory and percent-encodes it into a `file:` URL.
 */
export function pathToFileURL(filepath: string, options?: { windows?: boolean }): URL {
  validateString(filepath, "path");
  const windows = options?.windows ?? false;
  if (windows && filepath.startsWith("\\\\")) {
    // UNC path format: \\server\share\resource
    const outURL = new URL("file://");
    const hostnameEndIndex = filepath.indexOf("\\", 2);
    if (hostnameEndIndex === -1) {
      throw invalidArgValue("path", filepath, "Missing UNC resource path");
    }
    if (hostnameEndIndex === 2) {
      throw invalidArgValue("path", filepath, "Empty UNC servername");
    }
    const hostname = filepath.slice(2, hostnameEndIndex);
    outURL.hostname = domainToASCII(hostname);
    outURL.pathname = encodePathChars(filepath.slice(hostnameEndIndex).replace(/\\/g, "/"), true);
    return outURL;
  }
  let resolved = windows ? win32Path.resolve(filepath) : posixPath.resolve(filepath);
  // path.resolve strips trailing slashes so we must add them back
  const filePathLast = filepath.charCodeAt(filepath.length - 1);
  if (
    (filePathLast === CHAR_FORWARD_SLASH || (windows && filePathLast === CHAR_BACKWARD_SLASH)) &&
    resolved[resolved.length - 1] !== posixPath.sep
  ) {
    resolved += "/";
  }

  // Encode first, so the '%' of the escapes below is not encoded again.
  resolved = encodePathChars(resolved, windows);

  // '?' and '#' belong to the pathname: encode them so they are not parsed
  // as the query or fragment.
  if (resolved.includes("?")) {
    resolved = resolved.replace(/\?/g, "%3F");
  }
  if (resolved.includes("#")) {
    resolved = resolved.replace(/#/g, "%23");
  }
  return new URL(`file://${resolved}`);
}

/** What `require("url")` returns. */
const url = {
  // Original API
  Url,
  parse: urlParse,
  resolve: urlResolve,
  resolveObject: urlResolveObject,
  format: urlFormat,

  // WHATWG API
  URL,
  URLSearchParams,
  domainToASCII,
  domainToUnicode,

  // Utilities
  pathToFileURL,
  fileURLToPath,
  urlToHttpOptions,
};

export {
  Url,
  urlParse as parse,
  urlResolve as resolve,
  urlResolveObject as resolveObject,
  urlFormat as format,
};

export default url;
