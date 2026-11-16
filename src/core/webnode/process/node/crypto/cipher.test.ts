// @vitest-environment node
// Differential tests for AES-CBC/CTR/GCM: every ciphertext, tag, plaintext and
// error is compared with Node's own `node:crypto`.
import * as nodeCrypto from "node:crypto";
import { Buffer as NodeBuffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createCipheriv, createDecipheriv, getCipherInfo, getCiphers } from "./cipher";

function bytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

function hex(value: unknown): string {
  return typeof value === "string"
    ? `s:${value}`
    : NodeBuffer.from(value as Uint8Array).toString("hex");
}

function errorOf(fn: () => unknown): Record<string, unknown> | null {
  try {
    fn();
  } catch (error) {
    const e = error as Error & { code?: string; library?: string; reason?: string };
    return { name: e.name, code: e.code, message: e.message, library: e.library, reason: e.reason };
  }
  return null;
}

function sameError(ours: () => unknown, theirs: () => unknown): void {
  const expected = errorOf(theirs);
  expect(expected).not.toBeNull();
  expect(errorOf(ours)).toEqual(expected);
}

const SIZES = [0, 1, 15, 16, 17, 31, 32, 33, 100, 4096 + 7];
const SPLITS = [1, 5, 16, 17, 1000];

type AnyCipher = {
  update(data: Uint8Array): Uint8Array | string;
  final(): Uint8Array | string;
};

function run(cipher: AnyCipher, data: Uint8Array, split: number): string {
  const parts: string[] = [];
  for (let offset = 0; offset < data.length; offset += split) {
    parts.push(hex(cipher.update(data.subarray(offset, offset + split))));
  }
  parts.push(hex(cipher.final()));
  return parts.join("");
}

