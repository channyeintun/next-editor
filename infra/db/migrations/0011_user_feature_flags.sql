-- Per-user, server-enforced product capabilities. A missing row is disabled.
-- Keeping this generic avoids adding a users-table column for every private
-- rollout while the composite primary key guarantees one decision per user.
CREATE TABLE user_feature_flags (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature_key  TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_at   INTEGER NOT NULL, -- epoch ms
  PRIMARY KEY (user_id, feature_key)
);

CREATE INDEX idx_user_feature_flags_feature
  ON user_feature_flags(feature_key, enabled);
