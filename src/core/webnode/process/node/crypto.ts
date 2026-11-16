// The `crypto` builtin: what `require("crypto")` returns. Hashes, HMAC, KDFs
// and AES run in pure TypeScript (crypto/); randomness and `webcrypto` come
// from the platform's Web Crypto. Asymmetric crypto, X.509, DH and primes exist
// and throw ERR_FEATURE_UNAVAILABLE_ON_PLATFORM (crypto/unavailable.ts).
import {
  Cipheriv,
  Decipheriv,
  createCipheriv,
  createDecipheriv,
  getCipherInfo,
  getCiphers,
} from "./crypto/cipher";
import { constants } from "./crypto/constants";
import { Hash, Hmac, createHash, createHmac, getHashes, hash } from "./crypto/hash";
import { hkdf, hkdfSync, pbkdf2, pbkdf2Sync, scrypt, scryptSync } from "./crypto/kdf";
import {
  getRandomValues,
  randomBytes,
  randomFill,
  randomFillSync,
  randomInt,
  randomUUID,
} from "./crypto/random";
import { timingSafeEqual } from "./crypto/timingSafeEqual";
import * as unavailable from "./crypto/unavailable";

// Captured now for the same reason as in crypto/random.ts.
const nativeCrypto: Crypto | undefined = globalThis.crypto;

function webcrypto(): Crypto {
  const crypto = nativeCrypto;
  if (!crypto) {
    throw new Error("crypto.webcrypto is not available: globalThis.crypto is missing");
  }
  return crypto;
}

/** `require("crypto")`. */
const crypto = {
  // Hashes and MACs
  createHash,
  createHmac,
  hash,
  getHashes,
  Hash,
  Hmac,
  // Key derivation
  pbkdf2,
  pbkdf2Sync,
  scrypt,
  scryptSync,
  hkdf,
  hkdfSync,
  // Randomness
  randomBytes,
  randomFill,
  randomFillSync,
  randomInt,
  randomUUID,
  getRandomValues,
  // Ciphers
  createCipheriv,
  createDecipheriv,
  getCiphers,
  getCipherInfo,
  Cipheriv,
  Decipheriv,
  // Comparison
  timingSafeEqual,
  // Unavailable on this platform
  checkPrime: unavailable.checkPrime,
  checkPrimeSync: unavailable.checkPrimeSync,
  createDiffieHellman: unavailable.createDiffieHellman,
  createDiffieHellmanGroup: unavailable.createDiffieHellmanGroup,
  createECDH: unavailable.createECDH,
  createPrivateKey: unavailable.createPrivateKey,
  createPublicKey: unavailable.createPublicKey,
  createSecretKey: unavailable.createSecretKey,
  createSign: unavailable.createSign,
  createVerify: unavailable.createVerify,
  diffieHellman: unavailable.diffieHellman,
  generatePrime: unavailable.generatePrime,
  generatePrimeSync: unavailable.generatePrimeSync,
  getCurves: unavailable.getCurves,
  getDiffieHellman: unavailable.getDiffieHellman,
  generateKeyPair: unavailable.generateKeyPair,
  generateKeyPairSync: unavailable.generateKeyPairSync,
  generateKey: unavailable.generateKey,
  generateKeySync: unavailable.generateKeySync,
  privateDecrypt: unavailable.privateDecrypt,
  privateEncrypt: unavailable.privateEncrypt,
  publicDecrypt: unavailable.publicDecrypt,
  publicEncrypt: unavailable.publicEncrypt,
  sign: unavailable.sign,
  verify: unavailable.verify,
  setEngine: unavailable.setEngine,
  getFips: unavailable.getFips,
  setFips: unavailable.setFips,
  secureHeapUsed: unavailable.secureHeapUsed,
  Certificate: unavailable.Certificate,
  DiffieHellman: unavailable.DiffieHellman,
  DiffieHellmanGroup: unavailable.DiffieHellmanGroup,
  ECDH: unavailable.ECDH,
  KeyObject: unavailable.KeyObject,
  Sign: unavailable.Sign,
  Verify: unavailable.Verify,
  X509Certificate: unavailable.X509Certificate,
  constants,
  /** Deprecated (DEP0093): `getFips()`. */
  get fips(): 0 {
    return unavailable.getFips();
  },
  /** `globalThis.crypto`. */
  get webcrypto(): Crypto {
    return webcrypto();
  },
  /** `globalThis.crypto.subtle`. */
  get subtle(): SubtleCrypto {
    return webcrypto().subtle;
  },
};

// Deprecated aliases of randomBytes, non-enumerable as in Node.
for (const alias of ["prng", "pseudoRandomBytes", "rng"]) {
  Object.defineProperty(crypto, alias, {
    value: randomBytes,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

export default crypto as typeof crypto & {
  prng: typeof randomBytes;
  pseudoRandomBytes: typeof randomBytes;
  rng: typeof randomBytes;
};

export {
  Cipheriv,
  Decipheriv,
  Hash,
  Hmac,
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  getCipherInfo,
  getCiphers,
  getHashes,
  getRandomValues,
  hash,
  hkdf,
  hkdfSync,
  pbkdf2,
  pbkdf2Sync,
  randomBytes,
  randomFill,
  randomFillSync,
  randomInt,
  randomUUID,
  scrypt,
  scryptSync,
  timingSafeEqual,
};
