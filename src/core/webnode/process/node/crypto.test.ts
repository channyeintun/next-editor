// @vitest-environment node
// Differential tests for the crypto builtin: every result is compared with
// Node's own `node:crypto`.
import * as nodeCrypto from "node:crypto";
import { Buffer as NodeBuffer } from "node:buffer";
import { PassThrough } from "readable-stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "./crypto";

const HASHES = [
  "md5",
  "sha1",
  "sha224",
  "sha256",
  "sha384",
  "sha512",
  "sha512-224",
  "sha512-256",
  "sha3-224",
  "sha3-256",
  "sha3-384",
  "sha3-512",
  "shake128",
  "shake256",
  "ripemd160",
  "rmd160",
  "blake2b512",
  "blake2s256",
  "keccak-256",
  "RSA-SHA256",
  "SHA256",
  "sha-512",
];

const OUTPUT_ENCODINGS = ["hex", "base64", "base64url", "latin1", undefined] as const;

function bytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const MEGABYTE = bytes(1 << 20, 7);

/** A comparable form of a digest result. */
function norm(value: unknown): string {
  if (typeof value === "string") {
    return `s:${value}`;
  }
  if (value instanceof Uint8Array) {
    return `b:${NodeBuffer.from(value).toString("hex")}`;
  }
  if (value instanceof ArrayBuffer) {
    return `ab:${NodeBuffer.from(value).toString("hex")}`;
  }
  return `?:${String(value)}`;
}

function errorOf(fn: () => unknown): { name: string; code?: string; message: string } | null {
  try {
    fn();
  } catch (error) {
    const e = error as Error & { code?: string };
    return { name: e.name, code: e.code, message: e.message };
  }
  return null;
}

function sameError(ours: () => unknown, theirs: () => unknown): void {
  const expected = errorOf(theirs);
  expect(expected).not.toBeNull();
  expect(errorOf(ours)).toEqual(expected);
}