describe("AES vs node", () => {
  for (const bits of [128, 192, 256]) {
    for (const mode of ["cbc", "ctr"]) {
      const name = `aes-${bits}-${mode}`;
      it(`${name} encrypts and decrypts like node`, () => {
        const key = bytes(bits / 8, bits);
        const iv = bytes(16, 77);
        for (const size of SIZES) {
          const data = bytes(size, size + 3);
          for (const split of SPLITS) {
            const ours = run(createCipheriv(name, key, iv), data, split);
            const theirs = run(nodeCrypto.createCipheriv(name, key, iv), data, split);
            expect(`${size}/${split} ${ours}`).toBe(`${size}/${split} ${theirs}`);
            const cipherBytes = NodeBuffer.from(theirs, "hex");
            expect(run(createDecipheriv(name, key, iv), cipherBytes, split)).toBe(
              run(nodeCrypto.createDecipheriv(name, key, iv), cipherBytes, split),
            );
          }
        }
      });
    }

    it(`aes-${bits}-cbc without auto padding matches node`, () => {
      const key = bytes(bits / 8, 5);
      const iv = bytes(16, 6);
      const data = bytes(64, 8);
      const ours = createCipheriv(`aes-${bits}-cbc`, key, iv).setAutoPadding(false);
      const theirs = nodeCrypto.createCipheriv(`aes-${bits}-cbc`, key, iv).setAutoPadding(false);
      const encrypted = run(theirs, data, 7);
      expect(run(ours, data, 7)).toBe(encrypted);
      const decipher = createDecipheriv(`aes-${bits}-cbc`, key, iv).setAutoPadding(false);
      expect(run(decipher, NodeBuffer.from(encrypted, "hex"), 16)).toBe(hex(data));
    });

    it(`aes-${bits}-gcm matches node's ciphertext and tag, with AAD and odd IVs`, () => {
      const name = `aes-${bits}-gcm` as nodeCrypto.CipherGCMTypes;
      const key = bytes(bits / 8, bits + 1);
      for (const ivLength of [12, 1, 8, 16, 60]) {
        const iv = bytes(ivLength, ivLength);
        for (const size of [0, 1, 16, 33, 1000]) {
          for (const aad of [null, bytes(5, 2), bytes(16, 3), bytes(70, 4)]) {
            for (const authTagLength of [undefined, 4, 8, 12, 13, 16]) {
              const options = authTagLength === undefined ? undefined : { authTagLength };
              const data = bytes(size, size);
              const ours = createCipheriv(name, key, iv, options);
              const theirs = nodeCrypto.createCipheriv(name, key, iv, options);
              if (aad) {
                ours.setAAD(aad.subarray(0, 3));
                ours.setAAD(aad.subarray(3));
                theirs.setAAD(aad);
              }
              const label = `${ivLength}/${size}/${aad?.length}/${authTagLength}`;
              const encrypted = run(theirs, data, 7);
              expect(`${label} ${run(ours, data, 7)}`).toBe(`${label} ${encrypted}`);
              const tag = theirs.getAuthTag();
              expect(`${label} ${hex(ours.getAuthTag())}`).toBe(`${label} ${hex(tag)}`);

              const decipher = createDecipheriv(name, key, iv, options);
              decipher.setAuthTag(tag);
              if (aad) {
                decipher.setAAD(aad);
              }
              expect(`${label} ${run(decipher, NodeBuffer.from(encrypted, "hex"), 9)}`).toBe(
                `${label} ${hex(data)}`,
              );
            }
          }
        }
      }
    });
  }

  it("accepts OpenSSL aliases and case", () => {
    const key = bytes(16);
    const iv = bytes(16, 2);
    for (const name of ["AES-128-CBC", "aes128", "id-aes128-GCM"]) {
      const ivFor = name.toLowerCase().includes("gcm") ? iv.subarray(0, 12) : iv;
      expect(run(createCipheriv(name, key, ivFor), bytes(20), 20)).toBe(
        run(nodeCrypto.createCipheriv(name, key, ivFor), bytes(20), 20),
      );
    }
  });

  it("encodes string input and output like node, across updates", () => {
    const key = bytes(32);
    const iv = bytes(16, 4);
    for (const outputEncoding of ["hex", "base64", "base64url", "latin1"] as const) {
      const ours = createCipheriv("aes-256-cbc", key, iv);
      const theirs = nodeCrypto.createCipheriv("aes-256-cbc", key, iv);
      const mine =
        (ours.update(
          "héllo wörld, this is longer than a block",
          "utf8",
          outputEncoding,
        ) as string) +
        (ours.update("more", "latin1", outputEncoding) as string) +
        (ours.final(outputEncoding) as string);
      const node =
        theirs.update("héllo wörld, this is longer than a block", "utf8", outputEncoding) +
        theirs.update("more", "latin1", outputEncoding) +
        theirs.final(outputEncoding);
      expect(mine).toBe(node);
    }
    const encrypted = nodeCrypto
      .createCipheriv("aes-256-ctr", key, iv)
      .update("✓ unicode ✓", "utf8");
    const ours = createDecipheriv("aes-256-ctr", key, iv);
    let text = "";
    for (const byte of encrypted) {
      text += ours.update(new Uint8Array([byte]), undefined, "utf8") as string;
    }
    text += ours.final("utf8") as string;
    expect(text).toBe("✓ unicode ✓");
  });

  it("works as a Transform stream", async () => {
    const key = bytes(16);
    const iv = bytes(16, 9);
    const cipher = createCipheriv("aes-128-cbc", key, iv);
    const chunks: Uint8Array[] = [];
    cipher.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    const done = new Promise((resolve) => cipher.on("end", resolve));
    cipher.write(bytes(10));
    cipher.end(bytes(30, 2));
    await done;
    const expected = nodeCrypto.createCipheriv("aes-128-cbc", key, iv);
    expect(NodeBuffer.concat(chunks).toString("hex")).toBe(
      NodeBuffer.concat([
        expected.update(bytes(10)),
        expected.update(bytes(30, 2)),
        expected.final(),
      ]).toString("hex"),
    );
  });

  it("raises node's errors", () => {
    expect.hasAssertions();
    const k = bytes(16, 1);
    const iv = bytes(16, 2);
    const iv12 = iv.subarray(0, 12);
    type Factory = typeof createCipheriv;
    const both = (fn: (create: Factory, decreate: typeof createDecipheriv) => unknown) =>
      sameError(
        () => fn(createCipheriv, createDecipheriv),
        () => fn(nodeCrypto.createCipheriv as never, nodeCrypto.createDecipheriv as never),
      );
    both((c) => c("nope", k, iv));
    both((c) => c(5, k, iv));
    both((c) => c("aes-128-cbc", bytes(5), iv));
    both((c) => c("aes-128-cbc", 5, iv));
    both((c) => c("aes-128-cbc", k, bytes(5)));
    both((c) => c("aes-128-cbc", k, 5));
    both((c) => c("aes-128-cbc", k, null));
    both((c) => c("aes-128-ctr", k, iv12));
    both((c) => c("aes-128-gcm", k, new Uint8Array(0)));
    both((c) => c("aes-128-gcm", k, iv12, { authTagLength: 7 }));
    both((c) => c("aes-128-gcm", k, iv12, { authTagLength: 7.5 }));
    both((c) => {
      const x = c("aes-128-cbc", k, iv);
      x.setAutoPadding(false);
      x.update(bytes(3));
      return x.final();
    });
    both((_, d) => {
      const x = d("aes-128-cbc", k, iv);
      x.update(bytes(16));
      return x.final();
    });
    both((_, d) => {
      const x = d("aes-128-cbc", k, iv);
      x.update(bytes(5));
      return x.final();
    });
    both((c) => {
      const x = c("aes-128-cbc", k, iv);
      x.final();
      return x.final();
    });
    both((c) => {
      const x = c("aes-128-cbc", k, iv);
      x.final();
      return x.update(bytes(1));
    });
    both((c) => c("aes-128-cbc", k, iv).update(5 as never));
    both((c) => c("aes-128-cbc", k, iv).update("abc", "hex"));
    both((c) => (c("aes-128-gcm", k, iv12) as unknown as { getAuthTag(): unknown }).getAuthTag());
    both((c) => {
      const x = c("aes-128-cbc", k, iv);
      x.final();
      return (x as unknown as { getAuthTag(): unknown }).getAuthTag();
    });
    both((_, d) => {
      const x = d("aes-128-gcm", k, iv12);
      x.setAuthTag(bytes(16));
      x.update(bytes(2));
      return x.final();
    });
    both((_, d) => {
      const x = d("aes-128-gcm", k, iv12);
      x.update(bytes(2));
      return x.final();
    });
    both((_, d) => d("aes-128-gcm", k, iv12).setAuthTag(bytes(3)));
    both((_, d) => d("aes-128-gcm", k, iv12, { authTagLength: 8 }).setAuthTag(bytes(16)));
    both((_, d) => d("aes-128-cbc", k, iv).setAuthTag(bytes(16)));
    both((c) => c("aes-128-cbc", k, iv).setAAD(bytes(16)));
    both((c) => c("aes-128-cbc", k, iv).update(bytes(1), undefined, "bogus"));
  });

  it("detects a tampered ciphertext, tag and AAD", () => {
    const key = bytes(32);
    const iv = bytes(12, 3);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(bytes(10));
    const encrypted = cipher.update(bytes(40, 5)) as Uint8Array;
    cipher.final();
    const tag = cipher.getAuthTag();
    const attempt = (data: Uint8Array, aad: Uint8Array, authTag: Uint8Array) => () => {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(authTag);
      decipher.update(data);
      return decipher.final();
    };
    expect(attempt(encrypted, bytes(10), tag)).not.toThrow();
    const flipped = NodeBuffer.from(encrypted);
    flipped[3] ^= 1;
    expect(attempt(flipped, bytes(10), tag)).toThrow(
      "Unsupported state or unable to authenticate data",
    );
    expect(attempt(encrypted, bytes(11), tag)).toThrow(
      "Unsupported state or unable to authenticate data",
    );
    const badTag = NodeBuffer.from(tag);
    badTag[15] ^= 0x80;
    expect(attempt(encrypted, bytes(10), badTag)).toThrow(
      "Unsupported state or unable to authenticate data",
    );
  });
});

describe("cipher listing", () => {
  it("lists names node knows, and getCipherInfo matches node", () => {
    const nodeCiphers = new Set(nodeCrypto.getCiphers());
    for (const name of getCiphers()) {
      expect(nodeCiphers.has(name) ? name : `unknown: ${name}`).toBe(name);
      expect(getCipherInfo(name)).toEqual(nodeCrypto.getCipherInfo(name));
      const nid = nodeCrypto.getCipherInfo(name)!.nid;
      expect(getCipherInfo(nid)).toEqual(nodeCrypto.getCipherInfo(nid));
    }
    expect(getCiphers()).toHaveLength(15);
    for (const options of [
      { keyLength: 16 },
      { keyLength: 32 },
      { ivLength: 16 },
      { ivLength: 7 },
    ]) {
      for (const name of ["aes-128-gcm", "aes-128-cbc"]) {
        expect(getCipherInfo(name, options)).toEqual(nodeCrypto.getCipherInfo(name, options));
      }
    }
    expect(getCipherInfo("nope")).toBeUndefined();
  });
});
