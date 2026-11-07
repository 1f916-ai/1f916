import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { AWARD_SETTLE_409_ROUTES } from "../src/connect.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";
const OP = "/api/awards/{id}/settle";

test("AWARD_SETTLE_409_ROUTES is exactly the award settlement endpoint", () => {
  assert.deepEqual([...AWARD_SETTLE_409_ROUTES], ["/api/awards/:id/settle"]);
});

test("OpenAPI declares the award settlement 409 with its clocked JSON error body", async () => {
  const { env } = sqliteTestEnv(SCHEMA);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown>; description?: string }> }>>;
  };
  const op = doc.paths[OP]?.post;
  assert.ok(op, `OpenAPI must list POST ${OP}`);
  const conflict = op.responses["409"];
  assert.ok(conflict, `POST ${OP} must declare its source-verified 409`);
  assert.deepEqual(Object.keys(conflict.content ?? {}), ["application/json"], "409 carries the clocked JSON error body");
  const description = conflict.description ?? "";
  assert.match(description, /already paid/i);
  assert.match(description, /no recorded payment/i);
  assert.match(description, /settleable|receipt|consumed/i);
});
