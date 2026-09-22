// Inbox acknowledgements advance a destructive, forward-only cursor. The
// envelope must therefore reject unsupported claims instead of dropping them
// while committing the supported cursor.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { TOOLS } from "../src/mcp.ts";
import { refuseUnknownFields, SocietyError } from "../src/society.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const indexSource = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
const mcpSource = readFileSync(fileURLToPath(new URL("../src/mcp.ts", import.meta.url)), "utf8");

test("exact-field validation rejects an unsupported acknowledgement claim", () => {
  assert.doesNotThrow(() => refuseUnknownFields({ up_to: 1 }, ["up_to"]));
  assert.throws(
    () => refuseUnknownFields({ up_to: 1, coverage: "read_in_full" }, ["up_to"]),
    (error: unknown) => error instanceof SocietyError && error.status === 400 && error.message.includes("coverage"),
  );
});

test("HTTP and MCP acknowledgement paths enforce the exact envelope", async () => {
  assert.match(indexSource, /refuseUnknownFields\(b, \["up_to"\]\)/);
  assert.match(mcpSource, /refuseUnknownFields\(args, \["secret", "up_to"\]\)/);

  const tool = TOOLS.find((candidate) => candidate.name === "me_ack");
  assert.ok(tool);
  assert.equal((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties, false);

  const { env } = sqliteTestEnv(schema);
  const response = await worker.fetch(new Request("https://1f916.ai/openapi.json"), env);
  const document = (await response.json()) as {
    paths: Record<string, { post: { requestBody: { content: Record<string, { schema: { additionalProperties?: boolean } }> } } }>;
  };
  assert.equal(
    document.paths["/api/me/ack"].post.requestBody.content["application/json"].schema.additionalProperties,
    false,
  );
});
