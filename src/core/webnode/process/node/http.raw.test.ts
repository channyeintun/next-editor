// @vitest-environment node
// The bytes our `http` server writes, compared with real `node:http` running
// the same handler on the same hand-made request (modulo the `Date` value).
import realHttp from "node:http";
import realNet from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import { Buffer } from "./buffer";
import http from "./http";

type Handler = (req: { method?: string | null; url?: string }, res: ResponseLike) => void;

/** The part of a response both implementations share. */
interface ResponseLike {
  statusCode: number;
  statusMessage?: string;
  sendDate: boolean;
  setHeader(name: string, value: string | number | readonly string[]): unknown;
  removeHeader(name: string): void;
  writeHead(code: number, ...rest: unknown[]): unknown;
  write(chunk: string): boolean;
  end(chunk?: string): unknown;
  addTrailers(headers: Record<string, string>): void;
  flushHeaders(): void;
  writeContinue(): void;
}

let fake: FakeRuntime;

beforeEach(() => {
  fake = createFakeRuntime();
  setRuntime(fake);
});

afterEach(() => {
  http.globalAgent.destroy();
  setRuntime(null);
});

function normalize(text: string): string {
  return text.replace(/Date: [^\r]*\r\n/g, "Date: <date>\r\n");
}

/** Collects bytes until the peer ends, or until nothing arrives for 40 ms. */
function collector(): { push(chunk: Uint8Array): void; end(): void; done: Promise<string> } {
  let text = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolve!: (value: string) => void;
  const done = new Promise<string>((r) => {
    resolve = r;
  });
  const settle = () => {
    if (timer) {
      clearTimeout(timer);
    }
    resolve(text);
  };
  return {
    push(chunk) {
      text += Buffer.from(chunk).toString("latin1");
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(settle, 40);
    },
    end: settle,
    done,
  };
}

async function viaNode(handler: Handler, request: string): Promise<string> {
  const server = realHttp.createServer((req, res) => handler(req, res as unknown as ResponseLike));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const sink = collector();
  const socket = realNet.connect(port, "127.0.0.1", () => socket.write(request));
  socket.on("data", (chunk: Uint8Array) => sink.push(chunk));
  socket.on("end", () => sink.end());
  socket.on("error", () => sink.end());
  const text = await sink.done;
  socket.destroy();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  return normalize(text);
}

async function viaWebnode(handler: Handler, request: string): Promise<string> {
  const server = http.createServer((req, res) => handler(req, res as unknown as ResponseLike));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const sink = collector();
  const channel = await fake.net.connect(port, "127.0.0.1");
  channel.onData = (chunk) => sink.push(chunk);
  channel.onEnd = () => sink.end();
  channel.onClose = () => sink.end();
  channel.write(Buffer.from(request, "latin1"));
  const text = await sink.done;
  channel.destroy();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  return normalize(text);
}

const CASES: Array<[string, Handler, string]> = [
  [
    "end with a body",
    (_req, res) => res.end("hello"),
    "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
  ],
  ["keep-alive by default", (_req, res) => res.end("hello"), "GET / HTTP/1.1\r\nHost: x\r\n\r\n"],
  [
    // Ended a turn later: Node 26 (the test runner) also merges same-turn
    // chunks, which Node 22's write path does not.
    "writeHead with an object, then write and end (chunked)",
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("a");
      setTimeout(() => res.end("b"), 5);
    },
    "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
  ],
  [
    "setHeader arrays, raw writeHead array and a status message",
    (_req, res) => {
      res.setHeader("Set-Cookie", ["a=1", "b=2"]);
      res.setHeader("X-Number", 42);
      res.writeHead(202, "Fine", ["X-Raw", "1", "x-raw", "2"]);
      res.end();
    },
    "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
  ],
  [
    "HEAD keeps the length but not the body",
    (_req, res) => res.end("body!"),
    "HEAD / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
  ],
  [
    "304 with a body attempt",
    (_req, res) => {
      res.writeHead(304);
      res.end("nope");
    },
    "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
  ],
  [
    "HTTP/1.0 without keep-alive",
    (_req, res) => {
      res.write("x");
      res.end("y");
    },
    "GET / HTTP/1.0\r\n\r\n",
  ],
  [
    "HTTP/1.0 with keep-alive and a length",
    (_req, res) => res.end("abc"),
    "GET / HTTP/1.0\r\nConnection: keep-alive\r\n\r\n",
  ],
  [
    "no Date header",
    (_req, res) => {
      res.sendDate = false;
      res.setHeader("Content-Length", "2");
      res.end("ok");
    },
    "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
  ],
  [
    "trailers",
    (_req, res) => {
      res.setHeader("Trailer", "X-Sum");
      res.write("data");
      res.addTrailers({ "X-Sum": "9" });
      res.end();
    },
    "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
  ],
  [
    "flushHeaders before the body",
    (_req, res) => {
      res.flushHeaders();
      res.end("late");
    },
    "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
  ],
  [
    "Expect: 100-continue",
    (_req, res) => res.end("continued"),
    "POST / HTTP/1.1\r\nHost: x\r\nExpect: 100-continue\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi",
  ],
  [
    "a body the handler never reads",
    (_req, res) => res.end("ignored body"),
    "POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
  ],
  ["a malformed request", (_req, res) => res.end("never"), "THIS IS NOT HTTP\r\n\r\n"],
  ["a missing Host header", (_req, res) => res.end("never"), "GET / HTTP/1.1\r\n\r\n"],
  [
    "two pipelined requests",
    (req, res) => res.end(req.url ?? ""),
    "GET /one HTTP/1.1\r\nHost: x\r\n\r\nGET /two HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
  ],
];

describe("response bytes match node:http", () => {
  it.each(CASES)("%s", async (_name, handler, request) => {
    const expected = await viaNode(handler, request);
    const actual = await viaWebnode(handler, request);
    expect(actual).toBe(expected);
  });
});
