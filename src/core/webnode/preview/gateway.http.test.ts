// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createPreviewClientScript } from "./clientScript";
import {
  EDITOR_ORIGIN,
  concat,
  createGatewayHarness,
  decoder,
  encoder,
  header,
  pieces,
  tick,
  writeAll,
} from "./gatewayTestKit";
import { allowNonceInPolicy, injectScripts } from "./htmlInject";
import type { FromGatewayMessage, ToGatewayMessage } from "./protocol";

let harness: ReturnType<typeof createGatewayHarness>;

afterEach(() => {
  harness?.dispose();
});

const CLIENT = createPreviewClientScript({
  forwardPreviewErrors: false,
  editorOrigin: EDITOR_ORIGIN,
});

function headerNames(headers: [string, string][]): string[] {
  return headers.map(([name]) => name.toLowerCase());
}

describe("PreviewGateway HTTP", () => {
  it("forwards the request and returns a Content-Length response", async () => {
    harness = createGatewayHarness();
    const received = harness.serve(3000, (server) => {
      writeAll(server, [
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\nX-Custom: yes\r\n\r\nhello",
      ]);
    });
    const response = await harness.request({
      url: "/a/b?c=1",
      headers: [
        ["accept", "*/*"],
        ["connection", "keep-alive"],
        ["host", "evil"],
        ["proxy-authorization", "x"],
        ["upgrade", "h2c"],
      ],
    });
    expect(response.status).toBe(200);
    expect(response.statusText).toBe("OK");
    expect(decoder.decode(response.body)).toBe("hello");
    expect(header(response.headers, "x-custom")).toBe("yes");
    expect(header(response.headers, "content-length")).toBe("5");
    expect(header(response.headers, "cross-origin-resource-policy")).toBe("cross-origin");
    expect(header(response.headers, "cross-origin-embedder-policy")).toBe("require-corp");
    expect(headerNames(response.headers)).not.toContain("connection");
    expect(headerNames(response.headers)).not.toContain("keep-alive");

    const [request] = received;
    expect(request.requestLine).toBe("GET /a/b?c=1 HTTP/1.1");
    expect(request.headers).toContainEqual(["Host", "localhost:3000"]);
    expect(request.headers).toContainEqual(["Connection", "close"]);
    expect(request.headers).toContainEqual(["accept", "*/*"]);
    const names = headerNames(request.headers);
    expect(names.filter((name) => name === "host")).toHaveLength(1);
    expect(names).not.toContain("proxy-authorization");
    expect(names).not.toContain("upgrade");
    expect(names).not.toContain("content-length");
  });

  it("omits COEP when it is none and replaces the server's isolation headers", async () => {
    harness = createGatewayHarness({ coep: "none" });
    harness.serve(3000, (server) => {
      writeAll(server, [
        "HTTP/1.1 200 OK\r\nCross-Origin-Resource-Policy: same-origin\r\nCross-Origin-Embedder-Policy: require-corp\r\nContent-Length: 0\r\n\r\n",
      ]);
    });
    const response = await harness.request();
    expect(response.headers.filter(([name]) => /cross-origin/i.test(name))).toEqual([
      ["Cross-Origin-Resource-Policy", "cross-origin"],
    ]);
  });

  it("forwards a request body with its Content-Length", async () => {
    harness = createGatewayHarness();
    const received = harness.serve(3000, (server, request) => {
      writeAll(server, [
        `HTTP/1.1 201 Created\r\nContent-Length: ${request.body.length}\r\n\r\n`,
        request.body,
      ]);
    });
    const body = encoder.encode(JSON.stringify({ hello: "world" }));
    const response = await harness.request({
      method: "POST",
      url: "/api",
      headers: [
        ["content-type", "application/json"],
        ["content-length", "999"],
        ["transfer-encoding", "chunked"],
      ],
      body,
    });
    expect(response.status).toBe(201);
    expect(decoder.decode(response.body)).toBe('{"hello":"world"}');
    expect(received[0].headers).toContainEqual(["Content-Length", String(body.length)]);
    expect(
      headerNames(received[0].headers).filter((name) => name === "content-length"),
    ).toHaveLength(1);
    expect(headerNames(received[0].headers)).not.toContain("transfer-encoding");
  });

  it("sends Content-Length: 0 for a bodiless POST", async () => {
    harness = createGatewayHarness();
    const received = harness.serve(3000, (server) => {
      writeAll(server, ["HTTP/1.1 204 No Content\r\n\r\n"]);
    });
    const response = await harness.request({ method: "POST" });
    expect(response.status).toBe(204);
    expect(received[0].headers).toContainEqual(["Content-Length", "0"]);
  });

  it("decodes a chunked body split at odd places, with trailers", async () => {
    harness = createGatewayHarness();
    const raw =
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\nTrailer: X-Sum\r\n\r\n" +
      "5;ext=1\r\nhello\r\n1\r\n \r\nA\r\n0123456789\r\n0\r\nX-Sum: 42\r\n\r\n";
    for (const size of [1, 2, 3, 7, 1000]) {
      harness.serve(3000, (server) => writeAll(server, pieces(raw, size)));
      const response = await harness.request();
      expect(decoder.decode(response.body)).toBe("hello 0123456789");
      expect(response.error).toBeNull();
      expect(headerNames(response.headers)).not.toContain("transfer-encoding");
      expect(headerNames(response.headers)).not.toContain("trailer");
    }
  });

  it("reads a close-delimited body until the server ends the connection", async () => {
    harness = createGatewayHarness();
    harness.serve(3000, (server) => {
      writeAll(server, [
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\npart one, ",
        "part two",
      ]);
      server.end();
    });
    const response = await harness.request();
    expect(decoder.decode(response.body)).toBe("part one, part two");
  });

  it("parses a head arriving one byte at a time", async () => {
    harness = createGatewayHarness();
    harness.serve(3000, (server) => {
      writeAll(server, pieces("HTTP/1.1 200 OK\r\nContent-Length: 3\r\nX-A: 1\r\n\r\nabc", 1));
    });
    const response = await harness.request();
    expect(header(response.headers, "x-a")).toBe("1");
    expect(decoder.decode(response.body)).toBe("abc");
  });

  it("returns no body for HEAD, 204 and 304", async () => {
    harness = createGatewayHarness();
    harness.serve(3000, (server) => {
      // A HEAD response announces a length but carries no body.
      writeAll(server, [
        "HTTP/1.1 200 OK\r\nContent-Length: 1234\r\nContent-Type: text/html\r\n\r\n",
      ]);
    });
    const head = await harness.request({ method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(header(head.headers, "content-length")).toBe("1234");

    for (const status of ["204 No Content", "304 Not Modified"]) {
      harness.serve(3000, (server) => {
        writeAll(server, [`HTTP/1.1 ${status}\r\nETag: "x"\r\n\r\n`]);
      });
      const response = await harness.request();
      expect(`${response.status} ${response.statusText}`).toBe(status);
      expect(response.body.length).toBe(0);
      expect(response.messages.map((message) => message.type)).toEqual([
        "response-head",
        "response-end",
      ]);
    }
  });

  it("skips 1xx interim responses", async () => {
    harness = createGatewayHarness();
    harness.serve(3000, (server) => {
      writeAll(server, [
        "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\nLink: </a.css>; rel=preload\r\n\r\n",
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
      ]);
    });
    const response = await harness.request();
    expect(response.status).toBe(200);
    expect(decoder.decode(response.body)).toBe("ok");
    expect(header(response.headers, "link")).toBeNull();
  });

  it("keeps duplicate headers such as Set-Cookie", async () => {
    harness = createGatewayHarness();
    harness.serve(3000, (server) => {
      writeAll(server, [
        "HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nVary: Accept\r\nVary: Origin\r\nContent-Length: 0\r\n\r\n",
      ]);
    });
    const response = await harness.request();
    expect(response.headers.filter(([name]) => name === "Set-Cookie")).toEqual([
      ["Set-Cookie", "a=1"],
      ["Set-Cookie", "b=2"],
    ]);
    expect(response.headers.filter(([name]) => name === "Vary")).toHaveLength(2);
  });

  it("streams a large body as it arrives", async () => {
    harness = createGatewayHarness();
    const total = 3 * 1024 * 1024;
    const payload = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      payload[i] = i % 251;
    }
    let server: import("./testChannels").LinkedChannel | null = null;
    harness.serve(3000, (channel) => {
      server = channel;
      writeAll(channel, [
        `HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${total}\r\n\r\n`,
        payload.subarray(0, 1024 * 1024),
      ]);
    });
    const seen: string[] = [];
    let received = 0;
    const done = harness.request();
    harness.watch(done.id, (message) => {
      seen.push(message.type);
      if (message.type === "response-chunk") {
        received += message.chunk.byteLength;
      }
    });
    // The head and the first megabyte arrive before the server writes the rest.
    for (let i = 0; i < 50 && received < 1024 * 1024; i++) {
      await tick(5);
    }
    expect(seen[0]).toBe("response-head");
    expect(received).toBe(1024 * 1024);
    expect(seen).not.toContain("response-end");
    writeAll(server!, pieces(payload.subarray(1024 * 1024), 64 * 1024));
    const response = await done;
    expect(response.body.length).toBe(total);
    expect(response.body).toEqual(payload);
  });

  it("injects the client and preview scripts at every position", async () => {
    harness = createGatewayHarness();
    harness.setPreviewScript("window.previewed = '</script>';");
    const scripts = [CLIENT, "window.previewed = '</script>';"];
    const cases: [string, string][] = [
      ["<!doctype html><html><head><title>x</title></head><body></body></html>", "<head>"],
      [
        '<!DOCTYPE html><html lang="en"><HEAD data-x="1"><title>x</title></HEAD></html>',
        '<HEAD data-x="1">',
      ],
      ["<!doctype html><html lang=en><header>no head</header></html>", "<html lang=en>"],
      ["<!doctype html><p>bare</p>", "<!doctype html>"],
      ["<p>fragment</p>", ""],
    ];
    for (const [html, after] of cases) {
      harness.serve(3000, (server) => {
        const body = encoder.encode(html);
        writeAll(server, [
          `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${body.length}\r\n\r\n`,
          body,
        ]);
      });
      const response = await harness.request();
      const text = decoder.decode(response.body);
      expect(text).toBe(injectScripts(html, scripts));
      const at = after === "" ? 0 : html.indexOf(after) + after.length;
      expect(text.slice(at, at + 8)).toBe("<script>");
      expect(text).toContain("window.previewed = '<\\/script>';");
      expect(header(response.headers, "content-length")).toBe(String(response.body.length));
      expect(header(response.headers, "content-type")).toBe("text/html; charset=utf-8");
    }
  });

  it("injects only the client script when the preview script is empty, and decodes the charset", async () => {
    harness = createGatewayHarness();
    // "café" in ISO-8859-1.
    const body = concat([
      encoder.encode("<html><head></head><body>caf"),
      new Uint8Array([0xe9]),
      encoder.encode("</body></html>"),
    ]);
    harness.serve(3000, (server) => {
      writeAll(server, [
        `HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=iso-8859-1\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n`,
        body,
        "\r\n0\r\n\r\n",
      ]);
    });
    const response = await harness.request();
    const text = decoder.decode(response.body);
    expect(text).toBe(injectScripts("<html><head></head><body>café</body></html>", [CLIENT]));
    expect(text.match(/<script>/g)).toHaveLength(1);
    expect(header(response.headers, "content-type")).toBe("text/html; charset=utf-8");
  });

  it("decodes gzip and deflate HTML before injecting", async () => {
    harness = createGatewayHarness();
    const html = "<!doctype html><html><head></head><body>zipped</body></html>";
    for (const format of ["gzip", "deflate"] as const) {
      const compressed = new Uint8Array(
        await new Response(
          new Blob([html]).stream().pipeThrough(new CompressionStream(format)),
        ).arrayBuffer(),
      );
      harness.serve(3000, (server) => {
        writeAll(server, [
          `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Encoding: ${format}\r\nContent-Length: ${compressed.length}\r\n\r\n`,
          ...pieces(compressed, 7),
        ]);
      });
      const response = await harness.request();
      expect(decoder.decode(response.body)).toBe(injectScripts(html, [CLIENT]));
      expect(header(response.headers, "content-encoding")).toBeNull();
      expect(header(response.headers, "content-length")).toBe(String(response.body.length));
    }
  });

  it("leaves br HTML untouched", async () => {
    harness = createGatewayHarness();
    const opaque = new Uint8Array([1, 2, 3, 4, 5]);
    harness.serve(3000, (server) => {
      writeAll(server, [
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Encoding: br\r\nContent-Length: 5\r\n\r\n",
        opaque,
      ]);
    });
    const response = await harness.request();
    expect(response.body).toEqual(opaque);
    expect(header(response.headers, "content-encoding")).toBe("br");
    expect(header(response.headers, "content-length")).toBe("5");
  });

  it("answers 502 with the client script when nothing listens", async () => {
    harness = createGatewayHarness();
    const response = await harness.request();
    expect(response.status).toBe(502);
    const text = decoder.decode(response.body);
    expect(text).toContain("No server is listening on port 3000");
    expect(text).toContain(`<script>${CLIENT.replace(/<\/(script)/gi, "<\\/$1")}</script>`);
    expect(header(response.headers, "content-type")).toBe("text/html; charset=utf-8");
    expect(header(response.headers, "cross-origin-resource-policy")).toBe("cross-origin");
  });

  it("answers 502 when the server closes before a full head", async () => {
    harness = createGatewayHarness();
    harness.serve(3000, (server) => {
      writeAll(server, ["HTTP/1.1 200 OK\r\nContent-Le"]);
      server.end();
    });
    const response = await harness.request();
    expect(response.status).toBe(502);
    expect(decoder.decode(response.body)).toContain("closed the connection");
  });

  it("answers 502 for a garbage head and errors a truncated body", async () => {
    harness = createGatewayHarness();
    harness.serve(3000, (server) => {
      writeAll(server, ["NOT HTTP\r\n\r\n"]);
    });
    expect((await harness.request()).status).toBe(502);

    harness.serve(3000, (server) => {
      writeAll(server, ["HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort"]);
      server.destroy();
    });
    const truncated = await harness.request();
    expect(truncated.status).toBe(200);
    expect(truncated.error).toMatch(/closed before/);
  });

  it("drops the connection when the service worker cancels", async () => {
    harness = createGatewayHarness();
    harness.serve(3000, (server) => {
      writeAll(server, ["HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nabc"]);
    });
    const pending = harness.request();
    const types: string[] = [];
    harness.watch(pending.id, (message) => types.push(message.type));
    for (let i = 0; i < 20 && !types.includes("response-chunk"); i++) {
      await tick(2);
    }
    expect(types).toEqual(["response-head", "response-chunk"]);
    harness.send({ type: "cancel", id: pending.id });
    await tick(10);
    expect(harness.connections[0].closed).toBe(true);
    expect(types).toEqual(["response-head", "response-chunk"]);
  });

  it("answers ping with pong", async () => {
    harness = createGatewayHarness();
    const pong = new Promise((resolve) => harness.watch(77, resolve));
    harness.send({ type: "ping", id: 77 });
    expect(await pong).toEqual({ type: "pong", id: 77 });
  });

  it("serves a port sent on a control port as one more control port of the same server", async () => {
    harness = createGatewayHarness();
    harness.serve(3000, (server) =>
      writeAll(server, ["HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"]),
    );
    // A window's spare (clientScript.ts): the window keeps the far end.
    const spare = new MessageChannel();
    const answers: FromGatewayMessage[] = [];
    spare.port1.onmessage = (event: MessageEvent<FromGatewayMessage>) => answers.push(event.data);
    harness.send({ type: "control", port: spare.port2 }, [spare.port2]);
    spare.port1.postMessage({ type: "ping", id: 0 } satisfies ToGatewayMessage);
    spare.port1.postMessage({
      type: "request",
      id: 1,
      method: "GET",
      url: "/",
      headers: [],
      body: null,
    } satisfies ToGatewayMessage);
    await tick(20);
    spare.port1.close();
    expect(answers.map((answer) => answer.type)).toEqual([
      "pong",
      "response-head",
      "response-chunk",
      "response-end",
    ]);
    expect(answers[1]).toMatchObject({ id: 1, status: 200 });
  });

  it("fails the requests in flight when it is disposed, so none hangs", async () => {
    harness = createGatewayHarness();
    harness.serve(3000, () => {
      // Never answers.
    });
    const pending = harness.request();
    await tick(5);
    harness.gateway.dispose();
    const response = await pending;
    expect(response.error).toMatch(/closed/);
  });

  it("drops a control port's requests when the service worker closes its end", async () => {
    harness = createGatewayHarness();
    harness.serve(3000, () => {});
    harness.request();
    await tick(5);
    harness.closeControlPort();
    for (let i = 0; i < 20 && !harness.connections[0]?.closed; i++) await tick(5);
    expect(harness.connections[0].closed).toBe(true);
  });

  it("lets the injected scripts past the server's Content-Security-Policy with a nonce", async () => {
    harness = createGatewayHarness();
    harness.setPreviewScript("window.preview = 1;");
    const html = "<!doctype html><html><head><title>x</title></head><body></body></html>";
    harness.serve(3000, (server) => {
      writeAll(server, [
        `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Security-Policy: default-src 'self'; script-src 'self'\r\nContent-Security-Policy-Report-Only: default-src 'none'; img-src *\r\nContent-Length: ${html.length}\r\n\r\n${html}`,
      ]);
    });
    const response = await harness.request();
    const body = decoder.decode(response.body);
    const nonces = [...body.matchAll(/<script nonce="([^"]+)">/g)].map((match) => match[1]);
    expect(nonces).toHaveLength(2);
    expect(new Set(nonces).size).toBe(1);
    const [nonce] = nonces;
    expect(header(response.headers, "content-security-policy")).toBe(
      `default-src 'self'; script-src 'self' 'nonce-${nonce}'`,
    );
    expect(header(response.headers, "content-security-policy-report-only")).toBe(
      `default-src 'nonce-${nonce}'; img-src *`,
    );
  });

  it("adds no nonce without a CSP", async () => {
    harness = createGatewayHarness();
    const html = "<html><head></head></html>";
    harness.serve(3000, (server) => {
      writeAll(server, [
        `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${html.length}\r\n\r\n${html}`,
      ]);
    });
    const body = decoder.decode((await harness.request()).body);
    expect(body).toContain("<head><script>");
  });
});

describe("allowNonceInPolicy", () => {
  it("adds the nonce where inline scripts are decided", () => {
    expect(allowNonceInPolicy("script-src 'self'", "n")).toBe("script-src 'self' 'nonce-n'");
    expect(allowNonceInPolicy("default-src 'self'", "n")).toBe("default-src 'self' 'nonce-n'");
    expect(allowNonceInPolicy("script-src-elem 'self'; script-src 'none'", "n")).toBe(
      "script-src-elem 'self' 'nonce-n'; script-src 'nonce-n'",
    );
    expect(allowNonceInPolicy("img-src *;", "n")).toBe("img-src *");
  });

  it("leaves a list that already allows any inline script alone", () => {
    expect(allowNonceInPolicy("script-src 'self' 'unsafe-inline'", "n")).toBe(
      "script-src 'self' 'unsafe-inline'",
    );
    expect(allowNonceInPolicy("script-src 'unsafe-inline' 'nonce-a'", "n")).toBe(
      "script-src 'unsafe-inline' 'nonce-a' 'nonce-n'",
    );
  });
});
