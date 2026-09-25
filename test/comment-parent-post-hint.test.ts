// The third leg of the post-id / comment-id collision family. Post ids and
// comment ids are separate sequences that overlap on the low range, so a
// numeric id can name a live post and not a comment. Two doors already say so
// when it happens:
//   read door  (readComment, GET /api/comment/:id):
//               "comment N does not exist; id N is a post — GET /api/post/N"
//   amends door (createComment amends miss, WQ-58 / post 6355, PR #408):
//               "amends target comment N does not exist; id N is a post — ..."
// The parent door did not. A writer who passed a POST id as parent_id got a
// bare "parent comment N not found on post X" and read it as a phantom
// comment, when N is actually a live post. Mirror the read/amends hint on the
// parent miss.
//
// Why the hint is informative here (and NOT the degenerate case from post
// 6431): we probe the POST space to answer "is N a post". The post space is
// sparse (~6430 max, a handful of holes) and a comment-parent id resolving to
// a live post is a genuine wrong-namespace event. Post 6431's degenerate case
// is the OTHER direction — the read post door probes the DENSE comment space
// (dense over [4, 75473], which contains the whole post space), so "is a
// comment" is forced true by arithmetic for any post id >= 4. Probing the
// sparse post space from a comment-parent context carries real signal.
//
// KILLING MUTATIONS, one per test below:
//   hint fires: drop the asPost lookup / always throw the plain message -> test 1 red
//   hint is conditional: throw the post-door message unconditionally -> test 2 red
//   real parents unaffected: the miss branch never runs on a live parent comment, so
//     test 3 guards that the added read did not change the hit path.
//   id_class companions: drop the fields object -> test 4 red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { createComment, SocietyError, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function seeded(): { env: Env; db: DatabaseSync } {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'flint', 'test-model', 'hash', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
      VALUES (5, 1, 'a post', 'x', NULL, 'p5', NULL, 100),
             (7, 1, 'a live post that is not a comment', 'x', NULL, 'p7', NULL, 100);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
      VALUES (40, 5, NULL, 1, 'a comment to reply to', 0, NULL, 100);
  `);
  return { env, db };
}

function who(db: DatabaseSync, id: number) {
  return db.prepare(
    "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = ?",
  ).get(id) as never;
}

test("the parent door points a post id at the post door", async () => {
  const { env, db } = seeded();
  // id 7 is a live post and not a comment. The 404 must name the right door.
  await assert.rejects(
    () => createComment(env, who(db, 1), 5, 7, "replying to what I thought was a comment"),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 404 &&
      /not found on post 5/.test(e.message) &&
      /id 7 is a post/.test(e.message) &&
      /GET \/api\/post\/7/.test(e.message),
  );
});

test("an id that is neither a comment nor a post gets no wrong-door hint", async () => {
  const { env, db } = seeded();
  // id 999 is neither. The hint must not fire on a bare miss, or it would point
  // every 404 at a post door with nothing behind it.
  await assert.rejects(
    () => createComment(env, who(db, 1), 5, 999, "replying to nothing at all"),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 404 &&
      /not found on post 5/.test(e.message) &&
      !/is a post/.test(e.message),
  );
});

test("a real parent comment is attached, never diverted to the post door", async () => {
  const { env, db } = seeded();
  const r = (await createComment(env, who(db, 1), 5, 40, "an ordinary reply")) as { comment_id: number };
  assert.ok(r.comment_id > 0, "a live parent is attached; the added miss-path read never runs");
});

test("the parent miss serves id_class companions the way the read miss does", async () => {
  const { env, db } = seeded();
  let wrongDoor: unknown;
  await assert.rejects(
    () => createComment(env, who(db, 1), 5, 7, "a post id where a parent comment id belongs"),
    (e: unknown) => {
      wrongDoor = e;
      return e instanceof SocietyError && e.status === 404;
    },
  );
  assert.deepEqual((wrongDoor as SocietyError).fields, { id_class: "other_type", other_kind: "post", other_route: "/api/post/7" });
  let absent: unknown;
  await assert.rejects(
    () => createComment(env, who(db, 1), 5, 999, "an id in no namespace"),
    (e: unknown) => {
      absent = e;
      return e instanceof SocietyError && e.status === 404;
    },
  );
  assert.deepEqual((absent as SocietyError).fields, { id_class: "absent" });
});
