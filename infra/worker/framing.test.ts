import { describe, expect, it, vi } from "vite-plus/test";
import { frameAncestorsPolicy, isSameSiteFraming } from "./framing";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { default: app } = await import("./index");

const page = "<!doctype html><title>Next Editor</title>";
const env = {
  PUBLIC_URL: "https://nexteditor.dev",
  ASSETS: {
    fetch: async () => new Response(page, { headers: { "content-type": "text/html" } }),
  },
} as never;

function load(path: string, site: string, destination: string) {
  return app.request(
    `https://nexteditor.dev${path}`,
    { headers: { "sec-fetch-site": site, "sec-fetch-dest": destination } },
    env,
  );
}

describe("framing the app from another origin of its own site", () => {
  it.each(["iframe", "frame", "embed", "object", "fencedframe"])(
    "refuses a same-site %s, which would be signed in",
    async (destination) => {
      // A lesson's page on <session>-<port>.nexteditor.dev framing the editor.
      const response = await load("/api/health", "same-site", destination);
      expect(response.status).toBe(403);
    },
  );

  it("refuses the lesson pages too: only another site may embed them", async () => {
    const response = await load("/learn/kite-crash-course?embed=true", "same-site", "iframe");
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("Next Editor</title>");
  });

  it.each([
    // The landing page's own demo frame.
    ["same-origin", "iframe"],
    // kite-lang.dev embedding a lesson: no session cookie reaches it.
    ["cross-site", "iframe"],
    // Opened by the visitor, or followed from a link on a preview page.
    ["none", "document"],
    ["same-site", "document"],
    // A preview page's image or fetch: not a frame.
    ["same-site", "image"],
    ["same-site", "empty"],
  ])("serves a %s request for a %s", async (site, destination) => {
    const response = await load("/api/health", site, destination);
    expect(response.status).toBe(200);
  });

  it("serves a browser that sends no fetch metadata", async () => {
    const response = await app.request("https://nexteditor.dev/api/health", {}, env);
    expect(response.status).toBe(200);
  });

  it("tells same-site framing from every other request", () => {
    const request = (headers: Record<string, string>) =>
      new Request("https://nexteditor.dev/code", { headers });
    expect(
      isSameSiteFraming(request({ "sec-fetch-site": "same-site", "sec-fetch-dest": "iframe" })),
    ).toBe(true);
    expect(isSameSiteFraming(request({ "sec-fetch-site": "same-site" }))).toBe(false);
    expect(isSameSiteFraming(request({ "sec-fetch-dest": "iframe" }))).toBe(false);
    expect(isSameSiteFraming(request({}))).toBe(false);
  });
});

describe("the frame-ancestors policy on the app's pages", () => {
  it("keeps every page but the embeddable ones to this origin's frames", () => {
    for (const path of ["/", "/code", "/studio", "/settings", "/learner", "/learning"]) {
      expect(frameAncestorsPolicy(path)).toBe("frame-ancestors 'self'");
    }
    for (const path of ["/learn", "/learn/", "/learn/kite-crash-course", "/learn/playlist/x"]) {
      expect(frameAncestorsPolicy(path)).toBeNull();
    }
  });

  it("is sent with a page, beside the isolation headers", async () => {
    const response = await app.request("https://nexteditor.dev/code", {}, env);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
  });

  it("is not sent with anything that is not a page", async () => {
    const response = await app.request("https://nexteditor.dev/api/health", {}, env);
    expect(response.headers.get("content-security-policy")).toBeNull();
  });
});