describe("createHash", () => {
  const inputs: [string, Uint8Array][] = [
    ["empty", new Uint8Array(0)],
    ["short", new TextEncoder().encode("abc")],
    ["two blocks", bytes(200)],
    ["1 MB", MEGABYTE],
  ];
  for (const algorithm of HASHES) {
    it(`${algorithm} matches node for every input and output encoding`, () => {
      for (const [, input] of inputs) {
        for (const encoding of OUTPUT_ENCODINGS) {
          const ours = crypto.createHash(algorithm).update(input).digest(encoding);
          const theirs = nodeCrypto.createHash(algorithm).update(input).digest(encoding!);
          expect(norm(ours)).toBe(norm(theirs));
        }
      }
    });

    it(`${algorithm} matches node across update splits and copy()`, () => {
      const ours = crypto.createHash(algorithm);
      const theirs = nodeCrypto.createHash(algorithm);
      for (const size of [1, 63, 64, 65, 127, 128, 129, 1000]) {
        const chunk = bytes(size, size);
        ours.update(chunk);
        theirs.update(chunk);
        expect(ours.copy().digest("hex")).toBe(theirs.copy().digest("hex"));
      }
      expect(ours.digest("hex")).toBe(theirs.digest("hex"));
    });
  }

  it("decodes every string input encoding like node", () => {
    const cases: [string, string][] = [
      ["héllo wörld ✓ 𝄞", "utf8"],
      ["héllo wörld ✓ 𝄞", "utf-8"],
      ["héllo", "latin1"],
      ["héllo", "binary"],
      ["héllo ✓", "ucs2"],
      ["héllo ✓", "utf16le"],
      ["hello", "ascii"],
      ["deadBEEF00ff", "hex"],
      ["aGVsbG8gd29ybGQ=", "base64"],
      ["aGVsbG8-_w", "base64url"],
      ["aGVsbG8-_w", "base64"],
      ["plain", "buffer"],
      ["plain", "bogus"],
    ];
    for (const [text, encoding] of cases) {
      const ours = crypto.createHash("sha256").update(text, encoding).digest("hex");
      const theirs = nodeCrypto
        .createHash("sha256")
        .update(text, encoding as nodeCrypto.Encoding)
        .digest("hex");
      expect(`${encoding} ${ours}`).toBe(`${encoding} ${theirs}`);
    }
    expect(crypto.createHash("sha1").update("default").digest("hex")).toBe(
      nodeCrypto.createHash("sha1").update("default").digest("hex"),
    );
  });

  it("accepts TypedArrays and DataViews by their bytes", () => {
    const source = bytes(64, 3);
    const u32 = new Uint32Array(source.buffer, 16, 8);
    const view = new DataView(source.buffer, 5, 40);
    for (const input of [u32, view]) {
      expect(crypto.createHash("sha256").update(input).digest("hex")).toBe(
        nodeCrypto.createHash("sha256").update(input).digest("hex"),
      );
    }
  });

  it("supports shake outputLength, including through copy()", () => {
    for (const outputLength of [0, 1, 16, 32, 100, 500]) {
      for (const algorithm of ["shake128", "shake256"]) {
        const ours = crypto.createHash(algorithm, { outputLength }).update("x").digest("hex");
        const theirs = nodeCrypto.createHash(algorithm, { outputLength }).update("x").digest("hex");
        expect(ours).toBe(theirs);
      }
    }
    const ours = crypto.createHash("shake256").update("abc");
    const theirs = nodeCrypto.createHash("shake256").update("abc");
    expect(ours.copy({ outputLength: 7 }).digest("hex")).toBe(
      theirs.copy({ outputLength: 7 }).digest("hex"),
    );
    expect(crypto.createHash("sha256", { outputLength: 32 }).digest("hex")).toBe(
      nodeCrypto.createHash("sha256", { outputLength: 32 }).digest("hex"),
    );
  });

  it("works as a Transform stream", async () => {
    const hash = crypto.createHash("sha256");
    hash.setEncoding("hex");
    const source = new PassThrough();
    source.pipe(hash);
    source.write(MEGABYTE.subarray(0, 1000));
    source.write("tail", "utf8");
    source.end(MEGABYTE.subarray(1000, 5000));
    const digest = await new Promise<string>((resolve, reject) => {
      hash.on("readable", () => {
        const value = hash.read() as string | null;
        if (value !== null) {
          resolve(value);
        }
      });
      hash.on("error", reject);
    });
    const expected = nodeCrypto
      .createHash("sha256")
      .update(MEGABYTE.subarray(0, 1000))
      .update("tail")
      .update(MEGABYTE.subarray(1000, 5000))
      .digest("hex");
    expect(digest).toBe(expected);
  });

  it("raises node's errors", () => {
    expect.hasAssertions();
    sameError(
      () => crypto.createHash("nope"),
      () => nodeCrypto.createHash("nope"),
    );
    sameError(
      () => crypto.createHash(5 as never),
      () => nodeCrypto.createHash(5 as never),
    );
    sameError(
      () => crypto.createHash("sha256").update(5 as never),
      () => nodeCrypto.createHash("sha256").update(5 as never),
    );
    sameError(
      () => crypto.createHash("sha256").update("abc", "hex"),
      () => nodeCrypto.createHash("sha256").update("abc", "hex"),
    );
    sameError(
      () => crypto.createHash("shake128", { outputLength: -1 }),
      () => nodeCrypto.createHash("shake128", { outputLength: -1 }),
    );
    sameError(
      () => crypto.createHash("shake128", { outputLength: 1.5 }),
      () => nodeCrypto.createHash("shake128", { outputLength: 1.5 }),
    );
    sameError(
      () => crypto.createHash("sha256", { outputLength: 5 }),
      () => nodeCrypto.createHash("sha256", { outputLength: 5 }),
    );
    const finalized = () => {
      const h = crypto.createHash("sha256");
      h.digest();
      return h;
    };
    const nodeFinalized = () => {
      const h = nodeCrypto.createHash("sha256");
      h.digest();
      return h;
    };
    sameError(
      () => finalized().update("a"),
      () => nodeFinalized().update("a"),
    );
    sameError(
      () => finalized().digest(),
      () => nodeFinalized().digest(),
    );
    sameError(
      () => finalized().copy(),
      () => nodeFinalized().copy(),
    );
  });

  it("returns a Buffer for unknown digest encodings, as node does", () => {
    const ours = crypto.createHash("sha256").digest("bogus");
    const theirs = nodeCrypto.createHash("sha256").digest("bogus" as never);
    expect(norm(ours)).toBe(norm(theirs));
  });

  it("lists exactly the names it accepts, all known to node", () => {
    const nodeHashes = new Set(nodeCrypto.getHashes());
    for (const name of crypto.getHashes()) {
      expect(nodeHashes.has(name) ? name : `unknown: ${name}`).toBe(name);
      expect(crypto.createHash(name).update("x").digest("hex")).toBe(
        nodeCrypto.createHash(name).update("x").digest("hex"),
      );
    }
    expect(crypto.getHashes()).toEqual([...crypto.getHashes()].sort());
  });
});

