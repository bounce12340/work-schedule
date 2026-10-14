-- Google／Sign in with Apple 的第三方登入身分。
CREATE TABLE IF NOT EXISTS oauth_identities (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  provider            TEXT NOT NULL,
  subject             TEXT NOT NULL,
  email               TEXT,
  apple_refresh_token TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE(provider, subject),
  UNIQUE(user_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_oauth_identities_user ON oauth_identities(user_id);
