-- passkey_credentials: WebAuthn credentials, N per user. A passkey is an
-- additional sign-in method for an existing account (accounts are still
-- created via Google sign-in — see users.google_sub), so registration always
-- happens inside an authenticated session.
CREATE TABLE passkey_credentials (
  id            TEXT PRIMARY KEY,   -- base64url credential id (WebAuthn rawId)
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key    TEXT NOT NULL,      -- base64url COSE public key
  counter       INTEGER NOT NULL,   -- signature counter (many passkey providers keep this at 0)
  transports    TEXT,               -- JSON array of AuthenticatorTransport strings, or NULL
  created_at    INTEGER NOT NULL,   -- epoch ms
  last_used_at  INTEGER             -- epoch ms; NULL until first sign-in
);

CREATE INDEX idx_passkey_credentials_user ON passkey_credentials(user_id);
