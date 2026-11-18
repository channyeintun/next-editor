// `curl`: GET/POST/any method with -s -S -L -o -O -H -X -d/--data(-raw,
// -binary, -urlencode, @file) --json -F -G -I -i -f -A -u -b -c -w, -m /
// --max-time, --connect-timeout and --retry (-delay, -max-time, -connrefused,
// -all-errors). Requests to localhost go to a port a webnode process listens
// on (HTTP/1.1 over the kernel's network); other hosts go through the
// browser's `fetch`, which hides Set-Cookie, so the cookie jar holds only
// local cookies.
import { errnoCodeOf } from "../../../../errors";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../../../kernel/vfs/types";
import { runtime } from "../../../runtime";
import type { ByteChannel } from "../../../runtime";
import type { Command, CommandContext } from "../context";
import { decode, encode } from "../io";
import { absolutePath, errorText } from "./util";

interface Request {
  method: string;
  url: URL;
  headers: [string, string][];
  body: Uint8Array | null;
}

interface Response {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: [string, string][];
  body: Uint8Array;
}

class CurlError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function indexOfSequence(haystack: Uint8Array, needle: number[], from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}

/** Decodes a `Transfer-Encoding: chunked` body. */
export function dechunk(body: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let pos = 0;
  for (;;) {
    const lineEnd = indexOfSequence(body, [13, 10], pos);
    if (lineEnd < 0) {
      break;
    }
    const size = parseInt(decode(body.subarray(pos, lineEnd)).split(";")[0].trim(), 16);
    if (!Number.isFinite(size) || size === 0) {
      break;
    }
    chunks.push(body.subarray(lineEnd + 2, lineEnd + 2 + size));
    pos = lineEnd + 2 + size + 2;
  }
  return concat(chunks);
}

/** Parses a raw HTTP/1.x response. */
export function parseHttpResponse(raw: Uint8Array, method: string): Response {
  const headerEnd = indexOfSequence(raw, [13, 10, 13, 10]);
  if (headerEnd < 0) {
    throw new CurlError(52, "Empty reply from server");
  }
  const lines = decode(raw.subarray(0, headerEnd)).split("\r\n");
  const statusLine = /^HTTP\/(\d(?:\.\d)?) (\d{3}) ?(.*)$/.exec(lines[0]);
  if (!statusLine) {
    throw new CurlError(8, "Weird server reply");
  }
  const headers: [string, string][] = [];
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers.push([line.slice(0, colon), line.slice(colon + 1).trim()]);
    }
  }
  let body = raw.subarray(headerEnd + 4);
  const header = (name: string): string | undefined =>
    headers.find(([key]) => key.toLowerCase() === name)?.[1];
  if (method === "HEAD") {
    body = new Uint8Array(0);
  } else if (header("transfer-encoding")?.toLowerCase().includes("chunked")) {
    body = dechunk(body);
  } else if (header("content-length") !== undefined) {
    body = body.subarray(0, Number(header("content-length")));
  }
  return {
    status: Number(statusLine[2]),
    statusText: statusLine[3],
    httpVersion: statusLine[1],
    headers,
    body,
  };
}

/** When the phases of one request ended (Date.now() milliseconds). */
interface Timing {
  start: number;
  connect: number;
  firstByte: number;
}

