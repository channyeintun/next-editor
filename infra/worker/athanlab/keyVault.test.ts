import { describe, expect, it } from "vite-plus/test";
import {
  ATHANLAB_KEY_VERSION,
  keyVaultOf,
  openApiKey,
  sealApiKey,
  type KeyVault,
} from "./keyVault";

const SECRET = btoa(String.fromCharCode(...new Uint8Array(32).map((_, index) => index + 1)));
const OTHER_SECRET = btoa(
  String.fromCharCode(...new Uint8Array(32).map((_, index) => 200 - index)),
);
const API_KEY = "ak_live_0123456789abcdef0123456789ABCDEF";
// What WebCrypto rejects with when AES-GCM authentication fails.
const DECRYPT_FAILED = { name: "OperationError" };

function vaultOf(secret: string): KeyVault {
  const vault = keyVaultOf({ ATHANLAB_KEY_ENCRYPTION_SECRET: secret });
  if (!vault) throw new Error("expected a vault");
  return vault;
}

function rowOf(sealed: { ciphertext: string; iv: string; keyVersion: number }) {
  return { ciphertext: sealed.ciphertext, iv: sealed.iv, key_version: sealed.keyVersion };
}

describe("keyVaultOf", () => {
  it("accepts base64 of exactly 32 bytes, surrounding whitespace allowed", () => {
    expect(keyVaultOf({ ATHANLAB_KEY_ENCRYPTION_SECRET: SECRET })).not.toBeNull();
    expect(keyVaultOf({ ATHANLAB_KEY_ENCRYPTION_SECRET: `  ${SECRET}\n` })).not.toBeNull();
  });

  it("fails closed without a usable secret", () => {
    for (const secret of [
      undefined,
      "",
      "not base64 at all!",
      btoa("x".repeat(31)),
      btoa("x".repeat(33)),
      // 32 bytes of hex is a 64-character string, not a 32-byte key.
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      `${SECRET.slice(0, 20)}*${SECRET.slice(21)}`,
    ]) {
      expect(keyVaultOf({ ATHANLAB_KEY_ENCRYPTION_SECRET: secret })).toBeNull();
    }
  });

  it("reuses the imported key for the same secret", () => {
    expect(vaultOf(SECRET)).toBe(vaultOf(SECRET));
  });
});

describe("sealApiKey / openApiKey", () => {
  it("round-trips a key without ever storing it in the clear", async () => {
    const vault = vaultOf(SECRET);

    const sealed = await sealApiKey(vault, "user-1", API_KEY);

    expect(sealed.keyVersion).toBe(ATHANLAB_KEY_VERSION);
    expect(atob(sealed.iv)).toHaveLength(12);
    expect(sealed.ciphertext).not.toContain(API_KEY);
    expect(atob(sealed.ciphertext)).not.toContain("ak_live_");
    expect(await openApiKey(vault, "user-1", rowOf(sealed))).toBe(API_KEY);
  });

  it("draws a fresh nonce for every seal", async () => {
    const vault = vaultOf(SECRET);

    const first = await sealApiKey(vault, "user-1", API_KEY);
    const second = await sealApiKey(vault, "user-1", API_KEY);

    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("binds a ciphertext to the user who stored it", async () => {
    const vault = vaultOf(SECRET);
    const sealed = await sealApiKey(vault, "user-1", API_KEY);

    await expect(openApiKey(vault, "user-2", rowOf(sealed))).rejects.toMatchObject(DECRYPT_FAILED);
  });

  it("binds a ciphertext to its key version", async () => {
    const vault = vaultOf(SECRET);
    const sealed = await sealApiKey(vault, "user-1", API_KEY);

    await expect(openApiKey(vault, "user-1", { ...rowOf(sealed), key_version: 2 })).rejects.toThrow(
      "unsupported AthanLab key version",
    );
  });

  it("does not open under another secret", async () => {
    const sealed = await sealApiKey(vaultOf(SECRET), "user-1", API_KEY);

    await expect(openApiKey(vaultOf(OTHER_SECRET), "user-1", rowOf(sealed))).rejects.toMatchObject(
      DECRYPT_FAILED,
    );
  });

  it("rejects a tampered ciphertext or nonce", async () => {
    const vault = vaultOf(SECRET);
    const sealed = await sealApiKey(vault, "user-1", API_KEY);
    const bytes = Uint8Array.from(atob(sealed.ciphertext), (char) => char.charCodeAt(0));
    bytes[0] ^= 1;
    const flipped = btoa(String.fromCharCode(...bytes));

    await expect(
      openApiKey(vault, "user-1", { ...rowOf(sealed), ciphertext: flipped }),
    ).rejects.toMatchObject(DECRYPT_FAILED);
    await expect(
      openApiKey(vault, "user-1", { ...rowOf(sealed), iv: btoa("short") }),
    ).rejects.toThrow("malformed AthanLab key nonce");
    await expect(
      openApiKey(vault, "user-1", { ...rowOf(sealed), ciphertext: "not base64!" }),
    ).rejects.toMatchObject({ name: "InvalidCharacterError" });
  });
});
