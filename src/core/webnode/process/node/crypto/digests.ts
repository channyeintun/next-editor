// The message digests webnode supports, on @noble/hashes, keyed by every name
// OpenSSL (and so Node) accepts for them. One table serves createHash,
// createHmac, crypto.hash, pbkdf2, hkdf and getHashes.
import { blake2b, blake2s } from "@noble/hashes/blake2.js";
import { md5, ripemd160, sha1 } from "@noble/hashes/legacy.js";
import { sha224, sha256, sha384, sha512, sha512_224, sha512_256 } from "@noble/hashes/sha2.js";
import {
  keccak_224,
  keccak_256,
  keccak_384,
  keccak_512,
  sha3_224,
  sha3_256,
  sha3_384,
  sha3_512,
  shake128,
  shake256,
} from "@noble/hashes/sha3.js";
import type { CHash } from "@noble/hashes/utils.js";

/** A running noble hash state. */
export interface HashState {
  update(bytes: Uint8Array): unknown;
  digest(): Uint8Array;
  clone(): HashState;
  xof?(bytes: number): Uint8Array;
}

/** One supported digest. */
export interface Digest {
  /** The noble constructor (`CHash`). */
  readonly hash: CHash;
  /** Bytes produced by `digest()`; for an XOF, the default output length. */
  readonly outputLength: number;
  /** Whether it is an extendable-output function (shake). */
  readonly xof: boolean;
  /** The names `crypto.getHashes()` lists for it (OpenSSL spellings). */
  readonly names: readonly string[];
}

const DIGESTS: readonly Digest[] = [
  {
    hash: md5,
    outputLength: 16,
    xof: false,
    names: ["RSA-MD5", "md5", "md5WithRSAEncryption", "ssl3-md5"],
  },
  {
    hash: sha1,
    outputLength: 20,
    xof: false,
    names: ["RSA-SHA1", "RSA-SHA1-2", "sha-1", "sha1", "sha1WithRSAEncryption", "ssl3-sha1"],
  },
  {
    hash: ripemd160,
    outputLength: 20,
    xof: false,
    names: ["RSA-RIPEMD160", "ripemd", "ripemd-160", "ripemd160", "ripemd160WithRSA", "rmd160"],
  },
  {
    hash: sha224,
    outputLength: 28,
    xof: false,
    names: ["RSA-SHA224", "sha-224", "sha2-224", "sha224", "sha224WithRSAEncryption"],
  },
  {
    hash: sha256,
    outputLength: 32,
    xof: false,
    names: ["RSA-SHA256", "sha-256", "sha2-256", "sha256", "sha256WithRSAEncryption"],
  },
  {
    hash: sha384,
    outputLength: 48,
    xof: false,
    names: ["RSA-SHA384", "sha-384", "sha2-384", "sha384", "sha384WithRSAEncryption"],
  },
  {
    hash: sha512,
    outputLength: 64,
    xof: false,
    names: ["RSA-SHA512", "sha-512", "sha2-512", "sha512", "sha512WithRSAEncryption"],
  },
  {
    hash: sha512_224,
    outputLength: 28,
    xof: false,
    names: [
      "RSA-SHA512/224",
      "sha-512/224",
      "sha2-512/224",
      "sha512-224",
      "sha512-224WithRSAEncryption",
    ],
  },
  {
    hash: sha512_256,
    outputLength: 32,
    xof: false,
    names: [
      "RSA-SHA512/256",
      "sha-512/256",
      "sha2-512/256",
      "sha512-256",
      "sha512-256WithRSAEncryption",
    ],
  },
  {
    hash: sha3_224,
    outputLength: 28,
    xof: false,
    names: ["RSA-SHA3-224", "id-rsassa-pkcs1-v1_5-with-sha3-224", "sha3-224"],
  },
  {
    hash: sha3_256,
    outputLength: 32,
    xof: false,
    names: ["RSA-SHA3-256", "id-rsassa-pkcs1-v1_5-with-sha3-256", "sha3-256"],
  },
  {
    hash: sha3_384,
    outputLength: 48,
    xof: false,
    names: ["RSA-SHA3-384", "id-rsassa-pkcs1-v1_5-with-sha3-384", "sha3-384"],
  },
  {
    hash: sha3_512,
    outputLength: 64,
    xof: false,
    names: ["RSA-SHA3-512", "id-rsassa-pkcs1-v1_5-with-sha3-512", "sha3-512"],
  },
  { hash: keccak_224, outputLength: 28, xof: false, names: ["keccak-224"] },
  { hash: keccak_256, outputLength: 32, xof: false, names: ["keccak-256"] },
  { hash: keccak_384, outputLength: 48, xof: false, names: ["keccak-384"] },
  { hash: keccak_512, outputLength: 64, xof: false, names: ["keccak-512"] },
  { hash: shake128, outputLength: 16, xof: true, names: ["shake-128", "shake128"] },
  { hash: shake256, outputLength: 32, xof: true, names: ["shake-256", "shake256"] },
  { hash: blake2b, outputLength: 64, xof: false, names: ["blake2b-512", "blake2b512"] },
  { hash: blake2s, outputLength: 32, xof: false, names: ["blake2s-256", "blake2s256"] },
];

const BY_NAME = new Map<string, Digest>();
for (const digest of DIGESTS) {
  for (const name of digest.names) {
    BY_NAME.set(name.toLowerCase(), digest);
  }
}

/** The digest for `name` (case-insensitive, any OpenSSL alias), or undefined. */
export function findDigest(name: string): Digest | undefined {
  return BY_NAME.get(name.toLowerCase());
}

/** A fresh running state for `digest`. */
export function createState(digest: Digest): HashState {
  return (digest.hash as unknown as { create(): HashState }).create();
}

/** `crypto.getHashes()`: every supported name, sorted the way Node lists them. */
export function supportedHashNames(): string[] {
  return DIGESTS.flatMap((digest) => digest.names).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
