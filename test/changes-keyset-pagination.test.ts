import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseChangesCursor, SocietyError } from "../src/society.ts";

describe("changes cursor parsing", () => {
  test("absent cursor keeps legacy mode", () => {
    assert.equal(parseChangesCursor(null), null);
    assert.equal(parseChangesCursor(undefined), null);
  });

  test("init and done sentinels are explicit", () => {
    assert.equal(parseChangesCursor("init"), "init");
    assert.equal(parseChangesCursor("done"), "done");
  });

  test("live ID tokens include the empty-table zero baseline", () => {
    assert.deepEqual(parseChangesCursor("id:0"), { kind: "live", id: 0 });
    assert.deepEqual(parseChangesCursor("id:42"), { kind: "live", id: 42 });
  });

  test("numeric tokens from earlier PR revisions remain readable as live IDs", () => {
    assert.deepEqual(parseChangesCursor("1691683200000:42"), { kind: "live", id: 42 });
    assert.deepEqual(parseChangesCursor("0:0"), { kind: "live", id: 0 });
  });

  test("snapshot tokens carry the initial timestamp filter and bounded ID walk", () => {
    assert.deepEqual(parseChangesCursor("snap:200:1000:500"), {
      kind: "snapshot",
      since: 200,
      maxId: 1000,
      afterId: 500,
    });
  });

  test("capped init walks carry a snapi token that needs no timestamp filter", () => {
    assert.deepEqual(parseChangesCursor("snapi:1000:500"), {
      kind: "snapshot_id",
      maxId: 1000,
      afterId: 500,
    });
    assert.deepEqual(parseChangesCursor("snapi:0:0"), {
      kind: "snapshot_id",
      maxId: 0,
      afterId: 0,
    });
  });

  for (const malformed of [
    "",
    ":",
    "id:",
    "id:-1",
    "id:1.5",
    "id:01",
    "id: 1",
    "id:9007199254740992",
    "snap:1:2:3",
    "snap:1:2",
    "snap:1:2:1:0",
    "snap:1.5:2:1",
    "snapi:2:3",
    "snapi:1",
    "snapi:1:2:3",
    "snapi:3:2:9",
    "snapi:3:2:",
    "snapi:1.5:2",
    "snapi:",
    "DONE",
    "done:extra",
  ]) {
    test(`malformed supplied cursor is 400: ${JSON.stringify(malformed)}`, () => {
      assert.throws(
        () => parseChangesCursor(malformed),
        (error: unknown) => error instanceof SocietyError && error.status === 400,
      );
    });
  }
});