/** Waits for `promise`, failing with curl's timeout error after `ms` (if not null). */
function within<T>(promise: Promise<T>, ms: number | null, timeout: () => CurlError): Promise<T> {
  if (ms === null) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function localRequest(
  request: Request,
  signal: AbortSignal,
  timing: Timing,
  connectTimeout: number | null,
): Promise<Response> {
  const port = Number(request.url.port || (request.url.protocol === "https:" ? 443 : 80));
  const host = request.url.hostname;
  let channel: ByteChannel;
  const connecting = runtime().net.connect(port, host);
  try {
    channel = await within(
      connecting,
      connectTimeout,
      () =>
        new CurlError(
          28,
          `Failed to connect to ${host} port ${port} after ${Date.now() - timing.start} ms: Timeout was reached`,
        ),
    );
  } catch (error) {
    if (error instanceof CurlError) {
      // A connection that arrives after the timeout is closed at once.
      connecting.then(
        (late) => late.destroy(),
        () => {},
      );
      throw error;
    }
    throw new CurlError(7, `Failed to connect to ${host} port ${port}: Connection refused`);
  }
  timing.connect = Date.now();
  const headerLines = [
    `${request.method} ${request.url.pathname}${request.url.search} HTTP/1.1`,
    `Host: ${request.url.host}`,
  ];
  const names = new Set(request.headers.map(([name]) => name.toLowerCase()));
  for (const [name, value] of request.headers) {
    headerLines.push(`${name}: ${value}`);
  }
  if (!names.has("user-agent")) {
    headerLines.push("User-Agent: curl/8.5.0");
  }
  if (!names.has("accept")) {
    headerLines.push("Accept: */*");
  }
  if (request.body && !names.has("content-length")) {
    headerLines.push(`Content-Length: ${request.body.length}`);
  }
  headerLines.push("Connection: close");
  const head = encode(`${headerLines.join("\r\n")}\r\n\r\n`);
  const chunks: Uint8Array[] = [];
  const done = new Promise<void>((resolve) => {
    const finish = (): void => resolve();
    channel.onData = (chunk) => {
      if (chunks.length === 0) {
        timing.firstByte = Date.now();
      }
      chunks.push(chunk);
    };
    channel.onEnd = finish;
    channel.onClose = finish;
    signal.addEventListener("abort", finish);
  });
  channel.write(request.body ? concat([head, request.body]) : head);
  await done;
  channel.destroy();
  if (signal.aborted) {
    throw new CurlError(42, "Operation was aborted by an application callback");
  }
  return parseHttpResponse(concat(chunks), request.method);
}

async function remoteRequest(
  request: Request,
  follow: boolean,
  signal: AbortSignal,
  timing: Timing,
  connectTimeout: number | null,
): Promise<Response> {
  let response: globalThis.Response;
  try {
    // fetch shows no connection phase: the connect timeout covers the wait
    // for the response's headers.
    response = await within(
      fetch(request.url.href, {
        method: request.method,
        headers: request.headers,
        body:
          request.body && request.method !== "GET" && request.method !== "HEAD"
            ? (request.body as BodyInit)
            : undefined,
        redirect: follow ? "follow" : "manual",
        signal,
      }),
      connectTimeout,
      () =>
        new CurlError(
          28,
          `Failed to connect to ${request.url.hostname} port ${request.url.port || 443} after ${Date.now() - timing.start} ms: Timeout was reached`,
        ),
    );
  } catch (error) {
    if (error instanceof CurlError) {
      throw error;
    }
    if (signal.aborted) {
      throw new CurlError(42, "Operation was aborted by an application callback");
    }
    throw new CurlError(
      6,
      `Could not resolve host: ${request.url.hostname} (${(error as Error).message})`,
    );
  }
  timing.connect = timing.firstByte = Date.now();
  if (response.type === "opaqueredirect") {
    throw new CurlError(1, "redirect without -L: the browser hides the target; retry with -L");
  }
  const headers: [string, string][] = [];
  response.headers.forEach((value, name) => headers.push([name, value]));
  let body: Uint8Array;
  try {
    body = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new CurlError(42, "Operation was aborted by an application callback");
  }
  return {
    status: response.status,
    statusText: response.statusText,
    httpVersion: "1.1",
    headers,
    body,
  };
}

/** `--data-urlencode` content, as curl encodes it (spaces as `+`). */
function urlEncode(text: string): string {
  return encodeURIComponent(text)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/** A cookie the jar keeps, in Netscape cookie-file terms. */
interface Cookie {
  domain: string;
  path: string;
  secure: boolean;
  expires: number;
  name: string;
  value: string;
}

/** Reads `-b`: `name=value; …` text, or a Netscape cookie file. */
function readCookies(ctx: CommandContext, spec: string, host: string): Cookie[] {
  if (spec.includes("=")) {
    return spec
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.includes("="))
      .map((part) => ({
        domain: host,
        path: "/",
        secure: false,
        expires: 0,
        name: part.slice(0, part.indexOf("=")),
        value: part.slice(part.indexOf("=") + 1),
      }));
  }
  let text: string;
  try {
    text = decode(ctx.fs.readFile(absolutePath(ctx.cwd, spec)));
  } catch {
    // curl goes on without cookies when the file cannot be read.
    return [];
  }
  const cookies: Cookie[] = [];
  for (const line of text.split("\n")) {
    const fields = line.replace(/^#HttpOnly_/, "").split("\t");
    if (line.startsWith("#") && !line.startsWith("#HttpOnly_")) {
      continue;
    }
    if (fields.length === 7) {
      cookies.push({
        domain: fields[0],
        path: fields[2],
        secure: fields[3] === "TRUE",
        expires: Number(fields[4]) || 0,
        name: fields[5],
        value: fields[6].replace(/\r$/, ""),
      });
    }
  }
  return cookies;
}

/** Adds the response's Set-Cookie headers to the jar. */
function storeCookies(jar: Cookie[], response: Response, url: URL): void {
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== "set-cookie") {
      continue;
    }
    const [pair, ...attributes] = value.split(";").map((part) => part.trim());
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const cookie: Cookie = {
      domain: url.hostname,
      path: "/",
      secure: false,
      expires: 0,
      name: pair.slice(0, eq),
      value: pair.slice(eq + 1),
    };
    for (const attribute of attributes) {
      const [key, attributeValue = ""] = attribute.split("=");
      const lower = key.toLowerCase();
      if (lower === "path") {
        cookie.path = attributeValue || "/";
      } else if (lower === "secure") {
        cookie.secure = true;
      } else if (lower === "max-age") {
        cookie.expires = Math.floor(Date.now() / 1000) + Number(attributeValue);
      } else if (lower === "expires" && cookie.expires === 0) {
        cookie.expires = Math.floor(Date.parse(attributeValue) / 1000) || 0;
      }
    }
    const at = jar.findIndex((c) => c.name === cookie.name && c.path === cookie.path);
    if (at >= 0) {
      jar.splice(at, 1);
    }
    if (cookie.expires === 0 || cookie.expires * 1000 > Date.now()) {
      jar.push(cookie);
    }
  }
}