describe("createHmac", () => {
  const keys: [string, string | Uint8Array][] = [
    ["empty", ""],
    ["short", "key"],
    ["block-sized", bytes(64, 9)],
    ["long", bytes(300, 11)],
  ];
  const algorithms = HASHES.filter((name) => !name.startsWith("shake"));
  for (const algorithm of algorithms) {
    it(`${algorithm} matches node for short and long keys`, () => {
      for (const [, key] of keys) {
        for (const encoding of OUTPUT_ENCODINGS) {
          const ours = crypto
            .createHmac(algorithm, key)
            .update("message")
            .update(MEGABYTE.subarray(0, 3000))
            .digest(encoding);
          const theirs = nodeCrypto
            .createHmac(algorithm, key)
            .update("message")
            .update(MEGABYTE.subarray(0, 3000))
            .digest(encoding!);
          expect(norm(ours)).toBe(norm(theirs));
        }
      }
    });
  }

  it("decodes string keys with options.encoding and accepts ArrayBuffer keys", () => {
    expect(
      crypto.createHmac("sha256", "6b6579", { encoding: "hex" }).update("m").digest("hex"),
    ).toBe(
      nodeCrypto.createHmac("sha256", "6b6579", { encoding: "hex" }).update("m").digest("hex"),
    );
    const key = bytes(20).buffer;
    expect(crypto.createHmac("sha1", key).update("m").digest("hex")).toBe(
      nodeCrypto.createHmac("sha1", key).update("m").digest("hex"),
    );
  });

  it("returns empty output after the first digest and refuses updates", () => {
    const ours = crypto.createHmac("sha1", "k");
    const theirs = nodeCrypto.createHmac("sha1", "k");
    ours.digest();
    theirs.digest();
    expect(norm(ours.digest("hex"))).toBe(norm(theirs.digest("hex")));
    expect(norm(ours.digest())).toBe(norm(theirs.digest()));
    sameError(
      () => ours.update("a"),
      () => theirs.update("a"),
    );
  });

  it("raises node's errors", () => {
    expect.hasAssertions();
    sameError(
      () => crypto.createHmac("nope", "k"),
      () => nodeCrypto.createHmac("nope", "k"),
    );
    sameError(
      () => crypto.createHmac("sha256", 5 as never),
      () => nodeCrypto.createHmac("sha256", 5 as never),
    );
  });

  it("works as a Transform stream", async () => {
    const hmac = crypto.createHmac("sha512", "secret");
    const result = new Promise<string>((resolve) => {
      hmac.on("data", (chunk: Uint8Array) => resolve(NodeBuffer.from(chunk).toString("hex")));
    });
    hmac.write("part one ");
    hmac.end("part two");
    expect(await result).toBe(
      nodeCrypto.createHmac("sha512", "secret").update("part one part two").digest("hex"),
    );
  });
});

describe("crypto.hash", () => {
  it("matches node", () => {
    for (const algorithm of ["sha1", "sha256", "md5", "sha3-256"]) {
      for (const data of ["abc", MEGABYTE.subarray(0, 999)]) {
        expect(crypto.hash(algorithm, data)).toBe(nodeCrypto.hash(algorithm, data));
        for (const encoding of ["base64", "base64url", "buffer", "latin1"] as const) {
          expect(norm(crypto.hash(algorithm, data, encoding))).toBe(
            norm(nodeCrypto.hash(algorithm, data, encoding as never)),
          );
        }
      }
    }
  });

  it("raises node's errors", () => {
    expect.hasAssertions();
    sameError(
      () => crypto.hash("nope", "x"),
      () => nodeCrypto.hash("nope", "x"),
    );
    sameError(
      () => crypto.hash("sha1", 5 as never),
      () => nodeCrypto.hash("sha1", 5 as never),
    );
    sameError(
      () => crypto.hash("sha1", "abc", "bogus"),
      () => nodeCrypto.hash("sha1", "abc", "bogus" as never),
    );
  });
});

