// `curl`: GET/POST/any method with -s -S -L -o -O -H -X -d/--data(-raw,
// -binary, @file) --json -I -i -f -A -u -w '%{http_code}'. Requests to
// localhost go to a port a webnode process listens on (HTTP/1.1 over the
// kernel's network); other hosts go through the browser's `fetch`.
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../../../kernel/vfs/types";
import { runtime } from "../../../runtime";
import type { ByteChannel } from "../../../runtime";
import type { Command, CommandContext } from "../context";
import { decode, encode } from "../io";
import { errorText } from "./util";

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

async function localRequest(request: Request, signal: AbortSignal): Promise<Response> {
  const port = Number(request.url.port || (request.url.protocol === "https:" ? 443 : 80));
  const host = request.url.hostname;
  let channel: ByteChannel;
  try {
    channel = await runtime().net.connect(port, host);
  } catch {
    throw new CurlError(7, `Failed to connect to ${host} port ${port}: Connection refused`);
  }
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
    channel.onData = (chunk) => chunks.push(chunk);
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
): Promise<Response> {
  let response: globalThis.Response;
  try {
    response = await fetch(request.url.href, {
      method: request.method,
      headers: request.headers,
      body:
        request.body && request.method !== "GET" && request.method !== "HEAD"
          ? (request.body as BodyInit)
          : undefined,
      redirect: follow ? "follow" : "manual",
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw new CurlError(42, "Operation was aborted by an application callback");
    }
    throw new CurlError(
      6,
      `Could not resolve host: ${request.url.hostname} (${(error as Error).message})`,
    );
  }
  if (response.type === "opaqueredirect") {
    throw new CurlError(1, "redirect without -L: the browser hides the target; retry with -L");
  }
  const headers: [string, string][] = [];
  response.headers.forEach((value, name) => headers.push([name, value]));
  const body = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    statusText: response.statusText,
    httpVersion: "1.1",
    headers,
    body,
  };
}

function writeOutput(ctx: CommandContext, path: string | null, data: Uint8Array): void {
  if (path === null || path === "-") {
    ctx.io.out(data);
    return;
  }
  runtime().fs.writeFile(ctx.resolve(path), data, O_WRONLY | O_CREAT | O_TRUNC, 0o666);
}

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
  const headers: [string, string][] = [];
  const data: string[] = [];
  const urls: string[] = [];
  const valueOf = (i: number, name: string): string => {
    const value = args[i];
    if (value === undefined) {
      throw new CurlError(2, `option ${name}: requires parameter`);
    }
    return value;
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
          case "--json":
            data.push(take());
            headers.push(["Content-Type", "application/json"], ["Accept", "application/json"]);
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
          case "--write-out":
            writeOut = take();
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
            case "A":
              headers.push(["User-Agent", take()]);
              consumed = true;
              break;
            case "u":
              headers.push(["Authorization", `Basic ${btoa(take())}`]);
              consumed = true;
              break;
            case "w":
              writeOut = take();
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
    let body: Uint8Array | null = null;
    if (data.length > 0) {
      const parts: string[] = [];
      for (const item of data) {
        if (item.startsWith("\0raw:")) {
          parts.push(item.slice(5));
        } else if (item.startsWith("@")) {
          const file = item.slice(1);
          parts.push(
            file === "-"
              ? decode(await ctx.io.readAll())
              : decode(runtime().fs.readFile(ctx.resolve(file))),
          );
        } else {
          parts.push(item);
        }
      }
      body = encode(parts.join("&"));
      if (!headers.some(([name]) => name.toLowerCase() === "content-type")) {
        headers.push(["Content-Type", "application/x-www-form-urlencoded"]);
      }
    }
    const effectiveMethod = method ?? (headOnly ? "HEAD" : body ? "POST" : "GET");
    let status = 0;
    for (const raw of urls) {
      let url: URL;
      try {
        url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
      } catch {
        throw new CurlError(3, `URL rejected: Malformed input to a URL function`);
      }
      let request: Request = { method: effectiveMethod, url, headers, body };
      let response: Response;
      for (let redirects = 0; ; redirects++) {
        const local = LOCAL_HOSTS.has(request.url.hostname);
        response = local
          ? await localRequest(request, ctx.signal)
          : await remoteRequest(request, follow, ctx.signal);
        const location = response.headers.find(([name]) => name.toLowerCase() === "location")?.[1];
        if (
          !local ||
          !follow ||
          !location ||
          response.status < 300 ||
          response.status >= 400 ||
          redirects > 20
        ) {
          break;
        }
        const keepMethod = response.status === 307 || response.status === 308;
        request = {
          method: keepMethod ? request.method : request.method === "HEAD" ? "HEAD" : "GET",
          url: new URL(location, request.url),
          headers,
          body: keepMethod ? request.body : null,
        };
      }
      if (failOnError && response.status >= 400) {
        if (!silent || showError) {
          ctx.io.err(`curl: (22) The requested URL returned error: ${response.status}\n`);
        }
        status = 22;
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
          const existing = runtime().fs.readFile(ctx.resolve(target));
          writeOutput(ctx, target, concat([existing, response.body]));
        } else {
          writeOutput(ctx, target, response.body);
        }
      }
      if (writeOut !== null) {
        ctx.io.out(
          writeOut.replace(/%\{http_code\}/g, String(response.status)).replace(/\\n/g, "\n"),
        );
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