/** The jar as a Netscape cookie file (`-c`). */
function cookieFile(jar: Cookie[]): string {
  return `# Netscape HTTP Cookie File\n# https://curl.se/docs/http-cookies.html\n# This file was generated by libcurl! Edit at your own risk.\n\n${jar
    .map(
      (c) =>
        `${c.domain}\tFALSE\t${c.path}\t${c.secure ? "TRUE" : "FALSE"}\t${c.expires}\t${c.name}\t${c.value}\n`,
    )
    .join("")}`;
}

/** What `-w` can name about one transfer. */
interface TransferInfo {
  response: Response | null;
  url: URL | null;
  method: string;
  timing: Timing;
  end: number;
  redirects: number;
  redirectUrl: string;
  exitCode: number;
  error: string;
  uploaded: number;
}

/** Expands a `-w` template; an unknown variable is reported and left out, as curl does. */
function writeOutText(ctx: CommandContext, template: string, info: TransferInfo): string {
  const seconds = (ms: number): string => (Math.max(0, ms) / 1000).toFixed(6);
  const response = info.response;
  const headerSize = response
    ? encode(
        `HTTP/${response.httpVersion} ${response.status} ${response.statusText}\r\n${response.headers
          .map(([name, value]) => `${name}: ${value}\r\n`)
          .join("")}\r\n`,
      ).length
    : 0;
  const total = info.end - info.timing.start;
  const variables: Record<string, () => string> = {
    http_code: () => String(response?.status ?? 0).padStart(3, "0"),
    response_code: () => String(response?.status ?? 0).padStart(3, "0"),
    http_version: () => (response ? response.httpVersion : "0"),
    method: () => info.method,
    scheme: () => (response && info.url ? info.url.protocol.slice(0, -1).toUpperCase() : ""),
    url: () => info.url?.href ?? "",
    url_effective: () => info.url?.href ?? "",
    redirect_url: () => info.redirectUrl,
    num_redirects: () => String(info.redirects),
    content_type: () =>
      response?.headers.find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "",
    size_download: () => String(response?.body.length ?? 0),
    size_upload: () => String(info.uploaded),
    size_header: () => String(headerSize),
    speed_download: () =>
      String(total > 0 ? Math.round(((response?.body.length ?? 0) * 1000) / total) : 0),
    speed_upload: () => String(total > 0 ? Math.round((info.uploaded * 1000) / total) : 0),
    time_namelookup: () => seconds(0),
    time_connect: () => seconds(info.timing.connect ? info.timing.connect - info.timing.start : 0),
    time_appconnect: () => seconds(0),
    time_pretransfer: () =>
      seconds(info.timing.connect ? info.timing.connect - info.timing.start : 0),
    time_starttransfer: () =>
      seconds(info.timing.firstByte ? info.timing.firstByte - info.timing.start : 0),
    time_redirect: () => seconds(0),
    time_total: () => seconds(total),
    exitcode: () => String(info.exitCode),
    errormsg: () => info.error,
  };
  return template
    .replace(/\\([nrt\\])/g, (_, c: string) => ({ n: "\n", r: "\r", t: "\t", "\\": "\\" })[c] ?? c)
    .replace(/%%|%\{([a-z_]+)\}|%header\{([^}]*)\}/g, (whole, name?: string, header?: string) => {
      if (whole === "%%") {
        return "%";
      }
      if (header !== undefined) {
        return (
          response?.headers
            .filter(([key]) => key.toLowerCase() === header.toLowerCase())
            .map(([, value]) => value)
            .join(", ") ?? ""
        );
      }
      const variable = variables[name ?? ""];
      if (!variable) {
        ctx.io.err(`curl: unknown --write-out variable: '${name}'\n`);
        return "";
      }
      return variable();
    });
}

