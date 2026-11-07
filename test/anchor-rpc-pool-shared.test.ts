// WQ-730: the Base anchoring leg (submitBase/confirmBase in anchors.ts) built
// its viem client from a SINGLE RPC URL (env.BASE_RPC_PRIVATE_URL ||
// env.BASE_RPC_URL || the public node). When the keyed endpoint answered 402
// (provider quota/billing lapse) every Base anchor failed at
// eth_getTransactionCount even though healthy public providers were already in
// the money path's pool. The anchoring transport now shares that one pool
// (payouts.ts baseRpcUrls) through viem's fallback transport, keyed first, so
// one provider's outage falls through to the next instead of stopping the leg.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fallback, http } from "viem";
import { baseAnchorTransport } from "../src/anchors.ts";
import { baseRpcUrls } from "../src/payouts.ts";
import type { Env } from "../src/society.ts";

const anchorsSrc = readFileSync(fileURLToPath(new URL("../src/anchors.ts", import.meta.url)), "utf8");

test("the Base anchoring leg shares the money path's one RPC pool through a fallback transport, keyed first (WQ-730)", () => {
  // 1. anchors.ts imports the canonical pool from payouts.ts.
  assert.match(
    anchorsSrc,
    /import \{[^}]*\bbaseRpcUrls\b[^}]*\} from "\.\/payouts\.ts"/s,
    "anchors.ts must import baseRpcUrls from payouts.ts",
  );
  // 2. The old single-URL transport must not come back. No anchoring path may
  //    build an http() transport straight from one env URL — that was the
  //    whole bug: a 402 on that one endpoint stopped the leg.
  assert.ok(
    !/http\(\s*env\.BASE_RPC_PRIVATE_URL/.test(anchorsSrc),
    "anchors.ts must not build a single-URL http() transport from env.BASE_RPC_PRIVATE_URL",
  );
  // 3. Both anchoring clients build their transport from the shared helper.
  for (const fn of ["submitBase", "confirmBase"]) {
    const body = anchorsSrc.slice(anchorsSrc.indexOf(`async function ${fn}`));
    const next = body.slice(0, body.indexOf("\n}\n") + 3);
    assert.match(next, /baseAnchorTransport\(env, viem\)/, `${fn} must build its transport from baseAnchorTransport`);
  }
  // 4. Behavior: baseAnchorTransport wraps the WHOLE shared pool in a fallback
  //    transport, keyed endpoints first and public providers as fallbacks, so
  //    a dead or billing-lapsed first provider is not the only voice.
  const priv = "https://keyed.example/base";
  const priv2 = "https://keyed2.example/base";
  const env = { BASE_RPC_PRIVATE_URL: priv, BASE_RPC_PRIVATE_URL_2: priv2 } as unknown as Env;
  const transport = baseAnchorTransport(env, { fallback, http })({} as never) as {
    value: { transports: { value: { url: string } }[] };
  };
  const urls = transport.value.transports.map((t) => t.value.url);
  assert.deepEqual(urls, baseRpcUrls(env), "the fallback transport carries the whole shared pool, in pool order");
  assert.deepEqual(urls.slice(0, 2), [priv, priv2], "the keyed endpoints are tried first");
  assert.ok(urls.length > 2, "public providers remain as fallbacks");
});