describe("key derivation", () => {
  it("pbkdf2Sync matches node", () => {
    for (const digest of ["sha1", "sha256", "sha512", "md5", "SHA-384"]) {
      for (const [password, salt, iterations, keylen] of [
        ["password", "salt", 1, 20],
        ["password", "salt", 2, 64],
        ["", "", 3, 10],
        [bytes(100), bytes(30), 100, 100],
      ] as const) {
        const ours = crypto.pbkdf2Sync(password, salt, iterations, keylen, digest);
        const theirs = nodeCrypto.pbkdf2Sync(password, salt, iterations, keylen, digest);
        expect(norm(ours)).toBe(norm(theirs));
      }
    }
  });

  it("pbkdf2 calls back with node's result", async () => {
    const ours = await new Promise<unknown>((resolve, reject) =>
      crypto.pbkdf2("pw", "salt", 50, 48, "sha256", (error: Error | null, key?: unknown) =>
        error ? reject(error) : resolve(key),
      ),
    );
    expect(norm(ours)).toBe(norm(nodeCrypto.pbkdf2Sync("pw", "salt", 50, 48, "sha256")));
  });

  it("pbkdf2 raises node's errors", () => {
    expect.hasAssertions();
    sameError(
      () => crypto.pbkdf2Sync("a", "b", 1, 32, "nope"),
      () => nodeCrypto.pbkdf2Sync("a", "b", 1, 32, "nope"),
    );
    sameError(
      () => crypto.pbkdf2Sync("a", "b", 0, 32, "sha256"),
      () => nodeCrypto.pbkdf2Sync("a", "b", 0, 32, "sha256"),
    );
    sameError(
      () => crypto.pbkdf2Sync("a", "b", 1, -1, "sha1"),
      () => nodeCrypto.pbkdf2Sync("a", "b", 1, -1, "sha1"),
    );
    sameError(
      () => crypto.pbkdf2Sync("a", "b", 1, 1, 5),
      () => nodeCrypto.pbkdf2Sync("a", "b", 1, 1, 5 as never),
    );
    sameError(
      () => crypto.pbkdf2Sync(5, "b", 1, 1, "sha1"),
      () => nodeCrypto.pbkdf2Sync(5 as never, "b", 1, 1, "sha1"),
    );
    sameError(
      () => crypto.pbkdf2("a", "b", 1, 1, "sha1"),
      () => (nodeCrypto.pbkdf2 as (...args: unknown[]) => void)("a", "b", 1, 1, "sha1"),
    );
  });

  it("scryptSync matches node, with every option spelling", () => {
    const cases: [unknown, unknown, number, object | undefined][] = [
      ["password", "salt", 64, undefined],
      ["", "", 16, { N: 16, r: 1, p: 1 }],
      ["pleaseletmein", "SodiumChloride", 64, { cost: 1024, blockSize: 8, parallelization: 2 }],
      [bytes(40), bytes(16), 33, { N: 256, r: 4, p: 3, maxmem: 64 << 20 }],
      ["password", "salt", 0, undefined],
    ];
    for (const [password, salt, keylen, options] of cases) {
      const ours = crypto.scryptSync(password, salt, keylen, options);
      const theirs = nodeCrypto.scryptSync(password as string, salt as string, keylen, options);
      expect(norm(ours)).toBe(norm(theirs));
    }
  });

  it("scrypt calls back with node's result, with and without options", async () => {
    const run = (...args: unknown[]) =>
      new Promise<unknown>((resolve, reject) =>
        (crypto.scrypt as (...a: unknown[]) => void)(...args, (error: Error | null, key: unknown) =>
          error ? reject(error) : resolve(key),
        ),
      );
    expect(norm(await run("pw", "salt", 32))).toBe(norm(nodeCrypto.scryptSync("pw", "salt", 32)));
    expect(norm(await run("pw", "salt", 32, { N: 64 }))).toBe(
      norm(nodeCrypto.scryptSync("pw", "salt", 32, { N: 64 })),
    );
  });

  it("scrypt raises node's errors", () => {
    expect.hasAssertions();
    const cases: [number, object][] = [
      // N: 1 first: node reports a stale OpenSSL error after a memory failure.
      [32, { N: 3 }],
      [32, { N: 1 }],
      [32, { N: 32768 }],
      [32, { N: 16, cost: 16 }],
      [32, { r: 1, blockSize: 1 }],
      [32, { p: 1, parallelization: 1 }],
      [32, { N: -1 }],
      [32, { N: 1024, r: 1, p: 1, maxmem: 1000 }],
      [32, { N: 2 ** 20, r: 1 }],
      [-1, {}],
    ];
    for (const [keylen, options] of cases) {
      sameError(
        () => crypto.scryptSync("a", "b", keylen, options),
        () => nodeCrypto.scryptSync("a", "b", keylen, options),
      );
    }
  });

  it("hkdfSync matches node", () => {
    for (const digest of ["sha256", "sha512", "sha1", "md5"]) {
      for (const [ikm, salt, info, keylen] of [
        ["secret", "salt", "info", 42],
        ["secret", "", "", 10],
        [bytes(80), bytes(80, 2), bytes(80, 3), 82],
      ] as const) {
        const ours = crypto.hkdfSync(digest, ikm, salt, info, keylen);
        const theirs = nodeCrypto.hkdfSync(digest, ikm, salt, info, keylen);
        expect(ours).toBeInstanceOf(ArrayBuffer);
        expect(norm(ours)).toBe(norm(theirs));
      }
    }
  });

  it("hkdf calls back with node's result", async () => {
    const ours = await new Promise<unknown>((resolve, reject) =>
      crypto.hkdf("sha384", "ikm", "salt", "info", 64, (error: Error | null, key?: unknown) =>
        error ? reject(error) : resolve(key),
      ),
    );
    expect(norm(ours)).toBe(norm(nodeCrypto.hkdfSync("sha384", "ikm", "salt", "info", 64)));
  });

  it("derives no key of zero bytes with pbkdf2 or hkdf, as Node's OpenSSL refuses to", async () => {
    // Node 26's messages (Node 22 says "Deriving bits failed" for both).
    const failures: [string, () => unknown, () => unknown][] = [
      [
        "PBKDF2 derivation failed",
        () => crypto.pbkdf2Sync("pw", "salt", 10, 0, "sha256"),
        () => nodeCrypto.pbkdf2Sync("pw", "salt", 10, 0, "sha256"),
      ],
      [
        "HKDF derivation failed",
        () => crypto.hkdfSync("sha256", "key", "salt", "info", 0),
        () => nodeCrypto.hkdfSync("sha256", "key", "salt", "info", 0),
      ],
    ];
    for (const [message, ours, theirs] of failures) {
      expect(errorOf(theirs)).toMatchObject({ name: "Error", code: undefined });
      expect(errorOf(ours)).toEqual({ name: "Error", code: undefined, message });
    }
    const called = (start: (done: (error: Error | null, key?: unknown) => void) => void) =>
      new Promise<string>((resolve) =>
        start((error, key) => resolve(error ? `${error.name}: ${error.message}` : norm(key))),
      );
    expect(await called((done) => crypto.pbkdf2("pw", "salt", 10, 0, "sha256", done))).toBe(
      "Error: PBKDF2 derivation failed",
    );
    expect(await called((done) => crypto.hkdf("sha256", "key", "salt", "info", 0, done))).toBe(
      "Error: HKDF derivation failed",
    );
    // An invalid digest is still what is reported first.
    sameError(
      () => crypto.pbkdf2Sync("pw", "salt", 10, 0, "nope"),
      () => nodeCrypto.pbkdf2Sync("pw", "salt", 10, 0, "nope"),
    );
    // scrypt does derive one.
    expect(norm(crypto.scryptSync("pw", "salt", 0))).toBe(
      norm(nodeCrypto.scryptSync("pw", "salt", 0)),
    );
    expect(await called((done) => crypto.scrypt("pw", "salt", 0, done))).toBe("b:");
  });

  it("hkdf raises node's errors", () => {
    expect.hasAssertions();
    sameError(
      () => crypto.hkdfSync("nope", "a", "b", "c", 10),
      () => nodeCrypto.hkdfSync("nope", "a", "b", "c", 10),
    );
    sameError(
      () => crypto.hkdfSync("sha256", "a", "b", "c", 255 * 32 + 1),
      () => nodeCrypto.hkdfSync("sha256", "a", "b", "c", 255 * 32 + 1),
    );
    sameError(
      () => crypto.hkdfSync("sha256", "a", "b", new Uint8Array(1025), 10),
      () => nodeCrypto.hkdfSync("sha256", "a", "b", new Uint8Array(1025), 10),
    );
    sameError(
      () => crypto.hkdfSync(5, "a", "b", "c", 10),
      () => nodeCrypto.hkdfSync(5 as never, "a", "b", "c", 10),
    );
    sameError(
      () => crypto.hkdfSync("sha256", "a", 5, "c", 10),
      () => nodeCrypto.hkdfSync("sha256", "a", 5 as never, "c", 10),
    );
  });
});

