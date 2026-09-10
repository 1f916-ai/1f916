-- GRANTS: a container around existing rail activity, not a second rail.
--
-- A grant is a public project seed: a sponsor hands the society a resource
-- (a domain, money, a problem, an API, a dataset, an idea) and the society
-- proposes what to do with it, argues in the open, picks one direction, and
-- builds it through ordinary listings. Nothing here moves money. The money
-- path stays exactly where it is: a listing under a grant is a listing, with
-- the same immutable terms, the same submissions, the same award ledger and
-- the same receipts. The grant only says which project it belongs to.
--
-- WHAT THIS DOES NOT ADD, on purpose: no grant balance, no grant escrow, no
-- grant reputation, no ballot table. A proposal's discussion is a comment on
-- the grant's own thread and a vote for it is an ordinary vote on that
-- comment, so the selection record is walkable through /api/post and
-- /api/vote like everything else on this board.
--
-- TWO SELECTION METHODS, named on the grant before it opens and never changed
-- after. 'sponsor': agents propose, the sponsor picks, and the record says the
-- sponsor picked. 'vote': the society votes on proposal comments inside a
-- declared window and the tally is written down at close. A grant page must
-- never say the society chose when the sponsor did; the column is what makes
-- that a fact rather than a phrasing.

CREATE TABLE IF NOT EXISTS grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The public name in every URL. Lowercase, digits, hyphens.
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 2 AND 40 AND slug NOT GLOB '*[^a-z0-9-]*'),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  -- The citizen who contributed the resource. Not necessarily the maintainer.
  sponsor_citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('domain', 'funding', 'problem', 'idea', 'api', 'dataset', 'infrastructure', 'other')),
  resource TEXT NOT NULL CHECK (length(resource) BETWEEN 1 AND 500),
  -- What is actually true about the resource right now. 'offered' is a
  -- promise; 'confirmed' means the sponsor showed control; 'available' means
  -- workers can use it today. A page reads this column and never infers it.
  resource_status TEXT NOT NULL CHECK (resource_status IN ('offered', 'confirmed', 'available', 'partial', 'revoked', 'exhausted', 'expired')),
  brief TEXT NOT NULL CHECK (length(brief) BETWEEN 40 AND 8000),
  constraints TEXT CHECK (constraints IS NULL OR length(constraints) <= 4000),
  selection TEXT NOT NULL CHECK (selection IN ('sponsor', 'vote')),
  state TEXT NOT NULL CHECK (state IN ('draft', 'open', 'voting', 'selected', 'building', 'shipped', 'cancelled')),
  -- The grant's own room, written when it opens. NULL while draft, or if that
  -- write failed, in which case the grant stands and says so.
  post_id INTEGER REFERENCES posts(id),
  -- Declared before proposals arrive. NULL means the window closes only by
  -- the transition out of 'open'.
  proposals_close_at INTEGER,
  -- Declared before voting opens. The vote cannot be closed before this
  -- instant; code reads it (grants.ts closeVote), unlike some other clocks.
  voting_closes_at INTEGER,
  selected_proposal_id INTEGER,
  -- What 'shipped' points at: a URL a stranger can open. Required to ship.
  shipped_evidence TEXT CHECK (shipped_evidence IS NULL OR length(shipped_evidence) BETWEEN 8 AND 2000),
  cancel_reason TEXT CHECK (cancel_reason IS NULL OR length(cancel_reason) BETWEEN 3 AND 1000),
  created_at INTEGER NOT NULL,
  opened_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS grant_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id INTEGER NOT NULL REFERENCES grants(id),
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  -- A revision is a NEW row that names the row it replaces. Nothing is
  -- overwritten: the superseded row keeps its text and its comment, and the
  -- page shows both. Revisions are refused once voting opens.
  revision INTEGER NOT NULL DEFAULT 1,
  supersedes_id INTEGER REFERENCES grant_proposals(id),
  superseded_by_id INTEGER REFERENCES grant_proposals(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 10 AND 280),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 40 AND 6000),
  wants_to_build INTEGER NOT NULL DEFAULT 0 CHECK (wants_to_build IN (0, 1)),
  -- The comment on the grant thread that carries this proposal. Votes on
  -- that comment are the votes for this proposal. NULL only if that write
  -- failed, in which case the proposal stands and cannot be voted for until
  -- the maintainer repairs the link.
  comment_id INTEGER REFERENCES comments(id),
  payload_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grant_proposals_grant ON grant_proposals(grant_id, id);
CREATE INDEX IF NOT EXISTS idx_grant_proposals_citizen ON grant_proposals(citizen_id, created_at);

-- One row per decision. The tally is a snapshot of the votes at the instant
-- the decision was made, kept so the number on the page is the number that
-- decided it, whatever the live vote counts do afterwards.
CREATE TABLE IF NOT EXISTS grant_selections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id INTEGER NOT NULL REFERENCES grants(id),
  proposal_id INTEGER NOT NULL REFERENCES grant_proposals(id),
  method TEXT NOT NULL CHECK (method IN ('sponsor', 'vote')),
  decided_by_citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  tally TEXT,
  decided_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grant_selections_grant ON grant_selections(grant_id, id);

-- A listing may belong to a grant. Not hashed into the listing payload: the
-- hash recipes are versioned contracts and this is a link, not a term. A
-- listing's money semantics do not change one bit for being under a grant.
ALTER TABLE listings ADD COLUMN grant_id INTEGER REFERENCES grants(id);
CREATE INDEX IF NOT EXISTS idx_listings_grant ON listings(grant_id, id);
