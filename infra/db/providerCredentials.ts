/**
 * Bring-your-own-key credentials for third-party narration providers
 * (migrations/0015_athanlab_credentials.sql). The Worker seals each key with
 * AES-256-GCM before it gets here (worker/athanlab/keyVault.ts), so these
 * queries only ever see ciphertext, its nonce, and a four-character hint.
 */

export type CredentialProvider = "athanlab";

export interface ProviderCredentialRow {
  user_id: string;
  provider: CredentialProvider;
  /** base64 AES-GCM ciphertext + tag. */
  ciphertext: string;
  /** base64 12-byte nonce, fresh for every seal. */
  iv: string;
  key_version: number;
  /** The key's last four characters, for display only. */
  key_hint: string;
  /** epoch ms of the provider's 401; null while the key is usable. */
  invalidated_at: number | null;
  /** The first-contact lease holder's random id; null while nobody holds it. */
  probe_token: string | null;
  /** epoch ms the lease lapses if its holder never releases it. */
  probe_until: number | null;
  created_at: number;
  updated_at: number;
}

export interface PutProviderCredentialParams {
  userId: string;
  provider: CredentialProvider;
  ciphertext: string;
  iv: string;
  keyVersion: number;
  keyHint: string;
  /** epoch ms; becomes updated_at, and created_at for a first key. */
  now: number;
}

export async function getProviderCredential(
  db: D1Database,
  userId: string,
  provider: CredentialProvider,
): Promise<ProviderCredentialRow | null> {
  const row = await db
    .prepare("SELECT * FROM user_provider_credentials WHERE user_id = ? AND provider = ?")
    .bind(userId, provider)
    .first<ProviderCredentialRow>();
  return row ?? null;
}

/**
 * Store a newly verified key, replacing any earlier one. The row keeps its
 * original created_at, and a replacement clears invalidated_at and any
 * first-contact lease: the new key is the one the provider just accepted, and
 * a lease taken for the old key says nothing about it.
 */
export async function putProviderCredential(
  db: D1Database,
  params: PutProviderCredentialParams,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_provider_credentials
         (user_id, provider, ciphertext, iv, key_version, key_hint, invalidated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(user_id, provider) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         iv = excluded.iv,
         key_version = excluded.key_version,
         key_hint = excluded.key_hint,
         invalidated_at = NULL,
         probe_token = NULL,
         probe_until = NULL,
         updated_at = excluded.updated_at`,
    )
    .bind(
      params.userId,
      params.provider,
      params.ciphertext,
      params.iv,
      params.keyVersion,
      params.keyHint,
      params.now,
      params.now,
    )
    .run();
}

/**
 * Mark a stored key dead after the provider answered 401 for it, so it is
 * never sent again. Pass the `iv` of the row that was used: every seal draws a
 * fresh nonce, so a key the user replaced while that request was in flight is
 * left alone instead of being invalidated for the old key's failure.
 */
export async function invalidateProviderCredential(
  db: D1Database,
  userId: string,
  provider: CredentialProvider,
  at: number,
  iv?: string,
): Promise<void> {
  if (iv === undefined) {
    await db
      .prepare(
        `UPDATE user_provider_credentials SET invalidated_at = ?
         WHERE user_id = ? AND provider = ? AND invalidated_at IS NULL`,
      )
      .bind(at, userId, provider)
      .run();
    return;
  }
  await db
    .prepare(
      `UPDATE user_provider_credentials SET invalidated_at = ?
       WHERE user_id = ? AND provider = ? AND iv = ? AND invalidated_at IS NULL`,
    )
    .bind(at, userId, provider, iv)
    .run();
}

/**
 * Take the first-contact lease on a usable stored key: the right to be the
 * one request that sends it until the provider has answered. Succeeds only
 * when nobody holds a live lease (a lease past `probe_until` is taken over, so
 * a holder that died frees the key by itself), the key has not been
 * invalidated, and the stored key is still the one the caller decrypted (`iv`
 * names the seal): a request still carrying a key the user has since replaced
 * never gets to send it. One conditional UPDATE, so of any number of
 * concurrent callers exactly one wins.
 */
export async function acquireCredentialProbe(
  db: D1Database,
  userId: string,
  provider: CredentialProvider,
  iv: string,
  token: string,
  now: number,
  leaseMs: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE user_provider_credentials SET probe_token = ?, probe_until = ?
       WHERE user_id = ? AND provider = ? AND iv = ? AND invalidated_at IS NULL
         AND (probe_until IS NULL OR probe_until < ?)`,
    )
    .bind(token, now + leaseMs, userId, provider, iv, now)
    .run();
  return result.meta.changes > 0;
}

/** Give the lease back; a lease someone else has taken over is left alone. */
export async function releaseCredentialProbe(
  db: D1Database,
  userId: string,
  provider: CredentialProvider,
  token: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE user_provider_credentials SET probe_token = NULL, probe_until = NULL
       WHERE user_id = ? AND provider = ? AND probe_token = ?`,
    )
    .bind(userId, provider, token)
    .run();
}

export async function deleteProviderCredential(
  db: D1Database,
  userId: string,
  provider: CredentialProvider,
): Promise<void> {
  await db
    .prepare("DELETE FROM user_provider_credentials WHERE user_id = ? AND provider = ?")
    .bind(userId, provider)
    .run();
}
