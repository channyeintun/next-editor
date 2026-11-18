// @vitest-environment node
// The `http` builtin: a client and a server of ours over the fake runtime's
// loopback network, plus raw HTTP/1.1 written straight onto a connection.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntime, type ByteChannel } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import { Buffer } from "./buffer";
import http, {
  Agent,
  ClientRequest,
  IncomingMessage,
  OutgoingMessage,
  ServerResponse,
  type Server,
} from "./http";
import net, { type Socket } from "./net";

let fake: FakeRuntime;

beforeEach(() => {
  fake = createFakeRuntime();
  setRuntime(fake);
});

afterEach(() => {
  // Pooled keep-alive sockets belong to this test's fake network.
  http.globalAgent.destroy();
  setRuntime(null);
});

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function listen(server: Server, ...args: unknown[]): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(...args, () => resolve((server.address() as { port: number }).port));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

function readBody(stream: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    stream.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
    stream.on("error", reject);
  });
}

interface Fetched {
  res: IncomingMessage;
  body: string;
  req: ClientRequest;
}

function fetchOnce(
  options: Parameters<typeof http.request>[0],
  body?: string | Uint8Array,
): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      readBody(res).then((text) => resolve({ res, body: text, req }), reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** A raw connection to `port`: write bytes, read everything the server sends. */
async function rawConnection(port: number): Promise<{
  channel: ByteChannel;
  text(): string;
  ended: Promise<string>;
  until(pattern: RegExp | string): Promise<string>;
}> {
  const channel = await fake.net.connect(port, "127.0.0.1");
  let received = "";
  const waiters: (() => void)[] = [];
  let resolveEnded!: (value: string) => void;
  const ended = new Promise<string>((resolve) => {
    resolveEnded = resolve;
  });
  channel.onData = (chunk) => {
    received += Buffer.from(chunk).toString("latin1");
    for (const waiter of waiters.splice(0)) {
      waiter();
    }
  };
  channel.onEnd = () => resolveEnded(received);
  channel.onClose = () => resolveEnded(received);
  return {
    channel,
    text: () => received,
    ended,
    until(pattern) {
      return new Promise((resolve) => {
        const check = () => {
          const matched =
            typeof pattern === "string" ? received.includes(pattern) : pattern.test(received);
          if (matched) {
            resolve(received);
          } else {
            waiters.push(check);
          }
        };
        check();
      });
    },
  };
}

function withoutDate(text: string): string {
  return text.replace(/Date: [^\r]*\r\n/g, "Date: <date>\r\n");
}

describe("http module surface", () => {
  it("has Node 22's exports and tables", () => {
    expect(Object.keys(http).sort()).toEqual(
      [
        "_connectionListener",
        "METHODS",
        "STATUS_CODES",
        "Agent",
        "ClientRequest",
        "IncomingMessage",
        "OutgoingMessage",
        "Server",
        "ServerResponse",
        "createServer",
        "isValidHeaderName",
        "isValidHeaderValue",
        "validateHeaderName",
        "validateHeaderValue",
        "get",
        "request",
        "setMaxIdleHTTPParsers",
        "maxHeaderSize",
        "globalAgent",
        "WebSocket",
        "CloseEvent",
        "MessageEvent",
      ].sort(),
    );
    expect(http.METHODS).toContain("QUERY");
    expect(http.STATUS_CODES[418]).toBe("I'm a Teapot");
    expect(http.maxHeaderSize).toBe(16384);
    expect(http.globalAgent).toBeInstanceOf(Agent);
    expect(http.globalAgent.keepAlive).toBe(true);
    expect(http.WebSocket).toBe(globalThis.WebSocket);
    expect(Object.getPrototypeOf(ServerResponse.prototype)).toBe(OutgoingMessage.prototype);
    expect(() => http.validateHeaderName("bad name")).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_HTTP_TOKEN" }),
    );
    expect(() => http.validateHeaderValue("x", "a\nb")).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_CHAR" }),
    );
    expect(() => http.validateHeaderValue("x", undefined)).toThrow(
      expect.objectContaining({ code: "ERR_HTTP_INVALID_HEADER_VALUE" }),
    );
    expect(http.isValidHeaderName("X-Ok")).toBe(true);
    expect(http.isValidHeaderValue("a\r")).toBe(false);
    expect(() => http.setMaxIdleHTTPParsers(0)).toThrow(
      expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }),
    );
  });
});

