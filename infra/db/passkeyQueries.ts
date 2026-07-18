import type { PasskeyCredentialRow, UserRow } from "./types";

export interface InsertPasskeyParams {
  /** base64url credential id — the WebAuthn rawId. */
  id: string;
  userId: string;
  /** base64url COSE public key. */
  publicKey: string;
  counter: number;
  transports: string[] | null;
}

export async function insertPasskeyCredential(
  db: D1Database,
  params: InsertPasskeyParams,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO passkey_credentials (id, user_id, public_key, counter, transports, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      params.id,
      params.userId,
      params.publicKey,
      params.counter,
      params.transports ? JSON.stringify(params.transports) : null,
      Date.now(),
    )
    .run();
}

export async function listPasskeyCredentials(
  db: D1Database,
  userId: string,
): Promise<PasskeyCredentialRow[]> {
  const result = await db
    .prepare("SELECT * FROM passkey_credentials WHERE user_id = ? ORDER BY created_at")
    .bind(userId)
    .all<PasskeyCredentialRow>();
  return result.results;
}

/**
 * Resolves a login assertion's credential id to the credential row and its
 * owning user in one call — sign-in has no session yet, so the credential is
 * the only key available.
 */
export async function getPasskeyCredentialWithUser(
  db: D1Database,
  credentialId: string,
): Promise<{ credential: PasskeyCredentialRow; user: UserRow } | null> {
  const credential = await db
    .prepare("SELECT * FROM passkey_credentials WHERE id = ?")
    .bind(credentialId)
    .first<PasskeyCredentialRow>();
  if (!credential) return null;

  const user = await db
    .prepare("SELECT * FROM users WHERE id = ?")
    .bind(credential.user_id)
    .first<UserRow>();
  if (!user) return null;

  return { credential, user };
}

export async function updatePasskeyCredentialAfterAuth(
  db: D1Database,
  credentialId: string,
  counter: number,
): Promise<void> {
  await db
    .prepare("UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE id = ?")
    .bind(counter, Date.now(), credentialId)
    .run();
}
