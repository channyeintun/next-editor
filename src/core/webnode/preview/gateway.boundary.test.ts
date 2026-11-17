// @vitest-environment node
// What the gateway hands back and forth across the preview boundary: which
// responses get the client script, how the server's own origin is mapped to the
// preview's in both directions, and what an early-failing WebSocket leaves.
import { describe, expect, it } from "vitest";
import { createGatewayHarness, decoder, header, tick, writeAll } from "./gatewayTestKit";

const PAGE_HOST = "abcdefghij-3000.preview.test";

function htmlServer(h: ReturnType<typeof createGatewayHarness>, body: string) {
  return h.serve(3000, (server) =>
    writeAll(server, [
      `HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
    ]),
  );
}

describe("client script injection", () => {
  it("leaves a fetch() response alone", async () => {
    const h = createGatewayHarness();
    h.setPreviewScript("/*embedder*/");
    htmlServer(h, "Hello from the API");
    const response = await h.request({
      url: "/api",
      headers: [
        ["Sec-Fetch-Dest", "empty"],
        ["Sec-Fetch-Mode", "cors"],
      ],
    });
    expect(decoder.decode(response.body)).toBe("Hello from the API");
    expect(header(response.headers, "content-length")).toBe("18");
    h.dispose();
  });

  it("injects into a document and an iframe", async () => {
    for (const destination of ["document", "iframe"]) {
      const h = createGatewayHarness();
      h.setPreviewScript("/*embedder*/");
      htmlServer(h, "<head></head><p>hi</p>");
      const response = await h.request({
        url: "/",
        headers: [
          ["Sec-Fetch-Dest", destination],
          ["Sec-Fetch-Mode", "navigate"],
        ],
      });
      expect(decoder.decode(response.body)).toContain("/*embedder*/");
      h.dispose();
    }
  });

  it("injects when the request does not say what it is for (an older service worker)", async () => {
    const h = createGatewayHarness();
    h.setPreviewScript("/*embedder*/");
    htmlServer(h, "<p>hi</p>");
    const response = await h.request({ url: "/" });
    expect(decoder.decode(response.body)).toContain("/*embedder*/");
    h.dispose();
  });
});

describe("the server's own origin", () => {
  it("maps an absolute redirect to the server's origin onto the preview", async () => {
    const h = createGatewayHarness();
    for (const location of [
      "http://localhost:3000/x?y=1#z",
      "http://127.0.0.1:3000/x?y=1#z",
      "//localhost:3000/x?y=1#z",
    ]) {
      h.serve(3000, (server) =>
        writeAll(server, [
          `HTTP/1.1 302 Found\r\nLocation: ${location}\r\nContent-Length: 0\r\n\r\n`,
        ]),
      );
      const response = await h.request({ url: "/" });
      expect(header(response.headers, "location")).toBe("/x?y=1#z");
    }
    h.dispose();
  });

  it("leaves relative redirects and other hosts alone", async () => {
    const h = createGatewayHarness();
    for (const location of ["/login", "https://example.com/", "http://localhost:4000/x"]) {
      h.serve(3000, (server) =>
        writeAll(server, [
          `HTTP/1.1 302 Found\r\nLocation: ${location}\r\nContent-Length: 0\r\n\r\n`,
        ]),
      );
      const response = await h.request({ url: "/" });
      expect(header(response.headers, "location")).toBe(location);
    }
    h.dispose();
  });

  it("maps a Refresh URL too", async () => {
    const h = createGatewayHarness();
    h.serve(3000, (server) =>
      writeAll(server, [
        "HTTP/1.1 200 OK\r\nRefresh: 0; url=http://localhost:3000/next\r\nContent-Length: 0\r\n\r\n",
      ]),
    );
    const response = await h.request({ url: "/" });
    expect(header(response.headers, "refresh")).toBe("0; url=/next");
    h.dispose();
  });

  it("restates the page's Origin and Referer as the server's own", async () => {
    const h = createGatewayHarness();
    const received = h.serve(3000, (server) =>
      writeAll(server, ["HTTP/1.1 204 No Content\r\n\r\n"]),
    );
    await h.request({
      method: "POST",
      url: "/login",
      pageHost: PAGE_HOST,
      headers: [
        ["Origin", `https://${PAGE_HOST}`],
        ["Referer", `https://${PAGE_HOST}/form?a=1`],
      ],
      body: new TextEncoder().encode("x"),
    });
    expect(header(received[0].headers, "host")).toBe("localhost:3000");
    expect(header(received[0].headers, "origin")).toBe("http://localhost:3000");
    expect(header(received[0].headers, "referer")).toBe("http://localhost:3000/form?a=1");
    h.dispose();
  });

  it("passes another site's Origin through", async () => {
    const h = createGatewayHarness();
    const received = h.serve(3000, (server) =>
      writeAll(server, ["HTTP/1.1 204 No Content\r\n\r\n"]),
    );
    await h.request({
      method: "POST",
      url: "/",
      pageHost: PAGE_HOST,
      headers: [["Origin", "https://evil.example"]],
      body: new TextEncoder().encode("x"),
    });
    expect(header(received[0].headers, "origin")).toBe("https://evil.example");
    h.dispose();
  });
});

describe("WebSockets", () => {
  it("an early-failing socket throws nothing in the kernel and is not kept", async () => {
    const errors: unknown[] = [];
    const onRejection = (error: unknown) => errors.push(error);
    process.on("unhandledRejection", onRejection);
    const h = createGatewayHarness();
    const channel = new MessageChannel();
    const events: { type: string; code?: number }[] = [];
    channel.port2.onmessage = (event) => events.push(event.data);
    h.send(
      {
        type: "ws-connect",
        url: "ws://localhost:0/",
        protocols: [],
        pageHost: PAGE_HOST,
        port: channel.port1,
      },
      [channel.port1],
    );
    await tick(20);
    process.off("unhandledRejection", onRejection);
    expect(errors).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["error", "close"]);
    expect(h.gateway.openSockets).toBe(0);
    h.dispose();
    channel.port2.close();
  });

  it("carries the preview's cookies on the handshake", async () => {
    const h = createGatewayHarness();
    const received = h.serve(3000, () => {});
    const channel = new MessageChannel();
    h.send(
      {
        type: "ws-connect",
        url: `wss://${PAGE_HOST}/ws`,
        protocols: [],
        pageHost: PAGE_HOST,
        cookie: "sid=abc",
        port: channel.port1,
      },
      [channel.port1],
    );
    await tick(20);
    expect(header(received[0].headers, "cookie")).toBe("sid=abc");
    h.dispose();
    channel.port2.close();
  });
});
