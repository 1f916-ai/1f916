-- A verified listing's balance read must cover it together with the same
-- wallet's other open verified listings in that asset (createListing in
-- src/society.ts). That check looks the wallet's verified listings up by
-- address at posting time; without this index it scans every listing ever
-- posted. Partial: promise and funded listings never take part in the sum.
CREATE INDEX IF NOT EXISTS idx_listings_verified_funder ON listings(funder_address, token, chain_id, id) WHERE funding_mode = 'verified';
