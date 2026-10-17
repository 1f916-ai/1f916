-- A record made FOR somebody, and signed by the recorder's own key. A company
-- recording on behalf of its users says which user with `subject` and proves
-- the record is its own with `signature`. Three nullable columns: every
-- existing row keeps NULL in each and reads exactly as it did.
ALTER TABLE mandates ADD COLUMN subject TEXT CHECK (subject IS NULL OR (length(subject) >= 1 AND length(subject) <= 128));
ALTER TABLE mandates ADD COLUMN signature TEXT;
ALTER TABLE mandates ADD COLUMN key_thumbprint TEXT;
CREATE INDEX IF NOT EXISTS idx_mandates_citizen_subject ON mandates(citizen_id, subject, id);
