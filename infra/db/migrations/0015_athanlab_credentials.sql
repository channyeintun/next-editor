-- Per-user third-party API credentials (bring-your-own-key), encrypted by the
-- Worker with AES-256-GCM. Plaintext keys never reach D1 or the browser.
CREATE TABLE user_provider_credentials (
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL CHECK (provider IN ('athanlab')),
  ciphertext     TEXT NOT NULL,  -- base64 AES-GCM ciphertext + tag
  iv             TEXT NOT NULL,  -- base64 12-byte nonce
  key_version    INTEGER NOT NULL,
  key_hint       TEXT NOT NULL,  -- last 4 characters, for display only
  invalidated_at INTEGER,        -- epoch ms of the provider's 401; NULL = usable
  -- The first-contact lease: the one request at a time allowed to send this
  -- key until the provider has answered, so concurrent requests carrying a
  -- revoked key do not each cost a failed authentication.
  probe_token    TEXT,           -- random id of the holder; NULL = free
  probe_until    INTEGER,        -- epoch ms the lease lapses if never released
  created_at     INTEGER NOT NULL, -- epoch ms
  updated_at     INTEGER NOT NULL, -- epoch ms
  PRIMARY KEY (user_id, provider)
);

-- One row per provider: failed authentications from our shared egress in the
-- current fixed window (each key check counts from the moment it is admitted
-- until it ends without a 401), and when the provider stops blocking us.
CREATE TABLE provider_auth_breaker (
  provider          TEXT PRIMARY KEY CHECK (provider IN ('athanlab')),
  window_started_at INTEGER NOT NULL, -- epoch ms
  failures          INTEGER NOT NULL,
  blocked_until     INTEGER NOT NULL DEFAULT 0 -- epoch ms
);