describe("http server and client over loopback", () => {
  it("serves a GET with Node's request fields", async () => {
    let seen: IncomingMessage | null = null;
    const server = http.createServer((req, res) => {
      seen = req;
      res.setHeader("Content-Type", "text/plain");
      res.end("hello");
    });
    const port = await listen(server, 0);
    const { res, body } = await fetchOnce(`http://localhost:${port}/path?q=1`);
    expect(res.statusCode).toBe(200);
    expect(res.statusMessage).toBe("OK");
    expect(res.httpVersion).toBe("1.1");
    expect(res.headers["content-type"]).toBe("text/plain");
    expect(res.headers["content-length"]).toBe("5");
    expect(res.headers.connection).toBe("keep-alive");
    expect(res.headers["keep-alive"]).toBe("timeout=5");
    expect(typeof res.headers.date).toBe("string");
    expect(body).toBe("hello");
    const req = seen as unknown as IncomingMessage;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/path?q=1");
    expect(req.httpVersion).toBe("1.1");
    expect(req.headers).toEqual({ host: `localhost:${port}`, connection: "keep-alive" });
    expect(req.rawHeaders).toEqual(["Host", `localhost:${port}`, "Connection", "keep-alive"]);
    expect(req.socket?.remoteAddress).toBe("::ffff:127.0.0.1");
    expect(req.complete).toBe(true);
    await closeServer(server);
  });

  it("reads POST bodies sent with Content-Length and chunked", async () => {
    const bodies: string[] = [];
    const encodings: unknown[] = [];
    const server = http.createServer(async (req, res) => {
      encodings.push([req.headers["content-length"], req.headers["transfer-encoding"]]);
      bodies.push(await readBody(req));
      res.end("ok");
    });
    const port = await listen(server, 0);
    await fetchOnce({ port, method: "POST", path: "/a" }, "fixed body");
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ port, method: "POST" }, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", reject);
      req.write("chunk-1;");
      setTimeout(() => {
        req.write("chunk-2");
        req.end();
      }, 5);
    });
    expect(bodies).toEqual(["fixed body", "chunk-1;chunk-2"]);
    expect(encodings).toEqual([
      ["10", undefined],
      [undefined, "chunked"],
    ]);
    await closeServer(server);
  });

  it("frames responses with Content-Length or chunked encoding", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/fixed") {
        res.end("abc");
      } else {
        res.write("ab");
        res.end("c");
      }
    });
    const port = await listen(server, 0);
    const fixed = await rawConnection(port);
    fixed.channel.write(Buffer.from("GET /fixed HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
    expect(withoutDate(await fixed.ended)).toBe(
      "HTTP/1.1 200 OK\r\nDate: <date>\r\nConnection: close\r\nContent-Length: 3\r\n\r\nabc",
    );
    const chunked = await rawConnection(port);
    chunked.channel.write(
      Buffer.from("GET /chunked HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
    );
    expect(withoutDate(await chunked.ended)).toBe(
      "HTTP/1.1 200 OK\r\nDate: <date>\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n" +
        "2\r\nab\r\n1\r\nc\r\n0\r\n\r\n",
    );
    const old = await rawConnection(port);
    old.channel.write(Buffer.from("GET /chunked HTTP/1.0\r\n\r\n"));
    expect(withoutDate(await old.ended)).toBe(
      "HTTP/1.1 200 OK\r\nDate: <date>\r\nConnection: close\r\n\r\nabc",
    );
    await closeServer(server);
  });

  it("reuses a keep-alive connection for sequential requests", async () => {
    const sockets = new Set<unknown>();
    const server = http.createServer((req, res) => {
      sockets.add(req.socket);
      res.end(req.url);
    });
    const port = await listen(server, 0);
    const agent = new Agent({ keepAlive: true });
    const first = await fetchOnce({ port, path: "/1", agent });
    expect(first.req.reusedSocket).toBe(false);
    await tick();
    expect(Object.keys(agent.freeSockets)).toHaveLength(1);
    const second = await fetchOnce({ port, path: "/2", agent });
    expect(second.body).toBe("/2");
    expect(second.req.reusedSocket).toBe(true);
    expect(sockets.size).toBe(1);
    agent.destroy();
    await closeServer(server);
  });

  it("closes the connection when the client asks for it (agent: false)", async () => {
    const server = http.createServer((_req, res) => res.end("x"));
    const port = await listen(server, 0);
    let seenConnection: unknown;
    server.once("request", (req: IncomingMessage) => {
      seenConnection = req.headers.connection;
    });
    const { res } = await fetchOnce({ port, agent: false });
    expect(seenConnection).toBe("close");
    expect(res.headers.connection).toBe("close");
    await closeServer(server);
  });

  it("answers pipelined requests in order", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/slow") {
        setTimeout(() => res.end("slow"), 20);
      } else {
        res.end("fast");
      }
    });
    const port = await listen(server, 0);
    const raw = await rawConnection(port);
    raw.channel.write(
      Buffer.from(
        "GET /slow HTTP/1.1\r\nHost: x\r\n\r\nGET /fast HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
      ),
    );
    const text = await raw.ended;
    expect(text.indexOf("slow")).toBeGreaterThan(0);
    expect(text.indexOf("slow")).toBeLessThan(text.indexOf("fast"));
    expect(text.match(/HTTP\/1\.1 200 OK/g)).toHaveLength(2);
    await closeServer(server);
  });

  it("sends no body for HEAD, 204 and 304", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/204") {
        res.writeHead(204);
        res.end("ignored");
      } else if (req.url === "/304") {
        res.writeHead(304, { ETag: '"x"' });
        res.end();
      } else {
        res.setHeader("Content-Length", "5");
        res.end(req.method === "HEAD" ? undefined : "hello");
      }
    });
    const port = await listen(server, 0);
    const head = await fetchOnce({ port, method: "HEAD" });
    expect(head.res.headers["content-length"]).toBe("5");
    expect(head.body).toBe("");
    const noContent = await fetchOnce({ port, path: "/204" });
    expect(noContent.res.statusCode).toBe(204);
    expect(noContent.body).toBe("");
    const notModified = await fetchOnce({ port, path: "/304" });
    expect(notModified.res.statusCode).toBe(304);
    expect(notModified.body).toBe("");
    const raw = await rawConnection(port);
    raw.channel.write(Buffer.from("GET /204 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
    expect(withoutDate(await raw.ended)).toBe(
      "HTTP/1.1 204 No Content\r\nDate: <date>\r\nConnection: close\r\n\r\n",
    );
    await closeServer(server);
  });

  it("streams a large body both ways with backpressure", async () => {
    const size = 1024 * 1024;
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i++) {
      payload[i] = i % 251;
    }
    let sawBackpressure = false;
    const server = http.createServer((req, res) => {
      // An OutgoingMessage is a legacy Stream, as in Node, not a typed Writable.
      req.pipe(res as never);
    });
    const port = await listen(server, 0);
    const echoed = await new Promise<Buffer>((resolve, reject) => {
      const req = http.request({ port, method: "PUT" }, (res) => {
        const chunks: Uint8Array[] = [];
        res.on("data", (chunk: Uint8Array) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      });
      req.on("error", reject);
      let offset = 0;
      const pump = () => {
        while (offset < size) {
          const chunk = payload.subarray(offset, offset + 16384);
          offset += chunk.length;
          if (!req.write(chunk)) {
            sawBackpressure = true;
            req.once("drain", pump);
            return;
          }
        }
        req.end();
      };
      pump();
    });
    expect(echoed.length).toBe(size);
    expect(Buffer.compare(echoed, payload)).toBe(0);
    expect(sawBackpressure).toBe(true);
    await closeServer(server);
  });

  it("implements the outgoing header API with Node's errors", async () => {
    const results: Record<string, unknown> = {};
    const server = http.createServer((_req, res) => {
      res.setHeader("X-Single", "one");
      res.setHeader("X-Multi", ["a", "b"]);
      res.appendHeader("x-multi", "c");
      res.appendHeader("X-New", "n");
      res.setHeader("Cookie", ["k=v", "k2=v2"]);
      res.setHeaders(new Map([["X-From-Map", "m"]]));
      results.get = res.getHeader("x-single");
      results.has = [res.hasHeader("X-SINGLE"), res.hasHeader("nope")];
      results.names = res.getHeaderNames();
      results.raw = res.getRawHeaderNames();
      results.headers = { ...res.getHeaders() };
      res.removeHeader("X-New");
      results.removed = res.getHeader("X-New");
      try {
        res.setHeader("bad name", "x");
      } catch (error) {
        results.badName = (error as { code: string }).code;
      }
      try {
        res.setHeader("X-Bad", "a\r\nb");
      } catch (error) {
        results.badValue = (error as { code: string }).code;
      }
      try {
        res.writeHead(1000);
      } catch (error) {
        results.badStatus = (error as { code: string }).code;
      }
      res.writeHead(201, "Made", ["X-Raw", "1", "X-Raw", "2"]);
      results.sent = res.headersSent;
      try {
        res.setHeader("X-Late", "x");
      } catch (error) {
        results.late = [(error as Error).message, (error as { code: string }).code];
      }
      res.end("done");
      res.on("error", (error) => {
        results.writeAfterEnd = (error as { code: string }).code;
      });
      res.write("more");
    });
    const port = await listen(server, 0);
    const { res, body } = await fetchOnce({ port });
    await tick();
    expect(body).toBe("done");
    expect(res.statusCode).toBe(201);
    expect(res.statusMessage).toBe("Made");
    expect(res.headers["x-multi"]).toBe("a, b, c");
    expect(res.headers["x-raw"]).toBe("1, 2");
    expect(res.headers.cookie).toBe("k=v; k2=v2");
    expect(res.headers["x-from-map"]).toBe("m");
    expect(res.headers["x-new"]).toBeUndefined();
    expect(results).toMatchObject({
      get: "one",
      has: [true, false],
      names: ["x-single", "x-multi", "x-new", "cookie", "x-from-map"],
      raw: ["X-Single", "X-Multi", "X-New", "Cookie", "X-From-Map"],
      headers: {
        "x-single": "one",
        "x-multi": ["a", "b", "c"],
        "x-new": "n",
        cookie: ["k=v", "k2=v2"],
        "x-from-map": "m",
      },
      removed: undefined,
      badName: "ERR_INVALID_HTTP_TOKEN",
      badValue: "ERR_INVALID_CHAR",
      badStatus: "ERR_HTTP_INVALID_STATUS_CODE",
      sent: true,
      late: ["Cannot set headers after they are sent to the client", "ERR_HTTP_HEADERS_SENT"],
      writeAfterEnd: "ERR_STREAM_WRITE_AFTER_END",
    });
    await closeServer(server);
  });

  it("joins duplicate incoming headers by Node's rules", async () => {
    let req: IncomingMessage | null = null;
    const server = http.createServer((incoming, res) => {
      req = incoming;
      res.end();
    });
    const port = await listen(server, 0);
    const raw = await rawConnection(port);
    raw.channel.write(
      Buffer.from(
        "GET / HTTP/1.1\r\nHost: a\r\nHost: b\r\nSet-Cookie: 1\r\nset-cookie: 2\r\n" +
          "Cookie: x=1\r\nCookie: y=2\r\nContent-Type: text/a\r\nContent-Type: text/b\r\n" +
          "Accept: a\r\nAccept: b\r\nX-Custom: 1\r\nx-custom: 2\r\nConnection: close\r\n\r\n",
      ),
    );
    await raw.ended;
    const message = req as unknown as IncomingMessage;
    expect(message.headers).toEqual({
      host: "a",
      "set-cookie": ["1", "2"],
      cookie: "x=1; y=2",
      "content-type": "text/a",
      accept: "a, b",
      "x-custom": "1, 2",
      connection: "close",
    });
    expect(message.headersDistinct.host).toEqual(["a", "b"]);
    expect(message.headersDistinct["x-custom"]).toEqual(["1", "2"]);
    await closeServer(server);
  });

  it("sends and receives trailers", async () => {
    let requestTrailers: unknown;
    const server = http.createServer(async (req, res) => {
      await readBody(req);
      requestTrailers = req.trailers;
      res.setHeader("Trailer", "X-Checksum");
      res.write("body");
      res.addTrailers({ "X-Checksum": "abc" });
      res.end();
    });
    const port = await listen(server, 0);
    const result = await new Promise<{ trailers: unknown; raw: string[]; body: string }>(
      (resolve, reject) => {
        const req = http.request({ port, method: "POST" }, (res) => {
          readBody(res).then((body) =>
            resolve({ trailers: res.trailers, raw: res.rawTrailers, body }),
          );
        });
        req.on("error", reject);
        req.setHeader("Trailer", "X-Client");
        req.write("data");
        req.addTrailers({ "X-Client": "yes" });
        req.end();
      },
    );
    expect(result.body).toBe("body");
    expect(result.trailers).toEqual({ "x-checksum": "abc" });
    expect(result.raw).toEqual(["X-Checksum", "abc"]);
    expect(requestTrailers).toEqual({ "x-client": "yes" });
    await closeServer(server);
  });

  it("handles Expect: 100-continue automatically and with checkContinue", async () => {
    const server = http.createServer(async (req, res) => {
      res.end(`got ${await readBody(req)}`);
    });
    const port = await listen(server, 0);
    const events: string[] = [];
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        { port, method: "POST", headers: { Expect: "100-continue" } },
        (res) => {
          readBody(res).then(resolve, reject);
        },
      );
      req.on("error", reject);
      req.on("information", (info: { statusCode: number }) =>
        events.push(`info ${info.statusCode}`),
      );
      req.on("continue", () => {
        events.push("continue");
        req.end("payload");
      });
    });
    expect(body).toBe("got payload");
    expect(events).toEqual(["continue", "info 100"]);

    server.removeAllListeners("request");
    server.on("checkContinue", (req: IncomingMessage, res: ServerResponse) => {
      if (req.headers["x-allow"]) {
        res.writeContinue();
        readBody(req).then((text) => res.end(`allowed ${text}`));
      } else {
        res.writeHead(417);
        res.end();
      }
    });
    const refused = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request(
        { port, method: "POST", headers: { Expect: "100-continue" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? undefined);
        },
      );
      req.on("error", reject);
    });
    expect(refused).toBe(417);
    const allowed = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        { port, method: "POST", headers: { Expect: "100-continue", "X-Allow": "1" } },
        (res) => readBody(res).then(resolve, reject),
      );
      req.on("error", reject);
      req.on("continue", () => req.end("it"));
    });
    expect(allowed).toBe("allowed it");
    await closeServer(server);
  });

  it("answers a garbage request with 400 and reports clientError", async () => {
    const server = http.createServer(() => {
      throw new Error("never");
    });
    const port = await listen(server, 0);
    const raw = await rawConnection(port);
    raw.channel.write(Buffer.from("GARBAGE\r\n\r\n"));
    expect(await raw.ended).toBe("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");

    const errors: string[] = [];
    server.on("clientError", (error: Error & { code: string }, socket: Socket) => {
      errors.push(error.code);
      socket.end("HTTP/1.1 418 Custom\r\n\r\n");
    });
    const second = await rawConnection(port);
    second.channel.write(Buffer.from("NOT A REQUEST\r\n\r\n"));
    expect(await second.ended).toBe("HTTP/1.1 418 Custom\r\n\r\n");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^HPE_/);
    await closeServer(server);
  });

  // What real Node v26 (llhttp) reports for each line: code, reason and the
  // number of bytes it had parsed.
  it("says what is wrong with a request line as Node's parser does", async () => {
    const server = http.createServer(() => {
      throw new Error("never");
    });
    const errors: string[] = [];
    server.on(
      "clientError",
      (error: Error & { code?: string; reason?: string; bytesParsed?: number }, socket: Socket) => {
        errors.push(`${error.code} | ${error.reason} | ${error.bytesParsed}`);
        expect(error.message).toBe(`Parse Error: ${error.reason}`);
        socket.destroy();
      },
    );
    const port = await listen(server, 0);
    const report = async (...chunks: string[]) => {
      const raw = await rawConnection(port);
      for (const chunk of chunks) {
        raw.channel.write(Buffer.from(chunk, "latin1"));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await raw.ended;
      return errors.pop();
    };
    const method = "HPE_INVALID_METHOD | Invalid method encountered";
    const space = "HPE_INVALID_METHOD | Expected space after method";
    const protocol = "HPE_INVALID_CONSTANT | Expected HTTP/, RTSP/ or ICE/";
    expect(await report("NOT HTTP AT ALL\r\n\r\n")).toBe(`${method} | 3`);
    expect(await report("G@T / HTTP/1.1\r\n\r\n")).toBe(`${method} | 1`);
    expect(await report("get / HTTP/1.1\r\n\r\n")).toBe(`${method} | 0`);
    expect(await report(" GET / HTTP/1.1\r\n\r\n")).toBe(`${method} | 0`);
    expect(await report("PRO / HTTP/1.1\r\n\r\n")).toBe(`${method} | 3`);
    expect(await report("GET\r\n\r\n")).toBe(`${space} | 3`);
    expect(await report("POST\r\n\r\n")).toBe(`${space} | 4`);
    expect(await report("GETT / HTTP/1.1\r\n\r\n")).toBe(`${space} | 3`);
    expect(await report("PUTX / HTTP/1.1\r\n\r\n")).toBe(`${space} | 3`);
    expect(await report("GET / FTP/1.1\r\n\r\n")).toBe(`${protocol} | 6`);
    expect(await report("GET / http/1.1\r\n\r\n")).toBe(`${protocol} | 6`);
    expect(await report("GET /x y HTTP/1.1\r\n\r\n")).toBe(`${protocol} | 7`);
    expect(await report("GET / HTTP/x.1\r\n\r\n")).toBe(
      "HPE_INVALID_VERSION | Invalid major version | 11",
    );
    expect(await report("GET / HTTP/1\r\n\r\n")).toBe("HPE_INVALID_VERSION | Expected dot | 12");
    expect(await report("GET / HTTP/1.5\r\n\r\n")).toBe(
      "HPE_INVALID_VERSION | Invalid HTTP version | 14",
    );
    expect(await report("GET / HTTP/9.9x\r\n\r\n")).toBe(
      "HPE_INVALID_VERSION | Invalid HTTP version | 14",
    );
    expect(await report("GET / HTTP/1.1x\r\n\r\n")).toBe(
      "HPE_INVALID_VERSION | Expected CRLF after version | 14",
    );
    // The count is of the whole connection: after a blank line, and for a
    // line that arrived in two pieces.
    expect(await report("\r\nGETT / HTTP/1.1\r\n\r\n")).toBe(`${space} | 5`);
    expect(await report("GET / F", "TP/1.1\r\n\r\n")).toBe(`${protocol} | 6`);
    await closeServer(server);
  });

  it("rejects an HTTP/1.1 request without Host", async () => {
    const server = http.createServer((_req, res) => res.end("no"));
    const port = await listen(server, 0);
    const raw = await rawConnection(port);
    raw.channel.write(Buffer.from("GET / HTTP/1.1\r\n\r\n"));
    expect(withoutDate(await raw.ended)).toBe(
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nDate: <date>\r\n" +
        "Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
    );
    await closeServer(server);
  });

  it("fires server, request and response timeouts", async () => {
    const server = http.createServer((_req, res) => {
      setTimeout(() => res.end("late"), 60);
    });
    const serverTimeouts: unknown[] = [];
    server.setTimeout(10, (socket: Socket) => {
      serverTimeouts.push(socket);
    });
    const port = await listen(server, 0);
    const clientTimeout = await new Promise<string>((resolve, reject) => {
      const req = http.request({ port }, (res) => {
        readBody(res).then(resolve, reject);
      });
      req.setTimeout(40, () => {
        req.destroy(new Error("client timeout"));
      });
      req.on("error", (error) => resolve(error.message));
      req.end();
    });
    expect(clientTimeout).toBe("client timeout");
    await tick(10);
    expect(serverTimeouts.length).toBeGreaterThanOrEqual(1);
    await closeServer(server);
  });

  it("answers 408 when headers never finish (headersTimeout)", async () => {
    const server = http.createServer(
      { headersTimeout: 20, requestTimeout: 50, connectionsCheckingInterval: 10 },
      (_req, res) => res.end(),
    );
    const port = await listen(server, 0);
    const raw = await rawConnection(port);
    raw.channel.write(Buffer.from("GET / HTTP/1.1\r\nHost: x\r\n"));
    expect(await raw.ended).toBe("HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n");
    await closeServer(server);
  });

  it("tells the server when the client aborts", async () => {
    const events: string[] = [];
    let arrived!: () => void;
    const requestArrived = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const serverSaw = new Promise<void>((resolve) => {
      const server = http.createServer((req, res) => {
        req.on("aborted", () => events.push("req aborted"));
        req.on("close", () => events.push("req close"));
        res.on("close", () => {
          events.push(`res close (finished ${res.writableFinished})`);
          resolve();
        });
        arrived();
      });
      void listen(server, 0).then((port) => {
        const req = http.request({ port, method: "POST" });
        req.on("error", (error) => events.push(`client ${(error as { code: string }).code}`));
        req.write("partial");
        void requestArrived.then(() => req.destroy());
        currentServer = server;
      });
    });
    let currentServer: Server | null = null;
    await serverSaw;
    await tick();
    expect(events).toContain("req aborted");
    expect(events).toContain("req close");
    expect(events).toContain("res close (finished false)");
    expect(events).toContain("client ECONNRESET");
    await closeServer(currentServer as unknown as Server);
  });

  it("reports ECONNRESET to the client when the server destroys the socket", async () => {
    const server = http.createServer((req) => {
      req.socket?.destroy();
    });
    const port = await listen(server, 0);
    const error = await new Promise<Error & { code: string }>((resolve) => {
      const req = http.get({ port }, () => resolve(new Error("unexpected") as never));
      req.on("error", (failure) => resolve(failure as Error & { code: string }));
    });
    expect(error.code).toBe("ECONNRESET");
    expect(error.message).toBe("socket hang up");
    await closeServer(server);
  });

  it("emits EADDRINUSE and takes an ephemeral port", async () => {
    const first = http.createServer();
    const port = await listen(first, 0);
    expect(port).toBeGreaterThan(0);
    const second = http.createServer();
    const error = await new Promise<Error & Record<string, unknown>>((resolve) => {
      second.on("error", (failure) => resolve(failure as Error & Record<string, unknown>));
      second.listen(port, "127.0.0.1");
    });
    expect(error).toMatchObject({
      code: "EADDRINUSE",
      syscall: "listen",
      address: "127.0.0.1",
      port,
    });
    // Vite's retry: listen on the next port after EADDRINUSE.
    const next = await listen(second, port + 1, "127.0.0.1");
    expect(next).toBe(port + 1);
    await closeServer(first);
    await closeServer(second);
  });

  it("close() drops idle keep-alive connections and waits for busy ones", async () => {
    let finish!: () => void;
    const server = http.createServer((req, res) => {
      if (req.url === "/busy") {
        finish = () => res.end("busy done");
      } else {
        res.end("idle");
      }
    });
    const port = await listen(server, 0);
    const agent = new Agent({ keepAlive: true });
    await fetchOnce({ port, path: "/idle", agent });
    await tick();
    const busy = fetchOnce({ port, path: "/busy", agent: new Agent({ keepAlive: true }) });
    await tick(5);
    let closed = false;
    server.close(() => {
      closed = true;
    });
    await tick(5);
    expect(closed).toBe(false);
    finish();
    expect((await busy).body).toBe("busy done");
    await tick(5);
    // As in Node, the finished connection stays kept-alive until it idles out.
    expect(closed).toBe(false);
    server.closeIdleConnections();
    agent.destroy();
    await tick(5);
    expect(closed).toBe(true);
    expect(fake.refCount).toBe(0);
  });

  it("holds refs while serving and releases them all", async () => {
    const server = http.createServer((_req, res) => res.end("x"));
    const port = await listen(server, 0);
    expect(fake.refCount).toBe(1);
    await fetchOnce({ port, agent: false });
    await tick(5);
    expect(fake.refCount).toBe(1);
    await fetchOnce({ port });
    await tick(5);
    // The server's end of the kept-alive connection stays open (as in Node); the
    // client's pooled socket is unref'd.
    expect(fake.refCount).toBe(2);
    await closeServer(server);
    await tick(5);
    expect(fake.refCount).toBe(0);
  });

  it("says Connection: close at maxRequestsPerSocket and answers 503 beyond it", async () => {
    const server = http.createServer((_req, res) => res.end("x"));
    server.maxRequestsPerSocket = 1;
    const dropped: unknown[] = [];
    server.on("dropRequest", (req: IncomingMessage) => dropped.push(req.url));
    const port = await listen(server, 0);
    const raw = await rawConnection(port);
    raw.channel.write(Buffer.from("GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
    // As in Node, the connection stays open after the "close" response.
    expect(withoutDate(await raw.until("\r\n\r\nx"))).toBe(
      "HTTP/1.1 200 OK\r\nDate: <date>\r\nConnection: close\r\nContent-Length: 1\r\n\r\nx",
    );
    raw.channel.write(Buffer.from("GET /again HTTP/1.1\r\nHost: x\r\n\r\n"));
    expect(await raw.until("503")).toContain("HTTP/1.1 503 Service Unavailable");
    expect(dropped).toEqual(["/again"]);
    await closeServer(server);
  });

  it("destroys a CONNECT nobody handles and hands it over when someone does", async () => {
    const server = http.createServer();
    const port = await listen(server, 0);
    const raw = await rawConnection(port);
    raw.channel.write(
      Buffer.from("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"),
    );
    expect(await raw.ended).toBe("");

    let tunnel: Socket | null = null;
    server.on("connect", (req: IncomingMessage, socket: Socket, head: Buffer) => {
      tunnel = socket;
      socket.write(`HTTP/1.1 200 Connection Established\r\n\r\n${req.url} ${head.toString()}`);
      socket.end();
    });
    const handled = await rawConnection(port);
    handled.channel.write(
      Buffer.from("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\nEXTRA"),
    );
    expect(await handled.ended).toBe(
      "HTTP/1.1 200 Connection Established\r\n\r\nexample.com:443 EXTRA",
    );
    // The tunnel is its handler's: server.close() waits for it, as in Node.
    (tunnel as unknown as Socket).destroy();
    await closeServer(server);
  });

  it("hands upgrades to the upgrade listener with the unparsed bytes", async () => {
    const server = http.createServer();
    let upgraded: Socket | null = null;
    server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
      upgraded = socket;
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n",
      );
      socket.write(`head=${head.toString()};`);
      socket.on("data", (chunk: Buffer) => socket.write(chunk.toString().toUpperCase()));
      expect(req.headers.upgrade).toBe("echo");
    });
    const port = await listen(server, 0);
    const result = await new Promise<string>((resolve, reject) => {
      const req = http.request({ port, headers: { Connection: "Upgrade", Upgrade: "echo" } });
      req.on("upgrade", (res: IncomingMessage, socket: Socket, head: Buffer) => {
        expect(res.statusCode).toBe(101);
        let text = head.toString();
        socket.on("data", (chunk: Buffer) => {
          text += chunk.toString();
          if (text.includes("PING")) {
            socket.destroy();
            resolve(text);
          }
        });
        socket.write("ping");
      });
      req.on("error", reject);
      req.end();
    });
    expect(result).toBe("head=;PING");
    (upgraded as unknown as Socket).destroy();
    await closeServer(server);
  });

  it("leaves an upgraded socket to its handler: server.close() does not touch it", async () => {
    const server = http.createServer();
    let upgraded: Socket | null = null;
    server.on("upgrade", (_req: IncomingMessage, socket: Socket) => {
      upgraded = socket;
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n");
    });
    const port = await listen(server, 0);
    const client = net.connect(port);
    client.write("GET / HTTP/1.1\r\nHost: x\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n");
    await new Promise((resolve) => client.once("data", resolve));
    let closed = false;
    server.on("close", () => {
      closed = true;
    });
    server.close();
    server.closeIdleConnections();
    await tick(20);
    const socket = upgraded as unknown as Socket;
    expect(socket.destroyed).toBe(false);
    expect(closed).toBe(false);
    socket.destroy();
    client.destroy();
    await tick(20);
    expect(closed).toBe(true);
  });

  it("supports custom IncomingMessage and ServerResponse classes", async () => {
    class MyRequest extends IncomingMessage {
      marker = "mine";
    }
    class MyResponse extends ServerResponse {
      json(value: unknown) {
        this.setHeader("Content-Type", "application/json");
        this.end(JSON.stringify(value));
      }
    }
    const server = http.createServer(
      { IncomingMessage: MyRequest, ServerResponse: MyResponse },
      (req, res) => {
        (res as MyResponse).json({ marker: (req as MyRequest).marker });
      },
    );
    const port = await listen(server, 0);
    const { body, res } = await fetchOnce({ port });
    expect(JSON.parse(body)).toEqual({ marker: "mine" });
    expect(res.headers["content-type"]).toBe("application/json");
    await closeServer(server);
  });

  it("writes 1xx informational responses (Early Hints, Processing)", async () => {
    const server = http.createServer((_req, res) => {
      res.writeEarlyHints({ link: "</style.css>; rel=preload; as=style", "x-hint": "1" });
      res.writeProcessing();
      res.end("final");
    });
    const port = await listen(server, 0);
    const info: number[] = [];
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.get({ port }, (res) => readBody(res).then(resolve, reject));
      req.on("information", (message: { statusCode: number }) => info.push(message.statusCode));
    });
    expect(info).toEqual([103, 102]);
    expect(body).toBe("final");
    await closeServer(server);
  });

  it("aborts with an AbortSignal", async () => {
    const server = http.createServer(() => {});
    const port = await listen(server, 0);
    const controller = new AbortController();
    const error = await new Promise<Error & { code: string; name: string }>((resolve) => {
      const req = http.get({ port, signal: controller.signal });
      req.on("error", (failure) => resolve(failure as Error & { code: string; name: string }));
      setTimeout(() => controller.abort(), 5);
    });
    expect(error.name).toBe("AbortError");
    expect(error.code).toBe("ABORT_ERR");
    await closeServer(server);
  });

  it("refuses to connect to a port nobody listens on", async () => {
    const error = await new Promise<Error & Record<string, unknown>>((resolve) => {
      http
        .get({ port: 4999, host: "127.0.0.1" })
        .on("error", (failure) => resolve(failure as Error & Record<string, unknown>));
    });
    expect(error).toMatchObject({ code: "ECONNREFUSED", address: "127.0.0.1", port: 4999 });
    await tick();
    expect(fake.refCount).toBe(0);
  });

  it("calls end() callbacks as Node 26 does: before 'finish', with null or the write's error", async () => {
    const events: string[] = [];
    const show =
      (label: string) =>
      (...args: unknown[]) =>
        events.push(
          `${label}: ${args.length} ${args.map((a) => (a instanceof Error ? (a as Error & { code?: string }).code : String(a)))}`,
        );
    await new Promise<void>((resolve) => {
      const refused = http.request({ port: 4999, host: "127.0.0.1", method: "POST" });
      refused.on("error", (e: Error & { code?: string }) => events.push(`refused error ${e.code}`));
      refused.on("finish", show("refused finish"));
      refused.end("q", show("refused end"));
      refused.on("close", () => {
        refused.end(show("refused end after close"));
        setTimeout(resolve, 5);
      });
    });
    const server = http.createServer((req, res) => {
      req.resume();
      res.on("finish", () => events.push(`res finish ${res.writableFinished}`));
      res.end("body", show("res.end(chunk, cb)"));
      res.end(show("res.end again"));
      events.push(`res after end ${res.writableFinished} ${res.writableEnded}`);
      res.on("finish", () => setTimeout(() => res.end(show("res.end after finish")), 5));
    });
    const port = await listen(server, 0);
    await new Promise<void>((resolve) => {
      const req = http.request({ port, method: "POST" }, (res) => {
        res.resume();
        res.on("end", () => setTimeout(resolve, 20));
      });
      req.on("finish", show("req finish"));
      req.end("data", show("req.end(chunk, cb)"));
    });
    expect(events).toEqual([
      "refused error ECONNREFUSED",
      "refused end: 1 ERR_SOCKET_CLOSED_BEFORE_CONNECTION",
      "refused end after close: 1 ERR_SOCKET_CLOSED_BEFORE_CONNECTION",
      "req.end(chunk, cb): 1 null",
      "req finish: 0 ",
      "res after end false true",
      "res.end(chunk, cb): 1 null",
      "res.end again: 1 null",
      "res finish true",
      "res.end after finish: 1 ERR_STREAM_ALREADY_FINISHED",
    ]);
    await closeServer(server);
  });

  it("validates request options as Node does", () => {
    expect(() => http.request({ method: "BAD METHOD" })).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_HTTP_TOKEN" }),
    );
    expect(() => http.request({ path: "/a b" })).toThrow(
      expect.objectContaining({ code: "ERR_UNESCAPED_CHARACTERS" }),
    );
    expect(() => http.request("https://localhost/")).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_PROTOCOL" }),
    );
    expect(() => http.request({ socketPath: "/tmp/s" })).toThrow(/Unix domain sockets/);
  });
});

