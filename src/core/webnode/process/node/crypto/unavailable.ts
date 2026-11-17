// The parts of Node's `crypto` webnode does not provide: asymmetric keys
// (secret keys are in crypto/keys.ts),
// signatures, Diffie-Hellman, X.509, primes, engines and FIPS mode. Each exists
// with Node's name and throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` naming
// itself when called or constructed.
import { unavailable } from "./errors";

/** A function that throws the unavailable error for `crypto.<name>`. */
function unavailableFunction(name: string): (...args: unknown[]) => never {
  const fn = (..._args: unknown[]): never => {
    throw unavailable(name);
  };
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}

/** A class whose constructor throws the unavailable error for `crypto.<name>`. */
function unavailableClass(name: string): new (...args: unknown[]) => object {
  const Class = class {
    constructor(..._args: unknown[]) {
      throw unavailable(name);
    }
  };
  Object.defineProperty(Class, "name", { value: name });
  return Class;
}

export const createSign = unavailableFunction("createSign");
export const createVerify = unavailableFunction("createVerify");
export const sign = unavailableFunction("sign");
export const verify = unavailableFunction("verify");
export const generateKeyPair = unavailableFunction("generateKeyPair");
export const generateKeyPairSync = unavailableFunction("generateKeyPairSync");
export const generateKey = unavailableFunction("generateKey");
export const generateKeySync = unavailableFunction("generateKeySync");
export const createPublicKey = unavailableFunction("createPublicKey");
export const createPrivateKey = unavailableFunction("createPrivateKey");
export const createDiffieHellman = unavailableFunction("createDiffieHellman");
export const createDiffieHellmanGroup = unavailableFunction("createDiffieHellmanGroup");
export const getDiffieHellman = unavailableFunction("getDiffieHellman");
export const diffieHellman = unavailableFunction("diffieHellman");
export const createECDH = unavailableFunction("createECDH");
export const publicEncrypt = unavailableFunction("publicEncrypt");
export const publicDecrypt = unavailableFunction("publicDecrypt");
export const privateEncrypt = unavailableFunction("privateEncrypt");
export const privateDecrypt = unavailableFunction("privateDecrypt");
export const checkPrime = unavailableFunction("checkPrime");
export const checkPrimeSync = unavailableFunction("checkPrimeSync");
export const generatePrime = unavailableFunction("generatePrime");
export const generatePrimeSync = unavailableFunction("generatePrimeSync");
export const setEngine = unavailableFunction("setEngine");
export const secureHeapUsed = unavailableFunction("secureHeapUsed");
export const setFips = unavailableFunction("setFips");

export const Sign = unavailableClass("Sign");
export const Verify = unavailableClass("Verify");
export const DiffieHellman = unavailableClass("DiffieHellman");
export const DiffieHellmanGroup = unavailableClass("DiffieHellmanGroup");
export const ECDH = unavailableClass("ECDH");
export const X509Certificate = unavailableClass("X509Certificate");

/** `crypto.Certificate` (SPKAC): the class and its static helpers all throw. */
export const Certificate = Object.assign(unavailableClass("Certificate"), {
  exportChallenge: unavailableFunction("Certificate.exportChallenge"),
  exportPublicKey: unavailableFunction("Certificate.exportPublicKey"),
  verifySpkac: unavailableFunction("Certificate.verifySpkac"),
});

/** `crypto.getCurves()`: no elliptic curves are available. */
export function getCurves(): string[] {
  return [];
}

/** `crypto.getFips()`: FIPS mode is off. */
export function getFips(): 0 {
  return 0;
}
