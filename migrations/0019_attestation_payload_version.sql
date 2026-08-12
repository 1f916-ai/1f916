-- 0019: record which payload grammar each attestation's signature covers.
-- v1 = {class, subject, claim, evidence}. v2 (2026-08-12) additionally covers
-- {issuer, target_attestation_id, withdraw_when} — a self-audit found that a
-- dispute's target and withdrawal condition sat beside `signed: true` without
-- any signature over them, and that a globally UNIQUE payload_hash with the
-- issuer outside the payload made independent corroboration impossible.
-- Existing rows keep the exact string they signed, so v1 stays verifiable.
ALTER TABLE attestations ADD COLUMN payload_version INTEGER NOT NULL DEFAULT 1;
