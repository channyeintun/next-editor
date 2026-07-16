import { describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { publishCollaborationMaintenanceJob, verifyQStashSignature } from "./qstash";

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function encodeJson(value: unknown): string {
  return encode(new TextEncoder().encode(JSON.stringify(value)));
}

async function sign(input: {
  key: string;
  body: string;
  url: string;
  now: number;
  expiresAt?: number;
}): Promise<string> {
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const bodyHash = encode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.body))),
  );
  const payload = encodeJson({
    iss: "Upstash",
    sub: input.url,
    iat: input.now,
    nbf: input.now,
    exp: input.expiresAt ?? input.now + 60,
    body: bodyHash,
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${encode(new Uint8Array(signature))}`;
}

describe("QStash collaboration job verification", () => {
  const current = "current-signing-key";
  const next = "next-signing-key";
  const body = '{"kind":"compact-room"}';
  const url = "https://nexteditor.dev/api/collaboration/jobs/maintenance";
  const now = 1_800_000_000;

  it("accepts current and next signing keys", async () => {
    for (const key of [current, next]) {
      const signature = await sign({ key, body, url, now });
      await expect(
        verifyQStashSignature({
          signature,
          body,
          url,
          currentSigningKey: current,
          nextSigningKey: next,
          nowSeconds: now,
        }),
      ).resolves.toBe(true);
    }
  });

  it("binds a signed job to its exact raw body and destination", async () => {
    const signature = await sign({ key: current, body, url, now });
    await expect(
      verifyQStashSignature({
        signature,
        body: `${body} `,
        url,
        currentSigningKey: current,
        nextSigningKey: next,
        nowSeconds: now,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyQStashSignature({
        signature,
        body,
        url: `${url}/other`,
        currentSigningKey: current,
        nextSigningKey: next,
        nowSeconds: now,
      }),
    ).resolves.toBe(false);
  });

  it("rejects expired deliveries", async () => {
    const signature = await sign({ key: current, body, url, now, expiresAt: now - 10 });
    await expect(
      verifyQStashSignature({
        signature,
        body,
        url,
        currentSigningKey: current,
        nextSigningKey: next,
        nowSeconds: now,
      }),
    ).resolves.toBe(false);
  });

  it("publishes only bounded maintenance metadata with a stable deduplication ID", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('{"messageId":"msg_1"}', { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const roomId = "10000000-0000-4000-8000-000000000001";
    await expect(
      publishCollaborationMaintenanceJob(
        {
          PUBLIC_URL: "https://nexteditor.dev",
          QSTASH_TOKEN: "qstash-token",
        } as Env,
        { kind: "compact-room", roomId, expectedGeneration: 4 },
      ),
    ).resolves.toBe(true);

    const [requestUrl, request] = fetchMock.mock.calls[0];
    expect(requestUrl).toBe(
      "https://qstash.upstash.io/v2/publish/https://nexteditor.dev/api/collaboration/jobs/maintenance",
    );
    const headers = new Headers(request?.headers);
    expect(headers.get("Authorization")).toBe("Bearer qstash-token");
    expect(headers.get("Upstash-Deduplication-Id")).toBe(
      `collab-compact-${roomId}-4`,
    );
    expect(request?.body).toBe(
      JSON.stringify({ kind: "compact-room", roomId, expectedGeneration: 4 }),
    );
    vi.unstubAllGlobals();
  });
});
