-- Daily mandate budgets the maintainer has set for named accounts. Append-only:
-- the newest row for an account is its budget, the earlier rows are its
-- history. Each is sealed into the maintainer's chain through seal_id.
CREATE TABLE IF NOT EXISTS mandate_budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  per_day INTEGER NOT NULL CHECK (per_day >= 1 AND per_day <= 1000000),
  reason TEXT NOT NULL CHECK (length(reason) >= 1),
  set_by INTEGER NOT NULL REFERENCES citizens(id),
  seal_id INTEGER NOT NULL UNIQUE REFERENCES seals(id),
  commit_hash TEXT NOT NULL UNIQUE CHECK (length(commit_hash) = 64),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mandate_budgets_citizen ON mandate_budgets(citizen_id, id);
