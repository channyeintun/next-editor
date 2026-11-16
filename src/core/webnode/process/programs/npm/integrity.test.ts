// @vitest-environment node
import { describe, expect, it } from "vitest";
import { integrityOf, verifyIntegrity } from "./integrity";

const bytes = new TextEncoder().encode("hello tarball");

async function sha1Hex(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-1", data as Uint8Array<ArrayBuffer>),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("verifyIntegrity", () => {
  it("accepts a matching sha512", async () => {
    expect(await verifyIntegrity(bytes, await integrityOf(bytes), undefined)).toEqual({
      ok: true,
      algorithm: "sha512",
    });
  });

  it("rejects a mismatch", async () => {
    const other = await integrityOf(new TextEncoder().encode("other"));
    const result = await verifyIntegrity(bytes, other, undefined);
    expect(result.ok).toBe(false);
  });

  it("uses the strongest algorithm listed", async () => {
    const sha512 = await integrityOf(bytes);
    const result = await verifyIntegrity(bytes, `sha1-bogus ${sha512}`, undefined);
    expect(result).toEqual({ ok: true, algorithm: "sha512" });
  });

  it("falls back to the sha1 shasum", async () => {
    const shasum = await sha1Hex(bytes);
    expect(await verifyIntegrity(bytes, undefined, shasum)).toEqual({
      ok: true,
      algorithm: "sha1",
    });
    expect((await verifyIntegrity(bytes, undefined, "00".repeat(20))).ok).toBe(false);
  });

  it("reports nothing to verify against", async () => {
    expect(await verifyIntegrity(bytes, undefined, undefined)).toEqual({
      ok: true,
      algorithm: null,
    });
  });
});