describe("agents, connections and peers", () => {
  it("queues requests beyond maxSockets and serves them in turn", async () => {
    const order: string[] = [];
    const server = http.createServer((req, res) => {
      order.push(req.url ?? "");
      setTimeout(() => res.end(req.url), 5);
    });
    const port = await listen(server, 0);
    const agent = new Agent({ maxSockets: 1 });
    const first = fetchOnce({ port, path: "/a", agent });
    const second = fetchOnce({ port, path: "/b", agent });
    await tick();
    expect(agent.requests[`localhost:${port}:`]).toHaveLength(1);
    expect((await first).body).toBe("/a");
    expect((await second).body).toBe("/b");
    expect(order).toEqual(["/a", "/b"]);
    await closeServer(server);
  });

  it("uses a createConnection option instead of an agent", async () => {
    const server = http.createServer((_req, res) => res.end("custom"));
    const port = await listen(server, 0);
    let used = false;
    const { body } = await fetchOnce({
      port,
      createConnection: (options) => {
        used = true;
        return net.connect(Number(options.port), "127.0.0.1");
      },
    });
    expect(used).toBe(true);
    expect(body).toBe("custom");
    await closeServer(server);
  });

  it("hands a CONNECT tunnel to the client's connect listener", async () => {
    const server = http.createServer();
    server.on("connect", (_req: IncomingMessage, socket: Socket) => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\ntunnel-bytes");
      socket.end();
    });
    const port = await listen(server, 0);
    const result = await new Promise<string>((resolve, reject) => {
      const req = http.request({ port, method: "CONNECT", path: "example.com:443" });
      req.on("connect", (res: IncomingMessage, socket: Socket, head: Buffer) => {
        let text = `${res.statusCode} ${head.toString()}`;
        socket.on("data", (chunk: Buffer) => (text += chunk.toString()));
        socket.on("end", () => resolve(text));
      });
      req.on("error", reject);
      req.end();
    });
    expect(result).toBe("200 tunnel-bytes");
    await closeServer(server);
  });

  it("treats a peer dropping an idle connection (the preview gateway) as a normal close", async () => {
    const server = http.createServer((_req, res) => res.end("page"));
    const errors: unknown[] = [];
    server.on("clientError", (error: unknown) => errors.push(error));
    const port = await listen(server, 0);
    const raw = await rawConnection(port);
    raw.channel.write(Buffer.from(`GET / HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`));
    await raw.until("\r\n\r\npage");
    await tick();
    raw.channel.destroy();
    await tick(5);
    expect(errors).toEqual([]);
    const count = await new Promise((resolve) => server.getConnections((_e, n) => resolve(n)));
    expect(count).toBe(0);
    await closeServer(server);
  });

  it("reports a peer vanishing mid-request as clientError and aborts the request", async () => {
    const events: string[] = [];
    const server = http.createServer((req) => {
      req.on("aborted", () => events.push("aborted"));
      req.on("close", () => events.push("close"));
    });
    server.on("clientError", (error: Error & { code: string }) =>
      events.push(`clientError ${error.code}`),
    );
    const port = await listen(server, 0);
    const raw = await rawConnection(port);
    raw.channel.write(
      Buffer.from("POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\npartial"),
    );
    await tick(5);
    raw.channel.destroy();
    await tick(5);
    expect(events).toEqual(["clientError ECONNRESET", "aborted", "close"]);
    await closeServer(server);
  });

  it("serves an Upgrade request as a normal one when nobody listens for upgrades", async () => {
    const server = http.createServer((req, res) =>
      res.end(`${req.url} upgrade=${String(req.upgrade)}`),
    );
    const port = await listen(server, 0);
    const raw = await rawConnection(port);
    raw.channel.write(
      Buffer.from(
        "GET /a HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n" +
          "GET /b HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
      ),
    );
    const text = await raw.ended;
    expect(text).toContain("/a upgrade=false");
    expect(text).toContain("/b upgrade=false");
    await closeServer(server);
  });
});

