import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import {
  COLLABORATION_CLEANUP_DELAY,
  publishCollaborationMaintenanceJob,
  verifyQStashSignature,
} from "./qstash";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("QStash collaboration job verification", () => {
  const current = "current-signing-key";
  const next = "next-signing-key";
  const body = '{"kind":"cleanup-room"}';
  const url = "https://nexteditor.dev/api/collaboration/jobs/maintenance";

  it("accepts signatures made with either configured signing key", async () => {
    const now = Math.floor(Date.now() / 1_000);
    for (const key of [current, next]) {
      const signature = await sign({ key, body, url, now });
      await expect(
        verifyQStashSignature({
          signature,
          body,
          url,
          currentSigningKey: current,
          nextSigningKey: next,
        }),
      ).resolves.toBe(true);
    }
  });

  it("binds a signed job to its exact raw body and destination", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const signature = await sign({ key: current, body, url, now });
    await expect(
      verifyQStashSignature({
        signature,
        body: `${body} `,
        url,
        currentSigningKey: current,
        nextSigningKey: next,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyQStashSignature({
        signature,
        body,
        url: `${url}/other`,
        currentSigningKey: current,
        nextSigningKey: next,
      }),
    ).resolves.toBe(false);
  });

  it("rejects expired deliveries", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const signature = await sign({ key: current, body, url, now, expiresAt: now - 10 });
    await expect(
      verifyQStashSignature({
        signature,
        body,
        url,
        currentSigningKey: current,
        nextSigningKey: next,
      }),
    ).resolves.toBe(false);
  });

  it("does not enqueue jobs unless publishing and receiver credentials are complete", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      publishCollaborationMaintenanceJob(
        {
          PUBLIC_URL: "https://nexteditor.dev",
          QSTASH_TOKEN: "qstash-token",
        } as Env,
        {
          kind: "cleanup-room",
          roomId: "10000000-0000-4000-8000-000000000001",
          closedAt: 4,
        },
      ),
    ).resolves.toEqual({
      queued: false,
      missing: ["QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY"],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("publishes redacted JSON through the SDK with free-tier-compatible cleanup delay", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{"messageId":"msg_1"}', { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const roomId = "10000000-0000-4000-8000-000000000001";
    const closedAt = 1_800_000_000_000;

    await expect(
      publishCollaborationMaintenanceJob(
        {
          PUBLIC_URL: "https://nexteditor.dev",
          QSTASH_TOKEN: "qstash-token",
          QSTASH_CURRENT_SIGNING_KEY: current,
          QSTASH_NEXT_SIGNING_KEY: next,
        } as Env,
        { kind: "cleanup-room", roomId, closedAt },
        { delay: COLLABORATION_CLEANUP_DELAY },
      ),
    ).resolves.toEqual({ queued: true, messageId: "msg_1", deduplicated: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("QStash SDK did not publish the maintenance job");
    const [requestUrl, request] = call;
    expect(requestUrl).toBe(
      "https://qstash.upstash.io/v2/publish/https://nexteditor.dev/api/collaboration/jobs/maintenance",
    );
    const headers = new Headers(request?.headers);
    expect(headers.get("Authorization")).toBe("Bearer qstash-token");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Upstash-Deduplication-Id")).toBe(`collab-cleanup-${roomId}-${closedAt}`);
    expect(headers.get("Upstash-Delay")).toBe("7d");
    expect(headers.get("Upstash-Retries")).toBe("3");
    expect(headers.get("Upstash-Timeout")).toBe("30s");
    expect(headers.get("Upstash-Redact-Fields")).toBe("body");
    expect(headers.get("Upstash-Label")).toBe("collaboration-maintenance,cleanup-room");
    expect(request?.body).toBe(JSON.stringify({ kind: "cleanup-room", roomId, closedAt }));
  });
});
