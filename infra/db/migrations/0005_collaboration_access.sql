ALTER TABLE collaboration_rooms ADD COLUMN role_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE collaboration_rooms ADD COLUMN max_members INTEGER NOT NULL DEFAULT 10;

CREATE TABLE collaboration_invitations (
  id          TEXT PRIMARY KEY,
  room_id     TEXT NOT NULL REFERENCES collaboration_rooms(id) ON DELETE CASCADE,
  created_by  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT UNIQUE NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  max_uses    INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 25),
  use_count   INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_collaboration_invitations_room
  ON collaboration_invitations(room_id, created_at DESC);

-- One claim per invitation/user makes retries idempotent. Claim, membership
-- creation, and use-count reconciliation are executed in one D1 batch.
CREATE TABLE collaboration_invitation_claims (
  invitation_id TEXT NOT NULL REFERENCES collaboration_invitations(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claimed_at    INTEGER NOT NULL,
  PRIMARY KEY (invitation_id, user_id)
);

CREATE INDEX idx_collaboration_invitation_claims_user
  ON collaboration_invitation_claims(user_id, claimed_at DESC);
