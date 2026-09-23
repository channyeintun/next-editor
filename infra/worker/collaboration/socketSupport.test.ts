import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { randomToken, sha256Hex } from "./bytes";
import { ConnectionQuota, decodeHeaderJson, encodeHeaderJson } from "./socketSupport";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("canonical session headers", () => {
  const schema = z.object({ userId: z.string(), name: z.string() }).strict();

  it("reads back what the Worker encoded, including non-ASCII text", () => {
    const request = new Request("https://room.internal", {
      headers: { "X-Session": encodeHeaderJson(schema, { userId: "u1", name: "Zoë" }) },
    });
    expect(decodeHeaderJson(schema, request, "X-Session")).toEqual({ userId: "u1", name: "Zoë" });
  });

  it("returns null for a missing, undecodable or non-matching header", () => {
    const withHeader = (value: string) =>
      new Request("https://room.internal", { headers: { "X-Session": value } });
    expect(decodeHeaderJson(schema, new Request("https://room.internal"), "X-Session")).toBeNull();
    expect(decodeHeaderJson(schema, withHeader("%E0%A4%A"), "X-Session")).toBeNull();
    expect(decodeHeaderJson(schema, withHeader("not-json"), "X-Session")).toBeNull();
    expect(
      decodeHeaderJson(schema, withHeader(encodeURIComponent('{"userId":"u1"}')), "X-Session"),
    ).toBeNull();
  });
});

describe("ConnectionQuota", () => {
  it("allows each user a budget per minute and starts over the next minute", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(60_000);
    const quota = new ConnectionQuota(2);

    expect([quota.consume("a"), quota.consume("a"), quota.consume("a")]).toEqual([
      true,
      true,
      false,
    ]);
    expect(quota.consume("b")).toBe(true);
    now.mockReturnValue(120_000);
    expect(quota.consume("a")).toBe(true);
  });
});

describe("tokens", () => {
  it("hashes a string as its UTF-8 bytes", async () => {
    expect(await sha256Hex("hello")).toBe(await sha256Hex(new TextEncoder().encode("hello")));
  });

  it("makes 32-byte base64url tokens", () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(token);
  });
});
