import type { ProviderCredentialRow } from "../../db/providerCredentials";
import type { Env } from "../env";

/**
 * Seals users' AthanLab API keys for D1 with AES-256-GCM under the Worker
 * secret ATHANLAB_KEY_ENCRYPTION_SECRET (base64 of exactly 32 random bytes).
 *
 * AthanLab's API terms (§7) allow keys to be used only from servers the
 * developer controls, so a key pasted into Studio is sealed here, stored only
 * as ciphertext, and opened only inside the Worker for the request that sends
 * it to AthanLab. The associated data binds each ciphertext to its key version
 * and to the user who stored it, so a row copied onto another user's id does
 * not open. Rotating the secret leaves every stored row unreadable: users then
 * connect their key again (the routes report such a row as `key_stale`).
 */

export const ATHANLAB_KEY_VERSION = 1;

const IV_BYTES = 12;
const SECRET_BYTES = 32;
// Canonical standard base64 of 32 bytes: 43 symbols and one "=" of padding,
// which is what `openssl rand -base64 32` prints.
const SECRET_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export interface KeyVault {
  /** The non-extractable AES-256-GCM key, imported once per secret. */
  cryptoKey(): Promise<CryptoKey>;
}

export interface SealedApiKey {
  ciphertext: string;
  iv: string;
  keyVersion: typeof ATHANLAB_KEY_VERSION;
}

// Only one secret is configured per deployment, so a single entry caches the
// imported key for the life of the isolate; a different secret replaces it.
let cachedVault: { secret: string; vault: KeyVault } | null = null;

/**
 * The vault for this Worker's configured secret, or null when the secret is
 * missing or is not base64 of exactly 32 bytes. AthanLab narration fails
 * closed without one.
 */
export function keyVaultOf(env: Pick<Env, "ATHANLAB_KEY_ENCRYPTION_SECRET">): KeyVault | null {
  const secret = env.ATHANLAB_KEY_ENCRYPTION_SECRET?.trim();
  if (!secret || !SECRET_PATTERN.test(secret)) return null;
  if (cachedVault?.secret === secret) return cachedVault.vault;

  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = bytesOfBase64(secret);
  } catch {
    return null;
  }
  if (raw.length !== SECRET_BYTES) return null;

  // Imported on first use, not here: the capability check only asks whether a
  // vault exists, and must not leave a pending import behind.
  let imported: Promise<CryptoKey> | null = null;
  const vault: KeyVault = {
    cryptoKey() {
      imported ??= crypto.subtle
        .importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
        .catch((error: unknown) => {
          imported = null;
          throw error;
        });
      return imported;
    },
  };
  cachedVault = { secret, vault };
  return vault;
}

function additionalDataOf(keyVersion: number, userId: string): Uint8Array<ArrayBuffer> {
  return encodeUtf8(`next-editor:athanlab-api-key:v${keyVersion}:${userId}`);
}

/** Encrypt `apiKey` for `userId` under a fresh random nonce. */
export async function sealApiKey(
  vault: KeyVault,
  userId: string,
  apiKey: string,
): Promise<SealedApiKey> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalDataOf(ATHANLAB_KEY_VERSION, userId) },
    await vault.cryptoKey(),
    encodeUtf8(apiKey),
  );
  return {
    ciphertext: base64Of(new Uint8Array(ciphertext)),
    iv: base64Of(iv),
    keyVersion: ATHANLAB_KEY_VERSION,
  };
}

/**
 * Decrypt a stored key. Rejects when the row was tampered with, belongs to
 * another user, was sealed under another secret, or has a key version this
 * build cannot open.
 */
export async function openApiKey(
  vault: KeyVault,
  userId: string,
  row: Pick<ProviderCredentialRow, "ciphertext" | "iv" | "key_version">,
): Promise<string> {
  if (row.key_version !== ATHANLAB_KEY_VERSION) {
    throw new Error("unsupported AthanLab key version");
  }
  const iv = bytesOfBase64(row.iv);
  if (iv.length !== IV_BYTES) throw new Error("malformed AthanLab key nonce");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: additionalDataOf(row.key_version, userId) },
    await vault.cryptoKey(),
    bytesOfBase64(row.ciphertext),
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
}

/** UTF-8 bytes typed as WebCrypto's BufferSource wants: always a plain ArrayBuffer. */
function encodeUtf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

function base64Of(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** Decode standard base64; throws on characters outside its alphabet. */
function bytesOfBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