describe("message framing", () => {
  it("accepts a 200 KB body written together with the head", async () => {
    const server = http.createServer((req, res) => {
      readBody(req).then((body) => res.end(String(body.length)));
    });
    const port = await listen(server, 0);
    const body = "x".repeat(200_000);
    const { res, body: reply } = await fetchOnce(
      { port, method: "POST", headers: { "content-length": body.length } },
      body,
    );
    expect([res.statusCode, reply]).toEqual([200, "200000"]);
    await closeServer(server);
  });

  it("accepts a 200 KB body that arrives in one chunk after the head", async () => {
    const server = http.createServer((req, res) => {
      readBody(req).then((body) => res.end(`received ${body.length}`));
    });
    const port = await listen(server, 0);
    const conn = await rawConnection(port);
    conn.channel.write(
      Buffer.from(
        "POST / HTTP/1.1\r\nHost: h\r\nConnection: close\r\nContent-Length: 200000\r\n\r\n",
      ),
    );
    conn.channel.write(Buffer.alloc(200_000, 0x61));
    const reply = await conn.ended;
    expect(reply.startsWith("HTTP/1.1 200 OK")).toBe(true);
    expect(reply.endsWith("received 200000")).toBe(true);
    await closeServer(server);
  });

  it("reads a 100 KB response that arrives in one chunk", async () => {
    const server = http.createServer((_req, res) => res.end(Buffer.alloc(100_000, 0x61)));
    const port = await listen(server, 0);
    const errors: string[] = [];
    const { res, body } = await new Promise<Fetched>((resolve, reject) => {
      const req = http.get({ port }, (res) => {
        readBody(res).then((text) => resolve({ res, body: text, req }), reject);
      });
      req.on("error", (error: Error & { code?: string }) => errors.push(error.code ?? ""));
    });
    expect([res.statusCode, body.length, errors]).toEqual([200, 100_000, []]);
    await closeServer(server);
  });

  it("refuses a 20 KB head that arrives in one chunk", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    const errors: string[] = [];
    server.on("clientError", (error: Error & { code?: string }, socket: Socket) => {
      errors.push(error.code ?? "");
      socket.destroy();
    });
    const port = await listen(server, 0);
    const conn = await rawConnection(port);
    conn.channel.write(
      Buffer.from(`GET / HTTP/1.1\r\nHost: h\r\nx: ${"a".repeat(20_000)}\r\n\r\n`),
    );
    await conn.ended;
    expect(errors).toEqual(["HPE_HEADER_OVERFLOW"]);
    await closeServer(server);
  });

  it("keeps the head limit after the first message on a connection", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    const errors: string[] = [];
    server.on("clientError", (error: Error & { code?: string }, socket: Socket) => {
      errors.push(error.code ?? "");
      socket.destroy();
    });
    const port = await listen(server, 0);
    const conn = await rawConnection(port);
    conn.channel.write(Buffer.from("GET / HTTP/1.1\r\nHost: h\r\n\r\n"));
    await conn.until("ok");
    conn.channel.write(
      Buffer.from(`GET / HTTP/1.1\r\nHost: h\r\nx: ${"a".repeat(20_000)}\r\n\r\n`),
    );
    await conn.ended;
    expect(errors).toEqual(["HPE_HEADER_OVERFLOW"]);
    await closeServer(server);
  });

  it("rejects Content-Length together with Transfer-Encoding", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    const errors: string[] = [];
    server.on("clientError", (error: Error & { code?: string }, socket: Socket) => {
      errors.push(`${error.code} ${error.message}`);
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });
    const port = await listen(server, 0);
    const conn = await rawConnection(port);
    conn.channel.write(
      Buffer.from(
        "POST / HTTP/1.1\r\nHost: h\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
      ),
    );
    const reply = await conn.ended;
    expect(errors).toEqual([
      "HPE_INVALID_TRANSFER_ENCODING Parse Error: Transfer-Encoding can't be present with Content-Length",
    ]);
    expect(reply).toBe("HTTP/1.1 400 Bad Request\r\n\r\n");
    await closeServer(server);
  });

  it("accepts Content-Length with Transfer-Encoding under insecureHTTPParser", async () => {
    const server = http.createServer({ insecureHTTPParser: true }, (_req, res) => res.end("ok"));
    const port = await listen(server, 0);
    const conn = await rawConnection(port);
    conn.channel.write(
      Buffer.from(
        "POST / HTTP/1.1\r\nHost: h\r\nConnection: close\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
      ),
    );
    expect((await conn.ended).startsWith("HTTP/1.1 200 OK")).toBe(true);
    await closeServer(server);
  });
});
