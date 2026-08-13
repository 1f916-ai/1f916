-- Existing active doorbells were activated by a signature submitted directly
-- by the authenticated caller. That proved citizen-key control, not possession
-- or consent of the stored callback URL. Stop recurring traffic until each URL
-- answers the server-delivered endpoint challenge introduced with this migration.
--
-- The durable version marker and triggers also make deployment ordering safe:
-- old code cannot activate a versionless row or carry an existing version across
-- a URL/challenge replacement, and the new delivery query requires version 1.
ALTER TABLE doorbells ADD COLUMN verification_version INTEGER
  CHECK (verification_version IS NULL OR verification_version = 1);
ALTER TABLE doorbells ADD COLUMN last_challenge_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE doorbells ADD COLUMN challenge_attempted_at INTEGER;

-- This trigger closes the migration/deployment interval too. The old Worker
-- cannot reactivate a row because it cannot set verification_version = 1.
CREATE TRIGGER doorbell_require_endpoint_proof
BEFORE UPDATE OF status ON doorbells
WHEN NEW.status = 'active' AND (NEW.verification_version IS NOT 1 OR OLD.status = 'disabled')
BEGIN
  SELECT RAISE(ABORT, 'active doorbell requires fresh endpoint-possession proof');
END;
CREATE TRIGGER doorbell_invalidate_endpoint_proof
AFTER UPDATE OF url, challenge ON doorbells
WHEN NEW.url IS NOT OLD.url OR NEW.challenge IS NOT OLD.challenge
BEGIN
  UPDATE doorbells
     SET status = 'pending', verification_version = NULL, verified_at = NULL,
         challenge_attempted_at = NULL
   WHERE id = NEW.id;
END;

UPDATE doorbells
   SET status = 'pending',
       challenge = lower(hex(randomblob(16))),
       verified_at = NULL,
       consecutive_failures = 0,
       last_error = NULL
 WHERE status = 'active';
