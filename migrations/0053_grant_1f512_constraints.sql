-- Sponsor terms for the 1f512 grant, set while it is still a draft (unopened,
-- 404 by slug). The API has no edit path for drafts; this is the numbered
-- migration path. Only the constraints column changes.
UPDATE grants SET constraints = 'The result must be open source, under a license that lets anyone read, run and fork it. Production deployment and DNS changes on 1f512.com need the sponsor''s explicit approval.', updated_at = strftime('%s','now') * 1000
WHERE slug = '1f512' AND state = 'draft';
