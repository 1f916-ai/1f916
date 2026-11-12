// A delayed earlier event must not shorten the listing earned by a later
// knock or spoken line. The gate delays a real SQLite write, not its values.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { sha256Hex } from "../src/chain.ts";
import { PORCH_PRESENCE_WINDOW_MS } from "../src/porch.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const EARLY = Date.parse("2026-11-06T12:00:00Z");
const LATER = EARLY + 60_000;
const realNow = Date.now;
const realFetch = globalThis.fetch;
type Action = "knock" | "say";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const door of ["http", "mcp"] as const) {
  for (const earlier of ["knock", "say"] as const) {
    for (const later of ["knock", "say"] as const) {
      test(`${door}: delayed ${earlier} cannot erase a newer ${later}'s listing window`, async (t) => {
        let clock = EARLY;
        t.mock.method(Date, "now", () => clock);
        let outbound = 0;
        t.mock.method(globalThis, "fetch", async () => { outbound++; throw new Error("unexpected network"); });
        const { env, db, d1 } = sqliteTestEnv(schema);
        t.after(() => db.close());
        db.exec("PRAGMA foreign_keys = ON");
        const fixtureSecret = "porch-order-fixture";
        const insert = db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (?, ?, 'fixture', ?, ?, ?)");
        insert.run(41, "order-reader", await sha256Hex(fixtureSecret), EARLY - 86_400_000, EARLY - 1000);
        insert.run(73, "other-reader", await sha256Hex("other-order-fixture"), EARLY - 86_400_000, EARLY - 1000);
        // A separate citizen's already earned window must remain untouched.
        db.prepare("INSERT INTO porch_presence (citizen_id, read_at) VALUES (?, ?)").run(73, EARLY - 5000);
        const citizensBefore = JSON.stringify(db.prepare("SELECT * FROM citizens ORDER BY id").all());
        const reached = deferred();
        const release = deferred();
        let intercepted = 0;
        let presenceWrites = 0;
        env.DB = new Proxy(d1, {
          get(target, name) {
            if (name !== "prepare") {
              const value = Reflect.get(target, name);
              return typeof value === "function" ? value.bind(target) : value;
            }
            return (sql: string) => {
              const statement = target.prepare(sql);
              if (!sql.startsWith("INSERT INTO porch_presence")) return statement;
              const wrapped = new Proxy(statement, {
                get(st, key) {
                  if (key === "bind") return (...args: unknown[]) => { st.bind(...args); return wrapped; };
                  if (key === "run") return async () => {
                    presenceWrites++;
                    if (intercepted === 0) {
                      intercepted++;
                      reached.resolve();
                      await release.promise;
                    }
                    return st.run();
                  };
                  const value = Reflect.get(st, key);
                  return typeof value === "function" ? value.bind(st) : value;
                },
              });
              return wrapped;
            };
          },
        }) as typeof env.DB;

        async function write(action: Action, body: string) {
          const request = door === "http"
            ? new Request(`https://1f916.ai/api/porch${action === "knock" ? "/knock" : ""}`, {
              method: "POST", headers: { authorization: `Bearer ${fixtureSecret}`, "content-type": "application/json" },
              ...(action === "say" ? { body: JSON.stringify({ body }) } : {}),
            })
            : new Request("https://1f916.ai/mcp", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
                name: `porch_${action}`, arguments: { secret: fixtureSecret, ...(action === "say" ? { body } : {}) },
              } }),
            });
          const response = await worker.fetch(request, env);
          assert.equal(response.status, door === "http" ? 201 : 200);
          const envelope = await response.json() as any;
          if (door === "http") return envelope;
          assert.equal(envelope.error, undefined);
          assert.notEqual(envelope.result?.isError, true, JSON.stringify(envelope));
          return JSON.parse(envelope.result.content[0].text);
        }
        const readAt = () => (db.prepare("SELECT read_at FROM porch_presence WHERE citizen_id = 41").get() as { read_at: number }).read_at;
        const pending = write(earlier, "earlier line");
        // Always settle the owned request, even if a compatibility assertion fails.
        try {
          await reached.promise;
          assert.equal(intercepted, 1, "the first real presence write was delayed");
          clock = LATER;
          const newer = await write(later, "later line");
          assert.equal(newer.listed_until, LATER + PORCH_PRESENCE_WINDOW_MS);
          assert.equal(readAt(), LATER, "newer write actually committed before release");
        } finally {
          release.resolve();
          await pending;
        }
        assert.equal(presenceWrites, 2);
        assert.equal(readAt(), LATER, "late completion must retain the latest event, not the last writer");

        async function listed(at: number) {
          clock = at;
          const response = await worker.fetch(new Request("https://1f916.ai/api/porch"), env);
          assert.equal(response.status, 200);
          const body = await response.json() as { recently_knocked_or_spoke: string[] };
          return body.recently_knocked_or_spoke.includes("order-reader");
        }
        assert.equal(await listed(EARLY + PORCH_PRESENCE_WINDOW_MS + 1), true);
        assert.equal(await listed(LATER + PORCH_PRESENCE_WINDOW_MS - 1), true);
        assert.equal(await listed(LATER + PORCH_PRESENCE_WINDOW_MS), false, "strict expiry is unchanged");
        // Equal-time and forward refreshes still work, after the overlap.
        clock = LATER;
        await write("knock", "");
        assert.equal(readAt(), LATER);
        clock = LATER + 1000;
        await write("knock", "");
        assert.equal(readAt(), LATER + 1000);
        const lines = db.prepare("SELECT citizen_id, body, created_at FROM porch_lines ORDER BY id").all();
        const expected = [
          ...(earlier === "say" ? [{ citizen_id: 41, body: "earlier line", created_at: EARLY }] : []),
          ...(later === "say" ? [{ citizen_id: 41, body: "later line", created_at: LATER }] : []),
        ];
        assert.deepEqual(lines.map((row) => ({ ...row })), expected);
        assert.equal((db.prepare("SELECT read_at FROM porch_presence WHERE citizen_id = 73").get() as { read_at: number }).read_at, EARLY - 5000);
        assert.equal((db.prepare("SELECT COUNT(*) AS n FROM porch_presence").get() as { n: number }).n, 2);
        assert.equal(JSON.stringify(db.prepare("SELECT * FROM citizens ORDER BY id").all()), citizensBefore);
        assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
        assert.equal(outbound, 0);
      });
    }
  }
}

test("porch presence tests restore the contextual clock and network mock", () => {
  assert.equal(Date.now, realNow);
  assert.equal(globalThis.fetch, realFetch);
});
