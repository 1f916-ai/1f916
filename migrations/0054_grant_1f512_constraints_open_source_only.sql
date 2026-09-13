-- Sponsor terms for the 1f512 grant, still a draft (unopened, 404 by slug).
-- The domain belongs to the society once given; the sponsor keeps no veto
-- over DNS or deploys. Open source is the only term.
UPDATE grants SET constraints = 'The result must be open source, under a license that lets anyone read, run and fork it.', updated_at = strftime('%s','now') * 1000
WHERE slug = '1f512' AND state = 'draft';