describe("randomness", () => {
  it("randomBytes returns fresh Buffers of the asked size, sync and async", async () => {
    const a = crypto.randomBytes(100) as Uint8Array;
    const b = crypto.randomBytes(100) as Uint8Array;
    expect(a.length).toBe(100);
    expect(NodeBuffer.from(a).equals(NodeBuffer.from(b))).toBe(false);
    expect((crypto.randomBytes(0) as Uint8Array).length).toBe(0);
    const big = crypto.randomBytes(200_000) as Uint8Array;
    expect(big.length).toBe(200_000);
    // Every 65536-byte chunk is filled, not just the first.
    expect(big.subarray(150_000).some((byte) => byte !== 0)).toBe(true);
    const async = await new Promise<Uint8Array>((resolve, reject) =>
      crypto.randomBytes(33, (error: Error | null, buf?: unknown) =>
        error ? reject(error) : resolve(buf as Uint8Array),
      ),
    );
    expect(async.length).toBe(33);
    expect(crypto.prng).toBe(crypto.randomBytes);
    expect(crypto.pseudoRandomBytes).toBe(crypto.randomBytes);
    expect(crypto.rng).toBe(crypto.randomBytes);
  });

  it("randomFillSync fills only the asked element range", () => {
    const u32 = new Uint32Array(8);
    crypto.randomFillSync(u32, 2, 3);
    expect([u32[0], u32[1], u32[5], u32[6], u32[7]]).toEqual([0, 0, 0, 0, 0]);
    const filled = new Uint8Array(4096);
    expect(crypto.randomFillSync(filled)).toBe(filled);
    expect(filled.some((byte) => byte !== 0)).toBe(true);
    const ab = new ArrayBuffer(16);
    expect(crypto.randomFillSync(ab)).toBe(ab);
  });

  it("randomFill fills asynchronously", async () => {
    const target = new Uint8Array(32);
    const result = await new Promise<unknown>((resolve, reject) =>
      crypto.randomFill(target, 16, (error: Error | null, buf: unknown) =>
        error ? reject(error) : resolve(buf),
      ),
    );
    expect(result).toBe(target);
    expect(target.subarray(0, 16).every((byte) => byte === 0)).toBe(true);
  });

  it("randomInt stays in range and covers it", async () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const n = crypto.randomInt(-3, 4) as number;
      expect(n).toBeGreaterThanOrEqual(-3);
      expect(n).toBeLessThan(4);
      seen.add(n);
    }
    expect(seen.size).toBe(7);
    const large = crypto.randomInt(2 ** 48 - 1) as number;
    expect(Number.isSafeInteger(large)).toBe(true);
    const viaCallback = await new Promise<number>((resolve, reject) =>
      crypto.randomInt(10, (error: Error | null, n?: number) =>
        error ? reject(error) : resolve(n!),
      ),
    );
    expect(viaCallback).toBeGreaterThanOrEqual(0);
    expect(viaCallback).toBeLessThan(10);
  });

  it("randomUUID is a version 4 UUID", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const uuid = crypto.randomUUID();
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      seen.add(uuid);
    }
    expect(seen.size).toBe(100);
    expect(crypto.randomUUID({ disableEntropyCache: true })).toHaveLength(36);
  });

  it("getRandomValues fills a typed array", () => {
    const array = new Uint16Array(10);
    expect(crypto.getRandomValues(array)).toBe(array);
  });

  it("raises node's errors", () => {
    expect.hasAssertions();
    const pairs: [() => unknown, () => unknown][] = [
      [() => crypto.randomBytes(-1), () => nodeCrypto.randomBytes(-1)],
      [() => crypto.randomBytes("1"), () => nodeCrypto.randomBytes("1" as never)],
      [() => crypto.randomBytes(2 ** 31), () => nodeCrypto.randomBytes(2 ** 31)],
      [() => crypto.randomBytes(1, 5), () => nodeCrypto.randomBytes(1, 5 as never)],
      [() => crypto.randomFillSync("x"), () => nodeCrypto.randomFillSync("x" as never)],
      [
        () => crypto.randomFillSync(new Uint32Array(4), 5),
        () => nodeCrypto.randomFillSync(new Uint32Array(4), 5),
      ],
      [
        () => crypto.randomFillSync(new Uint32Array(4), 1, 4),
        () => nodeCrypto.randomFillSync(new Uint32Array(4), 1, 4),
      ],
      [
        () => crypto.randomFill(new Uint8Array(4), 0, 4),
        () => (nodeCrypto.randomFill as (...a: unknown[]) => void)(new Uint8Array(4), 0, 4),
      ],
      [() => crypto.randomInt(1.5), () => nodeCrypto.randomInt(1.5)],
      [() => crypto.randomInt(5, 2), () => nodeCrypto.randomInt(5, 2)],
      [() => crypto.randomInt(0, 2 ** 48), () => nodeCrypto.randomInt(0, 2 ** 48)],
      [() => crypto.randomInt("1", 2), () => nodeCrypto.randomInt("1" as never, 2)],
      [() => crypto.randomInt(3, 4, 5), () => nodeCrypto.randomInt(3, 4, 5 as never)],
      [
        () => crypto.randomUUID({ disableEntropyCache: 1 }),
        () => nodeCrypto.randomUUID({ disableEntropyCache: 1 as never }),
      ],
      [() => crypto.randomUUID(5), () => nodeCrypto.randomUUID(5 as never)],
    ];
    for (const [ours, theirs] of pairs) {
      sameError(ours, theirs);
    }
  });
});

