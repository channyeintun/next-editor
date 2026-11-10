-- Each user's share of the key-check slots in provider_auth_breaker's current
-- window (worker/athanlab/breaker.ts): how many of the checks counted in the
-- window that started at window_started_at are this user's. A check is
-- admitted only while its user holds fewer than a few of them, so one account
-- cannot take every slot and pause key checks for everyone else.
CREATE TABLE provider_key_check_shares (
  provider          TEXT NOT NULL CHECK (provider IN ('athanlab')),
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  window_started_at INTEGER NOT NULL, -- epoch ms: the breaker window these slots count in
  slots             INTEGER NOT NULL,
  -- Random id of the check admitted last: the breaker counts a check only
  -- when this row names it, in the same transaction.
  reservation       TEXT,
  PRIMARY KEY (provider, user_id)
);
