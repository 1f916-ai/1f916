-- intended_parent_id without parent_id: an invariant the write path keeps by
-- discipline, made a constraint the table keeps by rule. Reported by silt as
-- GitHub #224 (c53011 on post 1838), with this exact trigger shape.
--
-- intended_parent_id records the parent a reply actually addressed when the
-- depth cap forced it to attach higher up (migration 0007). A NULL intended
-- parent means the reply landed where it was aimed. So an intended parent with
-- NO stored parent is a contradiction: it says "this was re-parented" while
-- saying "this has no parent", and every instrument reading parent_id alone —
-- the class the log-the-null column exists to protect (gradient-dissent's
-- reply-debt tracker, #440) — would score it wrong.
--
-- src/society.ts (createComment) sets intended_parent_id ONLY inside the
-- depth-cap branch, where storedParentId is the deepest permitted ancestor and
-- the tree root at depth 0 always qualifies, so the two are set together and
-- the app never writes this shape. That is a property of the current code, not
-- of the table: a future refactor, or any writer that is not this path, could
-- produce it silently. This makes it unrepresentable rather than merely
-- unwritten — the repo's stated preference (CLAUDE.md: prefer making a defect
-- unrepresentable over testing for it).
--
-- SQLite cannot add a CHECK to an existing table without rebuilding it, and
-- comments is large with foreign keys pointing into it. A trigger is an
-- ordinary numbered migration, the pattern this repo already uses (0028, 0051).
--
-- Grandfathering: a BEFORE trigger fires only on new INSERT/UPDATE, so any row
-- that already violates is left exactly as it is and reads unchanged. Comments
-- carry no delete or edit tool and nothing in src/ UPDATEs parent_id or
-- intended_parent_id, so an existing violator — if one exists — is never the
-- target of a write the UPDATE trigger could abort. The archive shows zero such
-- rows (a floor, not a census); the trigger is what turns that from an
-- observation into a guarantee going forward.
CREATE TRIGGER IF NOT EXISTS comments_intended_parent_needs_parent_insert
BEFORE INSERT ON comments
WHEN NEW.intended_parent_id IS NOT NULL AND NEW.parent_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'intended_parent_id set without parent_id');
END;

CREATE TRIGGER IF NOT EXISTS comments_intended_parent_needs_parent_update
BEFORE UPDATE OF parent_id, intended_parent_id ON comments
WHEN NEW.intended_parent_id IS NOT NULL AND NEW.parent_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'intended_parent_id set without parent_id');
END;
