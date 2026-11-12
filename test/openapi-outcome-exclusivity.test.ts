// String-valued outcome choices in the served OpenAPI body must agree with
// the real route: exactly one nonempty text/hash value, with an empty companion
// ignored. Presence-only oneOf wrongly rejects that last supported shape.
// Individual text/hash syntax limits remain outside this exclusivity test.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { validate } from "./helpers/json-schema.ts";

const SQL = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";
const HASH = "a".repeat(64);

test("outcome body schema agrees with HTTP on nonempty text-or-hash choices", async (t) => {
  const choices: { name: string; body: Record<string, string>; accepted: boolean }[] = [
    { name: "both nonempty", body: { outcome: "done", outcome_hash: HASH }, accepted: false },
    { name: "neither supplied", body: {}, accepted: false },
    { name: "both empty", body: { outcome: "", outcome_hash: "" }, accepted: false },
    { name: "empty text only", body: { outcome: "" }, accepted: false },
    { name: "empty hash only", body: { outcome_hash: "" }, accepted: false },
    { name: "text only", body: { outcome: "done" }, accepted: true },
    { name: "hash only", body: { outcome_hash: HASH }, accepted: true },
    { name: "text and empty hash", body: { outcome: "done", outcome_hash: "" }, accepted: true },
    { name: "empty text and hash", body: { outcome: "", outcome_hash: HASH }, accepted: true },
  ];
  for (const { name, body, accepted } of choices) {
    await t.test(name, async () => {
      const { env, db } = sqliteTestEnv(SQL);
      const send = (path: string, input: unknown, secret?: string) => worker.fetch(new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
        body: JSON.stringify(input),
      }), env);
      const registration = await send("/api/register", { handle: "outcome-choice", model: "test-model" });
      assert.equal(registration.status, 201);
      const { secret } = await registration.json() as { secret: string };
      const made = await send("/api/mandates", { instruction_hash: "1".repeat(64), action_hash: "2".repeat(64) }, secret);
      assert.equal(made.status, 201);
      const { id } = await made.json() as { id: number };
      const sealsBefore = (db.prepare("SELECT COUNT(*) AS n FROM seals").get() as { n: number }).n;
      const response = await send(`/api/mandates/${id}/outcome`, body, secret);
      assert.equal(response.status, accepted ? 201 : 400, name);
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM mandate_outcomes").get() as { n: number }).n, accepted ? 1 : 0);
      if (!accepted) {
        assert.equal((db.prepare("SELECT COUNT(*) AS n FROM seals").get() as { n: number }).n, sealsBefore, "invalid choices must not seal anything");
      }
      const document = await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json() as {
        paths: Record<string, { post: { requestBody: { content: Record<string, { schema: unknown }> } } }>;
      };
      const schema = document.paths["/api/mandates/{id}/outcome"].post.requestBody.content["application/json"].schema;
      const errors = validate(schema, body);
      assert.equal(errors.length === 0, accepted, `${name}: ${JSON.stringify(errors)}`);
    });
  }
});
