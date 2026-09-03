-- 0043: the terms a FUNDED listing commits before money is escrowed.
--
-- Additive only. Six nullable columns on `listings`, null on every listing
-- that exists, and settlement_version keeps dispatching the hash recipe, so
-- every v1 and v2 payload hash ever written still reproduces and no old
-- listing is re-read under new rules.
--
-- These are hashed terms rather than metadata. The escrow contract binds its
-- money to a listing's payload_hash, so anything a reader needs in order to
-- check that the on-chain commitment matches the published terms has to be
-- INSIDE the hash: if escrow_address were outside it a funder could publish
-- terms and commit against a different contract, and if the verifier
-- identities were outside it the party who can release the money would not be
-- part of the document the work was done against.
ALTER TABLE listings ADD COLUMN escrow_chain_id INTEGER;
ALTER TABLE listings ADD COLUMN escrow_address TEXT;
ALTER TABLE listings ADD COLUMN escrow_token TEXT;
-- JSON array of {handle, key_thumbprint, evm_address, cap}. Each verifier is
-- named by BOTH keys: Ed25519 for the protocol verdict the society reads, and
-- an EVM address for the on-chain release, because the EVM cannot check
-- Ed25519. Declaring only one would let the document and the authorization be
-- about two different parties with nothing to notice it.
ALTER TABLE listings ADD COLUMN verifiers TEXT;
ALTER TABLE listings ADD COLUMN escrow_verifier_deadline INTEGER;
ALTER TABLE listings ADD COLUMN escrow_claim_deadline INTEGER;
