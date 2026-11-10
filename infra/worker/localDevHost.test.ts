import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { default: app } = await import("./index");

afterEach(() => {
  vi.unstubAllGlobals();
});

const env = { PUBLIC_URL: "https://nexteditor.dev" } as never;

describe("local development Host allowlist", () => {
  it.each([
    "http://rebind.attacker.test:8787/api/health",
    "http://rebind.attacker.test:8787/api/proxy?url=https%3A%2F%2Finternal.example%2F",
    // A name that resolves to loopback is still not a loopback name.
    "http://127-0-0-1.nip.io:8787/api/health",
  ])("refuses a plaintext request to a foreign host: %s", async (url) => {
    const fetchMock = vi.fn<() => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request(url, {}, env);

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "http://localhost:8787/api/health",
    "http://127.0.0.1:8787/api/health",
    "http://[::1]:8787/api/health",
    // The plaintext form of the PUBLIC_URL host, as production may see it.
    "http://nexteditor.dev/api/health",
    // TLS already binds the name, so https traffic is never touched.
    "https://nexteditor.dev/api/health",
  ])("serves %s", async (url) => {
    const response = await app.request(url, {}, env);

    expect(response.status).toBe(200);
  });

  it("serves the PUBLIC_URL host a developer configured for local work", async () => {
    const response = await app.request("http://dev.example.test:8787/api/health", {}, {
      PUBLIC_URL: "http://dev.example.test:8787",
    } as never);

    expect(response.status).toBe(200);
  });

  it("is what dev:worker runs: wrangler dev passes the real Host through", () => {
    // By default wrangler dev rewrites every request to the first route's
    // origin (http://nexteditor.dev) before the Worker sees it, so a
    // rebinding Host would look like the PUBLIC_URL host and pass.
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts["dev:worker"]).toContain("--infer-origin-from-routes=false");
  });
});
