// @vitest-environment node
// `http`/`https` requests to hosts outside webnode, carried by a stubbed
// `globalThis.fetch`: headers, buffered and streamed bodies, manual redirects,
// abort, failure mapping, timeouts and ref counting.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import { Buffer } from "./buffer";
import http, { type IncomingMessage } from "./http";
import https from "./https";

let fake: FakeRuntime;
const realFetch = globalThis.fetch;

interface Call {
  url: string;
  init: RequestInit & { duplex?: string };
  body: string | null;
}

let calls: Call[];

beforeEach(() => {
  fake = createFakeRuntime();
  setRuntime(fake);
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setRuntime(null);
});

async function bodyText(body: BodyInit | null | undefined): Promise<string | null> {
  if (body === null || body === undefined) {
    return null;
  }
  return new Response(body).text();
}

function stubFetch(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const options = (init ?? {}) as RequestInit & { duplex?: string };
    const call: Call = { url, init: options, body: null };
    calls.push(call);
    const response = await respond(url, options);
    call.body = await bodyText(options.body);
    return response;
  }) as typeof fetch;
}

function readBody(res: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    res.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    res.on("end", () => resolve(Buffer.concat(chunks).toString()));
    res.on("error", reject);
  });
}

describe("requests to other hosts go through fetch", () => {
  it("sends method, URL and headers, dropping the ones fetch forbids", async () => {
    stubFetch(
      () =>
        new Response("remote body", {
          status: 201,
          statusText: "Created",
          headers: { "Content-Type": "text/plain", "X-Remote": "1" },
        }),
    );
    const events: string[] = [];
    const result = await new Promise<{ res: IncomingMessage; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: "example.com",
          port: 8080,
          path: "/api?x=1",
          method: "POST",
          headers: { "X-Custom": "yes", Cookie: "secret", "Content-Type": "application/json" },
        },
        (res) => {
          events.push("response");
          readBody(res).then((body) => resolve({ res, body }), reject);
        },
      );
      req.on("socket", () => events.push("socket"));
      req.on("finish", () => events.push("finish"));
      req.on("close", () => events.push("close"));
      req.on("error", reject);
      req.end('{"a":1}');
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe("http://example.com:8080/api?x=1");
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("manual");
    const headers = new Headers(call.init.headers);
    expect(headers.get("x-custom")).toBe("yes");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("host")).toBe(false);
    expect(headers.has("connection")).toBe(false);
    expect(call.body).toBe('{"a":1}');
    expect(result.res.statusCode).toBe(201);
    expect(result.res.statusMessage).toBe("Created");
    expect(result.res.headers["x-remote"]).toBe("1");
    expect(result.res.httpVersion).toBe("1.1");
    expect(result.body).toBe("remote body");
    expect(events).toEqual(["socket", "finish", "response", "close"]);
    expect(fake.refCount).toBe(0);
  });

  it("uses the https URL for https requests and splits set-cookie", async () => {
    const headers = new Headers();
    headers.append("Set-Cookie", "a=1");
    headers.append("Set-Cookie", "b=2");
    stubFetch(() => new Response("ok", { headers }));
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      https.get("https://api.example.com/v1", resolve).on("error", reject);
    });
    await readBody(res);
    expect(calls[0].url).toBe("https://api.example.com/v1");
    expect(calls[0].init.body).toBeUndefined();
    expect(res.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
  });

  it("shows a 3xx to the caller instead of following it", async () => {
    stubFetch(() => new Response(null, { status: 302, headers: { Location: "/elsewhere" } }));
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      http.get("http://example.com/old", resolve).on("error", reject);
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/elsewhere");
    expect(await readBody(res)).toBe("");
  });

  it("follows an opaque redirect for GET, since the browser hides it", async () => {
    let count = 0;
    stubFetch((_url, init) => {
      count++;
      if (init.redirect === "manual") {
        return Object.defineProperty(new Response(null, { status: 200 }), "type", {
          value: "opaqueredirect",
        });
      }
      return new Response("followed");
    });
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      http.get("http://example.com/moved", resolve).on("error", reject);
    });
    expect(await readBody(res)).toBe("followed");
    expect(count).toBe(2);
    expect(calls[1].init.redirect).toBe("follow");
  });

  it("streams the response body into the IncomingMessage", async () => {
    let push!: (text: string | null) => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => {
          if (text === null) {
            controller.close();
          } else {
            controller.enqueue(new TextEncoder().encode(text));
          }
        };
      },
    });
    stubFetch(() => new Response(stream));
    const chunks: string[] = [];
    const ended = new Promise<void>((resolve, reject) => {
      http
        .get("http://example.com/stream", (res) => {
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => chunks.push(chunk));
          res.on("end", resolve);
        })
        .on("error", reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    push("one,");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(chunks).toEqual(["one,"]);
    push("two");
    push(null);
    await ended;
    expect(chunks.join("")).toBe("one,two");
  });

  it("buffers a body written over several turns and sends it once the request ends", async () => {
    stubFetch(() => new Response("done"));
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: "example.com", method: "PUT", path: "/upload" }, (res) =>
        readBody(res).then(resolve, reject),
      );
      req.on("error", reject);
      req.write("part1;");
      setTimeout(() => {
        req.write("part2");
        req.end();
      }, 20);
    });
    expect(body).toBe("done");
    expect(calls).toHaveLength(1);
    expect(calls[0].init.duplex).toBeUndefined();
    expect(calls[0].body).toBe("part1;part2");
  });

  it("sends a header set a turn after the request started", async () => {
    stubFetch(() => new Response("ok"));
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: "example.com", method: "POST", path: "/late" }, (res) =>
        readBody(res).then(() => resolve(), reject),
      );
      req.on("error", reject);
      setTimeout(() => {
        req.setHeader("X-Late", "1");
        req.end("payload");
      }, 20);
    });
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0].init.headers).get("x-late")).toBe("1");
    expect(calls[0].body).toBe("payload");
  });

  it("drops Content-Encoding and Content-Length from a body the browser decoded", async () => {
    stubFetch(
      () =>
        new Response("plain text", {
          headers: { "Content-Encoding": "gzip", "Content-Length": "4", "X-Kept": "1" },
        }),
    );
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      http.get("http://example.com/gz", resolve).on("error", reject);
    });
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.headers["content-length"]).toBeUndefined();
    expect(res.headers["x-kept"]).toBe("1");
    expect(await readBody(res)).toBe("plain text");
  });

  it("cancels the fetch body when the response is destroyed mid-stream", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
      },
      cancel() {
        cancelled = true;
      },
    });
    let signal: AbortSignal | null = null;
    stubFetch((_url, init) => {
      signal = init.signal ?? null;
      return new Response(stream);
    });
    await new Promise<void>((resolve, reject) => {
      http
        .get("http://example.com/forever", (res) => {
          res.once("data", () => {
            res.destroy();
            resolve();
          });
        })
        .on("error", () => {});
      setTimeout(() => reject(new Error("no data")), 200);
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cancelled).toBe(true);
    expect((signal as unknown as AbortSignal).aborted).toBe(true);
    expect(fake.refCount).toBe(0);
  });

  it("maps a rejected fetch to ECONNREFUSED with the cause", async () => {
    const original = new TypeError("Failed to fetch");
    stubFetch(() => Promise.reject(original));
    const events: string[] = [];
    const error = await new Promise<Error & Record<string, unknown>>((resolve) => {
      const req = http.get("http://unreachable.example/");
      req.on("error", (failure) => {
        events.push("error");
        resolve(failure as Error & Record<string, unknown>);
      });
      req.on("close", () => events.push("close"));
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(error.code).toBe("ECONNREFUSED");
    expect(error.syscall).toBe("connect");
    expect(error.address).toBe("unreachable.example");
    expect(error.port).toBe(80);
    expect(error.cause).toBe(original);
    expect(events).toEqual(["error", "close"]);
    expect(fake.refCount).toBe(0);
  });

  it("aborts the fetch when the request is destroyed", async () => {
    let signal: AbortSignal | null = null;
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init.signal ?? null;
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const error = await new Promise<Error & { code: string }>((resolve) => {
      const req = http.get("http://example.com/slow");
      req.on("error", (failure) => resolve(failure as Error & { code: string }));
      setTimeout(() => req.destroy(), 5);
    });
    expect(error.code).toBe("ECONNRESET");
    expect(error.message).toBe("socket hang up");
    expect((signal as unknown as AbortSignal).aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fake.refCount).toBe(0);
  });

  it("emits timeout when the response is slow", async () => {
    stubFetch(() => new Promise<Response>(() => {}));
    const timedOut = await new Promise<boolean>((resolve) => {
      const req = http.get({ host: "example.com", timeout: 15 });
      req.on("timeout", () => {
        resolve(true);
        req.destroy();
      });
      req.on("error", () => {});
    });
    expect(timedOut).toBe(true);
  });

  it("skips the body of a HEAD response", async () => {
    stubFetch(() => new Response(null, { headers: { "Content-Length": "10" } }));
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      http.request({ host: "example.com", method: "HEAD" }, resolve).on("error", reject).end();
    });
    expect(res.headers["content-length"]).toBe("10");
    expect(await readBody(res)).toBe("");
  });
});
