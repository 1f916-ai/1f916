// Issue #263 (jaxernst): the GET /treasury asset reader used its own public-only
// Base-RPC list and so was the one money-path read that never reached the keyed
// BASE_RPC_PRIVATE_URL / _2 endpoints the observer and payout verifier use. When
// the public providers rate-limited an unauthenticated batch, the treasury page
// degraded to blank portfolios while the rest of the money path kept reading
// through the authenticated endpoint. The divergent copy in society.ts is gone;
// both treasury readers now source the single pool from payouts.ts baseRpcUrls,
// which puts the keyed endpoints first.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { baseRpcUrls } from "../src/payouts.ts";
import type { Env } from "../src/society.ts";

const societySrc = readFileSync(fileURLToPath(new URL("../src/society.ts", import.meta.url)), "utf8");

test("the treasury asset reader shares the money path's one RPC pool, keyed endpoint first (issue #263)", () => {
  // 1. The divergent public-only copy must not come back. payouts.ts owns the
  //    pool with `export function baseRpcUrls`; society.ts must not define its
  //    own `function baseRpcUrls`.
  assert.ok(
    !/\bfunction baseRpcUrls\s*\(/.test(societySrc),
    "society.ts must not define its own baseRpcUrls — it drifted from the money path's pool",
  );
  // 2. It imports the canonical pool from payouts.ts.
  assert.match(
    societySrc,
    /import \{[^}]*\bbaseRpcUrls\b[^}]*\} from "\.\/payouts\.ts"/s,
    "society.ts must import baseRpcUrls from payouts.ts",
  );
  // 3. Both treasury readers build their pool from it.
  for (const fn of ["fetchOnchainUsdcCents", "readTreasuryAssetsCached"]) {
    const body = societySrc.slice(societySrc.indexOf(`async function ${fn}`));
    const next = body.slice(0, body.indexOf("\n}\n") + 3);
    assert.match(next, /baseRpcUrls\(env\)/, `${fn} must build its RPC pool from baseRpcUrls(env)`);
  }
  // 4. Behavior of that shared pool: the keyed private endpoints come first, so
  //    the treasury reader now reaches them before any public provider.
  const priv = "https://keyed.example/base";
  const priv2 = "https://keyed2.example/base";
  const pool = baseRpcUrls({ BASE_RPC_PRIVATE_URL: priv, BASE_RPC_PRIVATE_URL_2: priv2 } as unknown as Env);
  assert.deepEqual(pool.slice(0, 2), [priv, priv2], "the keyed endpoints are tried first");
  assert.ok(pool.length > 2, "public providers remain as fallbacks");
});