describe("timingSafeEqual", () => {
  it("compares bytes of any view like node", () => {
    const a = bytes(32);
    const b = bytes(32);
    const c = bytes(32, 99);
    expect(crypto.timingSafeEqual(a, b)).toBe(true);
    expect(crypto.timingSafeEqual(a, c)).toBe(false);
    expect(crypto.timingSafeEqual(new Uint16Array(2), new Uint8Array(4))).toBe(
      nodeCrypto.timingSafeEqual(new Uint16Array(2), new Uint8Array(4)),
    );
    expect(crypto.timingSafeEqual(new ArrayBuffer(3), new DataView(new ArrayBuffer(3)))).toBe(true);
    expect(crypto.timingSafeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  it("raises node's errors", () => {
    expect.hasAssertions();
    sameError(
      () => crypto.timingSafeEqual(new Uint8Array(1), new Uint8Array(2)),
      () => nodeCrypto.timingSafeEqual(new Uint8Array(1), new Uint8Array(2)),
    );
    sameError(
      () => crypto.timingSafeEqual("a", "b"),
      () => nodeCrypto.timingSafeEqual("a" as never, "b" as never),
    );
    sameError(
      () => crypto.timingSafeEqual(new Uint8Array(1), 5),
      () => nodeCrypto.timingSafeEqual(new Uint8Array(1), 5 as never),
    );
  });
});

describe("module surface", () => {
  it("copies node's constants", () => {
    expect({ ...crypto.constants }).toEqual({ ...nodeCrypto.constants });
  });

  it("exposes webcrypto and subtle", () => {
    expect(crypto.webcrypto).toBe(globalThis.crypto);
    expect(crypto.subtle).toBe(globalThis.crypto.subtle);
    expect(crypto.getFips()).toBe(0);
    expect(crypto.getCurves()).toEqual([]);
  });

  it("names every member node 22 has that webnode cannot provide", () => {
    const missing = [
      "createSign",
      "createVerify",
      "sign",
      "verify",
      "generateKeyPair",
      "generateKeyPairSync",
      "generateKey",
      "generateKeySync",
      "createPublicKey",
      "createPrivateKey",
      "createDiffieHellman",
      "createDiffieHellmanGroup",
      "getDiffieHellman",
      "diffieHellman",
      "createECDH",
      "publicEncrypt",
      "privateDecrypt",
      "privateEncrypt",
      "publicDecrypt",
      "checkPrime",
      "checkPrimeSync",
      "generatePrime",
      "generatePrimeSync",
      "setEngine",
      "secureHeapUsed",
      "setFips",
    ] as const;
    for (const name of missing) {
      const fn = crypto[name] as (...args: unknown[]) => unknown;
      expect(errorOf(() => fn())).toEqual({
        name: "Error",
        code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
        message: `crypto.${name} is not available in webnode`,
      });
    }
    for (const name of [
      "X509Certificate",
      "Certificate",
      "DiffieHellman",
      "DiffieHellmanGroup",
      "ECDH",
      "Sign",
      "Verify",
    ] as const) {
      const Class = crypto[name] as new () => unknown;
      expect(errorOf(() => new Class())?.message).toBe(
        `crypto.${name} is not available in webnode`,
      );
    }
  });

  it("makes secret KeyObjects like Node (jsonwebtoken's HS256 path)", () => {
    // eslint-disable-next-line typescript/no-explicit-any -- both modules, one shape
    const run = (c: any) => {
      const k = c.createSecretKey(NodeBuffer.from("my-hs256-secret") as never);
      const same = c.createSecretKey(NodeBuffer.from("my-hs256-secret") as never);
      const source = NodeBuffer.from("ab");
      const copied = c.createSecretKey(source as never);
      source[0] = 0;
      const exported = k.export() as Uint8Array;
      exported[0] = 0;
      return {
        type: k.type,
        size: k.symmetricKeySize,
        isKeyObject: k instanceof c.KeyObject,
        tag: Object.prototype.toString.call(k),
        ctor: k.constructor.name,
        exported: NodeBuffer.from(k.export() as Uint8Array).toString(),
        isBuffer: NodeBuffer.isBuffer(NodeBuffer.from(k.export() as Uint8Array)),
        buffer: NodeBuffer.from(k.export({ format: "buffer" }) as Uint8Array).toString("hex"),
        jwk: k.export({ format: "jwk" }),
        copied: NodeBuffer.from(copied.export() as Uint8Array).toString(),
        equals: [k.equals(same), k.equals(copied)],
        hex: NodeBuffer.from(c.createSecretKey("abc", "hex").export() as Uint8Array).toString(
          "hex",
        ),
        view: NodeBuffer.from(
          c
            .createSecretKey(new DataView(new Uint8Array([1, 2, 3]).buffer, 1))
            .export() as Uint8Array,
        ).toString("hex"),
        empty: c.createSecretKey(new Uint8Array(0)).symmetricKeySize,
        hmac: c.createHmac("sha256", k).update("a").digest("hex"),
        hkdf: NodeBuffer.from(c.hkdfSync("sha256", k, "s", "i", 8)).toString("hex"),
        cipher: c
          .createCipheriv("aes-128-cbc", c.createSecretKey(new Uint8Array(16)), new Uint8Array(16))
          .final("hex"),
        json: JSON.stringify(k),
        errors: [
          errorOf(() => c.createSecretKey(5 as never)),
          errorOf(() => c.createSecretKey(k as never)),
          errorOf(() => k.export({ format: "pem" } as never)),
          errorOf(() => k.export(5 as never)),
          errorOf(() => k.equals("x" as never)),
          errorOf(() => new (c.KeyObject as unknown as new (...a: unknown[]) => unknown)("x", {})),
          errorOf(
            () => new (c.KeyObject as unknown as new (...a: unknown[]) => unknown)("secret", {}),
          ),
          errorOf(() => c.KeyObject.from({} as never)),
          errorOf(() => c.pbkdf2Sync(k as never, "s", 1, 8, "sha256")),
        ],
      };
    };
    expect(run(crypto)).toEqual(run(nodeCrypto));
  });

  it("has every key node 22's crypto has", () => {
    const node22 = [
      "checkPrime",
      "checkPrimeSync",
      "createCipheriv",
      "createDecipheriv",
      "createDiffieHellman",
      "createDiffieHellmanGroup",
      "createECDH",
      "createHash",
      "createHmac",
      "createPrivateKey",
      "createPublicKey",
      "createSecretKey",
      "createSign",
      "createVerify",
      "diffieHellman",
      "generatePrime",
      "generatePrimeSync",
      "getCiphers",
      "getCipherInfo",
      "getCurves",
      "getDiffieHellman",
      "getHashes",
      "hkdf",
      "hkdfSync",
      "pbkdf2",
      "pbkdf2Sync",
      "generateKeyPair",
      "generateKeyPairSync",
      "generateKey",
      "generateKeySync",
      "privateDecrypt",
      "privateEncrypt",
      "publicDecrypt",
      "publicEncrypt",
      "randomBytes",
      "randomFill",
      "randomFillSync",
      "randomInt",
      "randomUUID",
      "scrypt",
      "scryptSync",
      "sign",
      "setEngine",
      "timingSafeEqual",
      "getFips",
      "setFips",
      "verify",
      "hash",
      "Certificate",
      "Cipheriv",
      "Decipheriv",
      "DiffieHellman",
      "DiffieHellmanGroup",
      "ECDH",
      "Hash",
      "Hmac",
      "KeyObject",
      "Sign",
      "Verify",
      "X509Certificate",
      "secureHeapUsed",
      "fips",
      "constants",
      "webcrypto",
      "subtle",
      "getRandomValues",
      "prng",
      "pseudoRandomBytes",
      "rng",
    ];
    for (const key of node22) {
      expect(key in crypto ? key : `missing: ${key}`).toBe(key);
    }
  });
});

// Node finishes these jobs off the main thread and calls back from the event
// loop. Here the callback must come in a task of its own: not in a promise job
// of the caller's task, and not from a global timer a program may have replaced.
describe("callbacks of asynchronous jobs", () => {
  type Done = (error: Error | null, result?: unknown) => void;
  const jobs: [string, (done: Done) => void][] = [
    ["pbkdf2", (done) => crypto.pbkdf2("pw", "salt", 10, 16, "sha256", done)],
    [
      "pbkdf2 of no bytes (an error)",
      (done) => crypto.pbkdf2("pw", "salt", 10, 0, "sha256", () => done(null)),
    ],
    ["scrypt", (done) => crypto.scrypt("pw", "salt", 16, { N: 16 }, done)],
    ["scrypt of no bytes", (done) => crypto.scrypt("pw", "salt", 0, done)],
    ["hkdf", (done) => crypto.hkdf("sha256", "key", "salt", "info", 16, done)],
    ["randomBytes", (done) => crypto.randomBytes(8, done)],
    ["randomFill", (done) => crypto.randomFill(new Uint8Array(8), done)],
    ["randomInt", (done) => crypto.randomInt(10, done)],
  ];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(jobs)("%s calls back after the caller's promise jobs", async (_name, start) => {
    let called = false;
    const finished = new Promise<void>((resolve, reject) =>
      start((error) => {
        called = true;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }),
    );
    // Far more promise jobs than any derivation here takes: all of them run
    // before the event loop takes its next task.
    for (let hop = 0; hop < 2000; hop += 1) {
      await Promise.resolve();
    }
    expect(called).toBe(false);
    await finished;
    expect(called).toBe(true);
  });

  it.each(jobs)("%s completes with the global timers replaced", async (_name, start) => {
    // A fake clock: what it is given never runs.
    const parked = vi.fn<() => void>();
    vi.stubGlobal("setTimeout", parked);
    vi.stubGlobal("setInterval", parked);
    vi.stubGlobal("setImmediate", parked);
    vi.stubGlobal("queueMicrotask", parked);
    const finished = new Promise<void>((resolve, reject) =>
      start((error) => (error ? reject(error) : resolve())),
    );
    expect(parked).not.toHaveBeenCalled();
    await finished;
    expect(parked).not.toHaveBeenCalled();
  });
});
