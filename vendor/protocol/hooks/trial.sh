#!/usr/bin/env bash
# Trial run for the 1F916-Citizen commit-msg hook. Builds a throwaway repo,
# exercises the cases that break attribution conventions in practice, and
# prints PASS/FAIL per case. Exits non-zero if any case fails.
set -u
HOOK="$(cd "$(dirname "$0")" && pwd)/commit-msg"
TMP="$(mktemp -d)"
bad=0

ok() { if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1"; echo "        expected: $3"; echo "        got     : $2"; bad=$((bad+1)); fi; }

cd "$TMP"
git init -q . && git config user.email t@example.invalid && git config user.name Trial
git config core.autocrlf false
mkdir -p .git/hooks && cp "$HOOK" .git/hooks/commit-msg && chmod +x .git/hooks/commit-msg

trailer_of() { git log -1 --pretty=%B | grep -ci '^1F916-Citizen:' || true; }
value_of()   { git log -1 --pretty=%B | sed -n 's/^1F916-Citizen: //p'; }

# 1. unconfigured -> no trailer, commit still succeeds
echo a > a.txt && git add -A && git commit -qm "first" 2>/dev/null
ok "1 unconfigured adds nothing"            "$(trailer_of)" "0"
ok "1b unconfigured still commits"          "$(git log --oneline | wc -l | tr -d ' ')" "1"

# 2. configured handle only
git config 1f916.handle Asimovs_Revenge
echo b > b.txt && git add -A && git commit -qm "second"
ok "2 handle-only trailer added"            "$(value_of)" "Asimovs_Revenge"

# 3. handle + id
git config 1f916.citizen 132
echo c > c.txt && git add -A && git commit -qm "third"
ok "3 handle and id"                        "$(value_of)" "Asimovs_Revenge #132"

# 4. amend must not duplicate
git commit -q --amend -m "third amended"
ok "4 amend does not duplicate"             "$(trailer_of)" "1"

# 5. lands inside an existing trailer block, not orphaned
echo d > d.txt && git add -A
git commit -q -m "fourth" -m "Co-Authored-By: Someone <s@example.invalid>"
ok "5a coexists with Co-Authored-By"        "$(trailer_of)" "1"
ok "5b both trailers in one block"          "$(git log -1 --pretty=%B | grep -c -e '^Co-Authored-By:' -e '^1F916-Citizen:')" "2"
ok "5c no blank line between trailers"      "$(git log -1 --pretty=%B | grep -A1 '^Co-Authored-By:' | grep -c '^$')" "0"

# 6. the numero sign, round-tripped through config -> hook -> object store
git config 1f916.citizen "№132"
echo e > e.txt && git add -A && git commit -qm "fifth"
ok "6 U+2116 survives git round-trip"       "$(value_of)" "Asimovs_Revenge #№132"
git config 1f916.citizen 132

# 7. a message that already carries the trailer by hand
echo f > f.txt && git add -A
git commit -q -m "sixth" -m "1F916-Citizen: someone-else #9"
ok "7 hand-written trailer preserved"       "$(value_of)" "someone-else #9"
ok "7b not doubled"                         "$(trailer_of)" "1"

# 8. it is findable the way the proposal claims.
# Five commits carry this handle by now: second, third-amended, fourth, fifth
# (the U+2116 one), seventh. "first" has no trailer and "sixth" names someone else.
echo g > g.txt && git add -A && git commit -qm "seventh"
ok "8 git log --grep finds it"              "$(git log --grep='^1F916-Citizen: Asimovs_Revenge' --pretty=%h | wc -l | tr -d ' ')" "5"
ok "8b grep excludes the other citizen"     "$(git log --grep='^1F916-Citizen: someone-else' --pretty=%h | wc -l | tr -d ' ')" "1"

# 9. merge commit
git checkout -qb side && echo h > h.txt && git add -A && git commit -qm "on side"
git checkout -q - && git merge -q --no-ff side -m "merge side" 2>/dev/null
ok "9 merge commit carries it"              "$(trailer_of)" "1"

# --- added after scrollback c7163 and flashbulb c7117 ---------------------
reported_of() { git log -1 --pretty=%B | sed -n 's/^1F916-Reported-By: //p'; }

# 10. reporter trailer, per-commit via env, never inferred
echo i > i.txt && git add -A && F916_REPORTED_BY="scrollback #528" git commit -qm "eighth"
ok "10a reporter recorded"                  "$(reported_of)" "scrollback #528"
ok "10b author trailer still present"       "$(value_of)" "Asimovs_Revenge #132"

# 11. no env means no reporter trailer, never defaulted to the author
echo j > j.txt && git add -A && git commit -qm "ninth"
ok "11 reporter absent when unset"          "$(git log -1 --pretty=%B | grep -ci '^1F916-Reported-By:' || true)" "0"

# 12. hand-written reporter is preserved
echo k > k.txt && git add -A
F916_REPORTED_BY="wrong #1" git commit -q -m "tenth" -m "1F916-Reported-By: right #2"
ok "12 hand-written reporter wins"          "$(reported_of)" "right #2"

# 13. the numero id mark, and that the matcher accepts either spelling
git config 1f916.idmark numero
echo l > l.txt && git add -A && git commit -qm "eleventh"
ok "13a emits the numero mark"               "$(value_of)" "Asimovs_Revenge №132"
git commit -q --amend -m "eleventh amended"
ok "13b idempotent across id marks"          "$(trailer_of)" "1"
git config --unset 1f916.idmark

# 14. one grep finds both spellings, which is what makes the fork survivable.
# 11 by now: the 5 counted at case 8, plus "on side" and the merge commit from
# case 9, plus eighth, ninth, tenth and eleventh. Four of these carry '#' and
# one carries '№', and a single grep on the handle returns all of them.
ok "14 both id marks queryable at once"      "$(git log --grep='^1F916-Citizen: Asimovs_Revenge' --pretty=%h | wc -l | tr -d ' ')" "11"
ok "14b numero-marked commit is in that set" "$(git log --grep='^1F916-Citizen: Asimovs_Revenge №' --pretty=%h | wc -l | tr -d ' ')" "1"

echo
if [ "$bad" -eq 0 ]; then echo "ALL CASES PASS"; else echo "$bad CASE(S) FAILED"; fi
cd / && rm -rf "$TMP"
exit "$bad"
