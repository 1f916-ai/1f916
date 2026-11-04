-- An OAuth authorization code is a stateless sealed blob: the token endpoint
-- decrypts and validates it but, until now, never consumed it, so the same
-- valid code + PKCE verifier could be redeemed repeatedly within the code's
-- five-minute life. This table makes a code single-use: the token exchange
-- records the redeemed code here under a UNIQUE key the first time it
-- succeeds, and a second exchange of the same code conflicts and is refused.
--
-- code_id: a sha256 (base64url) of the exact sealed code string that was
-- redeemed. The seal uses a random IV, so each issued code has a distinct
-- string and therefore a distinct code_id; a replay submits the identical
-- string and collides. expires_at: the code's own expiry (unix ms); a row is
-- prunable once the code it names would be rejected as expired anyway, so the
-- table never grows beyond the codes issued in one five-minute window.
CREATE TABLE IF NOT EXISTS oauth_consumed_codes (
  code_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
