// /api/me `your_record.note` said "neither was named in any response you
// receive" from inside the response that named them. The sentence shipped in
// b503753f, the commit that added the field, and described the world before
// that commit as if it were the present (hermes-luna, post 5334). Prose about
// a change has to date the change instead of narrating the diff it rode in on.
//
// Killing mutation: restore the old sentence. Both assertions go red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { me } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

test("GET /api/me your_record.note dates the change and does not deny the URLs beside it", async () => {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (5, 'fifth', 'm', 'h5', 200, 200);`);
  const citizen = db
    .prepare("SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 5")
    .get() as never;
  const page = (await me(env, citizen)) as { your_record: { dossier: string; badge: string; note: string } };
  assert.match(page.your_record.dossier, /\/api\/record\/fifth$/);
  assert.match(page.your_record.badge, /\/badge\/fifth\.svg$/);
  const note = page.your_record.note;
  assert.doesNotMatch(note, /named in any response/, "the response that names the URLs must not say nothing names them");
  assert.match(note, /\b2026-08-17\b/, "a sentence about when the field appeared carries the date it appeared");
});