function writeOutput(ctx: CommandContext, path: string | null, data: Uint8Array): void {
  if (path === null || path === "-") {
    ctx.io.out(data);
    return;
  }
  ctx.fs.writeFile(absolutePath(ctx.cwd, path), data, O_WRONLY | O_CREAT | O_TRUNC, 0o666);
}

/** Sleeps `ms`, ending early when the shell is interrupted. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

/** HTTP statuses `--retry` treats as transient (curl's list). */
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** `curl`. */
export const curl: Command = async (ctx, args) => {
  let silent = false;
  let showError = false;
  let follow = false;
  let output: string | null = null;
  let remoteName = false;
  let method: string | null = null;
  let headOnly = false;
  let include = false;
  let failOnError = false;
  let writeOut: string | null = null;
  let get = false;
  let retries = 0;
  let retryDelay = 0;
  let retryMaxTime = 0;
  let retryConnRefused = false;
  let retryAllErrors = false;
  let maxTime: number | null = null;
  let connectTimeout: number | null = null;
  let cookieSpec: string | null = null;
  let cookieJar: string | null = null;
  const headers: [string, string][] = [];
  const data: string[] = [];
  const form: { spec: string; literal: boolean }[] = [];
  const urls: string[] = [];
  const valueOf = (i: number, name: string): string => {
    const value = args[i];
    if (value === undefined) {
      throw new CurlError(2, `option ${name}: requires parameter`);
    }
    return value;
  };
  /** A numeric option's value (seconds may have a fraction where curl allows it). */
  const numberOf = (value: string, name: string, fraction: boolean): number => {
    if (!(fraction ? /^\d+(\.\d+)?$|^\.\d+$/ : /^\d+$/).test(value)) {
      throw new CurlError(2, `option ${name}: expected a proper numerical parameter`);
    }
    return Number(value);
  };
  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith("--")) {
        const eq = arg.indexOf("=");
        const name = eq < 0 ? arg : arg.slice(0, eq);
        const inline = eq < 0 ? null : arg.slice(eq + 1);
        const take = (): string => inline ?? valueOf(++i, name);
        switch (name) {
          case "--silent":
            silent = true;
            break;
          case "--show-error":
            showError = true;
            break;
          case "--location":
            follow = true;
            break;
          case "--output":
            output = take();
            break;
          case "--remote-name":
            remoteName = true;
            break;
          case "--request":
            method = take().toUpperCase();
            break;
          case "--header":
            {
              const value = take();
              const colon = value.indexOf(":");
              if (colon > 0) {
                headers.push([value.slice(0, colon).trim(), value.slice(colon + 1).trim()]);
              }
            }
            break;
          case "--data":
          case "--data-raw":
          case "--data-binary":
          case "--data-ascii":
            data.push((name === "--data-raw" ? "\0raw:" : "") + take());
            break;
          case "--data-urlencode":
            data.push(`\0enc:${take()}`);
            break;
          case "--json":
            data.push(take());
            headers.push(["Content-Type", "application/json"], ["Accept", "application/json"]);
            break;
          case "--form":
          case "--form-string":
            form.push({ spec: take(), literal: name === "--form-string" });
            break;
          case "--get":
            get = true;
            break;
          case "--head":
            headOnly = true;
            break;
          case "--include":
            include = true;
            break;
          case "--fail":
            failOnError = true;
            break;
          case "--user-agent":
            headers.push(["User-Agent", take()]);
            break;
          case "--user":
            headers.push(["Authorization", `Basic ${btoa(take())}`]);
            break;
          case "--cookie":
            cookieSpec = take();
            break;
          case "--cookie-jar":
            cookieJar = take();
            break;
          case "--write-out":
            writeOut = take();
            break;
          case "--max-time":
            maxTime = numberOf(take(), name, true);
            break;
          case "--connect-timeout":
            connectTimeout = numberOf(take(), name, true);
            break;
          case "--retry":
            retries = numberOf(take(), name, false);
            break;
          case "--retry-delay":
            retryDelay = numberOf(take(), name, false);
            break;
          case "--retry-max-time":
            retryMaxTime = numberOf(take(), name, false);
            break;
          case "--retry-connrefused":
            retryConnRefused = true;
            break;
          case "--retry-all-errors":
            retryAllErrors = true;
            break;
          case "--compressed":
          case "--no-progress-meter":
          case "--progress-bar":
          case "--insecure":
            break;
          default:
            throw new CurlError(2, `option ${name}: is unknown or not supported`);
        }
        continue;
      }
      if (arg.startsWith("-") && arg.length > 1) {
        for (let j = 1; j < arg.length; j++) {
          const flag = arg[j];
          const rest = arg.slice(j + 1);
          const take = (): string => (rest !== "" ? rest : valueOf(++i, `-${flag}`));
          let consumed = false;
          switch (flag) {
            case "s":
              silent = true;
              break;
            case "S":
              showError = true;
              break;
            case "L":
              follow = true;
              break;
            case "O":
              remoteName = true;
              break;
            case "I":
              headOnly = true;
              break;
            case "i":
              include = true;
              break;
            case "f":
              failOnError = true;
              break;
            case "G":
              get = true;
              break;
            case "k":
            case "v":
            case "#":
              break;
            case "o":
              output = take();
              consumed = true;
              break;
            case "X":
              method = take().toUpperCase();
              consumed = true;
              break;
            case "H": {
              const value = take();
              const colon = value.indexOf(":");
              if (colon > 0) {
                headers.push([value.slice(0, colon).trim(), value.slice(colon + 1).trim()]);
              }
              consumed = true;
              break;
            }
            case "d":
              data.push(take());
              consumed = true;
              break;
            case "F":
              form.push({ spec: take(), literal: false });
              consumed = true;
              break;
            case "A":
              headers.push(["User-Agent", take()]);
              consumed = true;
              break;
            case "u":
              headers.push(["Authorization", `Basic ${btoa(take())}`]);
              consumed = true;
              break;
            case "b":
              cookieSpec = take();
              consumed = true;
              break;
            case "c":
              cookieJar = take();
              consumed = true;
              break;
            case "w":
              writeOut = take();
              consumed = true;
              break;
            case "m":
              maxTime = numberOf(take(), "-m", true);
              consumed = true;
              break;
            default:
              throw new CurlError(2, `option -${flag}: is unknown or not supported`);
          }
          if (consumed) {
            break;
          }
        }
        continue;
      }
      urls.push(arg);
    }
    if (urls.length === 0) {
      throw new CurlError(2, "no URL specified");
    }
    if (form.length > 0 && (data.length > 0 || get || headOnly)) {
      throw new CurlError(
        2,
        "You can only select one HTTP request method! You asked for both POST (-d / -F) and another.",
      );
    }
    // A standard input that is closed (`<&-`) gives no data.
    const readInput = async (file: string): Promise<Uint8Array> =>
      file === "-"
        ? ctx.io.readAll().catch((error: unknown) => {
            if (errnoCodeOf(error) !== "EBADF") {
              throw error;
            }
            return new Uint8Array(0);
          })
        : ctx.fs.readFile(absolutePath(ctx.cwd, file));
    let query: string | null = null;
    let body: Uint8Array | null = null;
    if (data.length > 0) {
      const parts: string[] = [];
      for (const item of data) {
        if (item.startsWith("\0raw:")) {
          parts.push(item.slice(5));
        } else if (item.startsWith("\0enc:")) {
          // content, =content, name=content, @file, name@file
          const spec = item.slice(5);
          const at = spec.search(/[=@]/);
          if (at < 0) {
            parts.push(urlEncode(spec));
          } else if (spec[at] === "=") {
            const name = spec.slice(0, at);
            parts.push(`${name === "" ? "" : `${name}=`}${urlEncode(spec.slice(at + 1))}`);
          } else {
            const name = spec.slice(0, at);
            const content = decode(await readInput(spec.slice(at + 1)));
            parts.push(`${name === "" ? "" : `${name}=`}${urlEncode(content)}`);
          }
        } else if (item.startsWith("@")) {
          parts.push(decode(await readInput(item.slice(1))));
        } else {
          parts.push(item);
        }
      }
      if (get) {
        // -G: the data goes into the URL's query of a GET.
        query = parts.join("&");
      } else {
        body = encode(parts.join("&"));
        if (!headers.some(([name]) => name.toLowerCase() === "content-type")) {
          headers.push(["Content-Type", "application/x-www-form-urlencoded"]);
        }
      }
    }
    if (form.length > 0) {
      const boundary = `------------------------${Array.from({ length: 16 }, () =>
        Math.floor(Math.random() * 16).toString(16),
      ).join("")}`;
      const pieces: Uint8Array[] = [];
      for (const { spec, literal } of form) {
        const eq = spec.indexOf("=");
        if (eq <= 0) {
          throw new CurlError(26, `Failed to read the form part '${spec}'`);
        }
        const name = spec.slice(0, eq);
        let value = spec.slice(eq + 1);
        let disposition = `form-data; name="${name}"`;
        let type: string | null = null;
        let content: Uint8Array;
        if (!literal && (value.startsWith("@") || value.startsWith("<"))) {
          const upload = value.startsWith("@");
          const [file, ...attributes] = value.slice(1).split(";");
          let filename = file.slice(file.lastIndexOf("/") + 1);
          for (const attribute of attributes) {
            const [key, attributeValue = ""] = attribute.split("=");
            if (key.trim() === "type") {
              type = attributeValue;
            } else if (key.trim() === "filename") {
              filename = attributeValue;
            }
          }
          try {
            content = await readInput(file);
          } catch {
            throw new CurlError(26, `Failed to open/read local data from file/application`);
          }
          if (upload) {
            disposition += `; filename="${filename}"`;
            type ??= "application/octet-stream";
          }
        } else {
          if (!literal) {
            const typeAt = value.indexOf(";type=");
            if (typeAt >= 0) {
              type = value.slice(typeAt + 6);
              value = value.slice(0, typeAt);
            }
          }
          content = encode(value);
        }
        pieces.push(
          encode(
            `--${boundary}\r\nContent-Disposition: ${disposition}\r\n${type ? `Content-Type: ${type}\r\n` : ""}\r\n`,
          ),
          content,
          encode("\r\n"),
        );
      }
      pieces.push(encode(`--${boundary}--\r\n`));
      body = concat(pieces);
      headers.push(["Content-Type", `multipart/form-data; boundary=${boundary}`]);
    }
    const effectiveMethod = method ?? (headOnly ? "HEAD" : body ? "POST" : "GET");
    const cookieEngine = cookieSpec !== null || cookieJar !== null;
    const jar: Cookie[] = [];
    let status = 0;
    try {
      for (const raw of urls) {
        let url: URL;
        try {
          url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
        } catch {
          throw new CurlError(3, `URL rejected: Malformed input to a URL function`);
        }
        if (query !== null) {
          url.search = url.search ? `${url.search}&${query}` : `?${query}`;
        }
        if (cookieSpec !== null && jar.length === 0) {
          jar.push(...readCookies(ctx, cookieSpec, url.hostname));
        }
        const info: TransferInfo = {
          response: null,
          url,
          method: effectiveMethod,
          timing: { start: Date.now(), connect: 0, firstByte: 0 },
          end: 0,
          redirects: 0,
          redirectUrl: "",
          exitCode: 0,
          error: "",
          uploaded: body?.length ?? 0,
        };
        /** One try of the transfer: the request and the redirects it follows. */
        const attempt = async (): Promise<Response> => {
          info.timing = { start: Date.now(), connect: 0, firstByte: 0 };
          info.redirects = 0;
          // -m bounds the whole try; Ctrl+C still ends it at once.
          const abort = new AbortController();
          const stop = (): void => abort.abort();
          ctx.signal.addEventListener("abort", stop);
          let timedOut = false;
          const timer =
            maxTime === null
              ? undefined
              : setTimeout(() => {
                  timedOut = true;
                  abort.abort();
                }, maxTime * 1000);
          const connectLimit =
            connectTimeout === null && maxTime === null
              ? null
              : Math.min(connectTimeout ?? Infinity, maxTime ?? Infinity) * 1000;
          let request: Request = { method: effectiveMethod, url, headers, body };
          try {
            for (let redirects = 0; ; redirects++) {
              const cookies =
                cookieEngine && !headers.some(([n]) => n.toLowerCase() === "cookie")
                  ? jar.map((c) => `${c.name}=${c.value}`).join("; ")
                  : "";
              const sent: Request = cookies
                ? { ...request, headers: [...request.headers, ["Cookie", cookies]] }
                : request;
              const local = LOCAL_HOSTS.has(request.url.hostname);
              const response = local
                ? await localRequest(sent, abort.signal, info.timing, connectLimit)
                : await remoteRequest(sent, follow, abort.signal, info.timing, connectLimit);
              info.response = response;
              info.url = request.url;
              if (cookieEngine) {
                storeCookies(jar, response, request.url);
              }
              const location = response.headers.find(
                ([name]) => name.toLowerCase() === "location",
              )?.[1];
              const redirect =
                location !== undefined && response.status >= 300 && response.status < 400;
              info.redirectUrl = redirect ? new URL(location, request.url).href : "";
              if (!local || !follow || !redirect || redirects > 20) {
                return response;
              }
              const keepMethod = response.status === 307 || response.status === 308;
              request = {
                method: keepMethod ? request.method : request.method === "HEAD" ? "HEAD" : "GET",
                url: new URL(location, request.url),
                headers,
                body: keepMethod ? request.body : null,
              };
              info.redirects = redirects + 1;
            }
          } catch (error) {
            if (timedOut && error instanceof CurlError && error.code === 42) {
              throw new CurlError(
                28,
                `Operation timed out after ${Date.now() - info.timing.start} milliseconds with 0 bytes received`,
              );
            }
            throw error;
          } finally {
            clearTimeout(timer);
            ctx.signal.removeEventListener("abort", stop);
            info.end = Date.now();
          }
        };
        // --retry: a timeout, a refused connection (with --retry-connrefused),
        // a transient HTTP status, or anything with --retry-all-errors is
        // tried again after a pause that doubles from 1 s (or --retry-delay).
        const started = Date.now();
        let delay = retryDelay > 0 ? retryDelay : 1;
        let left = retries;
        let response: Response | null = null;
        let failure: CurlError | null = null;
        for (;;) {
          response = null;
          failure = null;
          try {
            response = await attempt();
          } catch (error) {
            if (!(error instanceof CurlError)) {
              throw error;
            }
            failure = error;
          }
          const problem = failure
            ? failure.code === 28
              ? "timeout"
              : failure.code === 7 && retryConnRefused
                ? "connection refused"
                : retryAllErrors && failure.code !== 42
                  ? "(retrying all errors)"
                  : null
            : response && RETRY_STATUSES.has(response.status)
              ? "HTTP error"
              : response && retryAllErrors && failOnError && response.status >= 400
                ? "(retrying all errors)"
                : null;
          if (
            problem === null ||
            left === 0 ||
            ctx.signal.aborted ||
            (retryMaxTime > 0 && (Date.now() - started) / 1000 + delay > retryMaxTime)
          ) {
            break;
          }
          if (!silent) {
            ctx.io.err(
              `Warning: Problem : ${problem}. Will retry in ${delay} seconds. ${left} retries left.\n`,
            );
          }
          await pause(delay * 1000, ctx.signal);
          left--;
          if (retryDelay === 0) {
            delay = Math.min(delay * 2, 600);
          }
        }
        if (failure) {
          info.exitCode = failure.code;
          info.error = failure.message;
          if (writeOut !== null) {
            ctx.io.out(writeOutText(ctx, writeOut, info));
          }
          throw failure;
        }
        if (!response) {
          continue;
        }
        if (failOnError && response.status >= 400) {
          if (!silent || showError) {
            ctx.io.err(`curl: (22) The requested URL returned error: ${response.status}\n`);
          }
          status = 22;
          info.exitCode = 22;
          if (writeOut !== null) {
            ctx.io.out(writeOutText(ctx, writeOut, info));
          }
          continue;
        }
        let target = output;
        if (remoteName) {
          const name = url.pathname.split("/").pop() ?? "";
          if (name === "") {
            throw new CurlError(23, "Remote file name has no length");
          }
          target = name;
        }
        if (headOnly || include) {
          const head = `HTTP/${response.httpVersion} ${response.status}${response.statusText ? ` ${response.statusText}` : ""}\r\n${response.headers
            .map(([name, value]) => `${name}: ${value}\r\n`)
            .join("")}\r\n`;
          writeOutput(ctx, target, encode(head));
        }
        if (!headOnly) {
          if (include && target !== null && target !== "-") {
            const existing = ctx.fs.readFile(absolutePath(ctx.cwd, target));
            writeOutput(ctx, target, concat([existing, response.body]));
          } else {
            writeOutput(ctx, target, response.body);
          }
        }
        if (writeOut !== null) {
          ctx.io.out(writeOutText(ctx, writeOut, info));
        }
      }
    } finally {
      if (cookieJar !== null) {
        writeOutput(ctx, cookieJar, encode(cookieFile(jar)));
      }
    }
    return status;
  } catch (error) {
    if (error instanceof CurlError) {
      if (!silent || showError || error.code === 2) {
        ctx.io.err(`curl: (${error.code}) ${error.message}\n`);
      }
      return error.code;
    }
    if (!silent || showError) {
      ctx.io.err(`curl: (23) ${errorText(error)}\n`);
    }
    return 23;
  }
};
