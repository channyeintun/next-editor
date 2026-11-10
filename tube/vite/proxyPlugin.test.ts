// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Connect, ViteDevServer } from "vite";
import type { ServerResponse } from "node:http";
import { checkResolvedHost, proxyPlugin, type LookupAllAddresses } from "./proxyPlugin";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function resolvesTo(...addresses: string[]): LookupAllAddresses {
  return vi.fn<LookupAllAddresses>(async () => addresses.map((address) => ({ address })));
}

describe("checkResolvedHost", () => {
  it.each([
    ["127.0.0.1"], // loopback
    ["10.1.2.3"], // private
    ["192.168.1.20"], // private
    ["169.254.169.254"], // link-local (cloud metadata)
    ["100.64.0.7"], // CGNAT
    ["::1"], // IPv6 loopback
    ["fe80::1"], // IPv6 link-local
    ["fd12:3456::1"], // IPv6 unique local
    ["::ffff:10.0.0.1"], // IPv4-mapped private
  ])("refuses a name that resolves to %s", async (address) => {
    expect(await checkResolvedHost("internal.example", resolvesTo(address))).toBe(
      "Host 'internal.example' resolves to a non-public address.",
    );
  });

  it("refuses a name when any one of its addresses is non-public", async () => {
    expect(
      await checkResolvedHost("mixed.example", resolvesTo("93.184.216.34", "127.0.0.1")),
    ).not.toBeNull();
  });

  it("accepts a name whose addresses are all public", async () => {
    expect(
      await checkResolvedHost("docs.example", resolvesTo("93.184.216.34", "2606:4700::1111")),
    ).toBeNull();
  });

  it("does not resolve address literals, which the shared rules already classified", async () => {
    const lookupAll = resolvesTo("127.0.0.1");
    expect(await checkResolvedHost("8.8.8.8", lookupAll)).toBeNull();
    expect(await checkResolvedHost("[2001:4860:4860::8888]", lookupAll)).toBeNull();
    expect(lookupAll).not.toHaveBeenCalled();
  });

  it("fails when a name resolves to nothing", async () => {
    await expect(checkResolvedHost("empty.example", resolvesTo())).rejects.toThrow(
      "No addresses found for empty.example",
    );
  });
});

describe("proxyPlugin", () => {
  function captureHandler(lookupAll: LookupAllAddresses) {
    let handler: ((req: Connect.IncomingMessage, res: ServerResponse) => void) | undefined;
    const server = {
      middlewares: {
        use: (_path: string, fn: typeof handler) => {
          handler = fn;
        },
      },
    } as unknown as ViteDevServer;
    const plugin = proxyPlugin({ lookupAll });
    (plugin.configureServer as (server: ViteDevServer) => void)(server);
    return handler!;
  }

  function call(
    handler: (req: Connect.IncomingMessage, res: ServerResponse) => void,
    target: string,
  ) {
    return new Promise<{ status: number; body: string }>((resolve) => {
      const res = {
        statusCode: 0,
        setHeader: () => undefined,
        end(body: string) {
          resolve({ status: res.statusCode, body });
        },
      };
      handler(
        { url: `/?url=${encodeURIComponent(target)}` } as Connect.IncomingMessage,
        res as unknown as ServerResponse,
      );
    });
  }

  it("refuses a name that resolves to a loopback address before fetching it", async () => {
    const fetchMock = vi.fn<() => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
    const handler = captureHandler(resolvesTo("127.0.0.1"));

    const response = await call(handler, "https://127-0-0-1.nip.io/secret");
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: "Host '127-0-0-1.nip.io' resolves to a non-public address.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
