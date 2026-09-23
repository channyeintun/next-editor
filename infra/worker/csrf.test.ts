import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { default: app } = await import("./index");

const env = { DB: {} as D1Database } as never;

function postOneTap(headers: Record<string, string>) {
  return app.request(
    "https://nexteditor.dev/api/auth/google/onetap",
    // What an auto-submitted <form enctype="text/plain"> on another site sends.
    { method: "POST", headers, body: '{"credential":"attacker-id-token","x":"="}' },
    env,
  );
}

describe("worker CSRF guard", () => {
  it("refuses a cross-site form post before any route runs", async () => {
    const response = await postOneTap({
      "content-type": "text/plain",
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    });

    expect(response.status).toBe(403);
  });

  it("lets the same form-shaped request through from the app itself", async () => {
    const response = await postOneTap({
      "content-type": "text/plain",
      origin: "https://nexteditor.dev",
      "sec-fetch-site": "same-origin",
    });

    expect(response.status).not.toBe(403);
  });

  it("lets JSON through, which a cross-site page cannot send without CORS", async () => {
    const response = await postOneTap({
      "content-type": "application/json",
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    });

    expect(response.status).not.toBe(403);
  });
});
