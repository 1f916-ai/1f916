// Tests for the pool-depth simulation.
//
// Run: npm test
//
// The pool state below was read from Base on 2026-08-09 and is pinned as fixed
// numbers, so this is a test rather than a network call. Provenance for every
// figure, because a simulation nobody can re-derive is worth as much as the
// notional mark it exists to qualify:
//
//   StateView 0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71 on Base
//   poolId    0x24ecedb296899f0110dce5cfdd9c9dd74b2b11a21dee752e085f93c700c7fccb
//   getSlot0      -> sqrtPriceX96 1804272708671651059909321593348381, tick 200676, lpFee 7000
//   getLiquidity  -> 881791379942174244472863
//   the ladder    -> five initialized ticks, via getTickBitmap + getTickLiquidity

import test from "node:test";
import assert from "node:assert/strict";
import {
  getSqrtRatioAtTick,
  simulateSellToken1,
  activeLiquidityAt,
  ticksFromBitmapWord,
  bitmapWordRange,
  MIN_TICK,
  MAX_TICK,
  type TickDelta,
} from "../src/pooldepth.ts";

const SQRT_P = 1804272708671651059909321593348381n;
const TICK = 200676;
const LIQUIDITY = 881791379942174244472863n;
const FEE_PIPS = 7000; // 0.70%
const SPACING = 200;

// The whole ladder, both signs, exactly as the chain reports it.
const LADDER: TickDelta[] = [
  { tick: -887200, liquidityNet: 4352021229706149271173869n },
  { tick: 119600, liquidityNet: -3470229849763975026701006n },
  { tick: 229800, liquidityNet: -765588100457420015136330n },
  { tick: 236600, liquidityNet: -64472255446804397621005n },
  { tick: 887200, liquidityNet: -51731024037949831715528n },
];

// ---------- TickMath ----------

test("getSqrtRatioAtTick(0) is exactly Q96", () => {
  assert.equal(getSqrtRatioAtTick(0), 79228162514264337593543950336n);
});

test("TickMath brackets the live price, which is how we know it is the chain's", () => {
  // The pool reports tick 200676 alongside sqrtPriceX96. By definition the
  // price must sit in [ratio(tick), ratio(tick+1)). If our TickMath drifted,
  // this is where it shows — and a drifting TickMath silently misprices every
  // tick crossing in the simulation.
  const lo = getSqrtRatioAtTick(TICK);
  const hi = getSqrtRatioAtTick(TICK + 1);
  assert.ok(lo <= SQRT_P, `ratio(${TICK}) = ${lo} must be <= live ${SQRT_P}`);
  assert.ok(SQRT_P < hi, `live ${SQRT_P} must be < ratio(${TICK + 1}) = ${hi}`);
});

test("TickMath is monotonic and survives the extremes", () => {
  assert.ok(getSqrtRatioAtTick(MIN_TICK) < getSqrtRatioAtTick(0));
  assert.ok(getSqrtRatioAtTick(0) < getSqrtRatioAtTick(MAX_TICK));
  assert.ok(getSqrtRatioAtTick(-5000) < getSqrtRatioAtTick(-4999));
  assert.ok(getSqrtRatioAtTick(60000) < getSqrtRatioAtTick(60001));
  assert.throws(() => getSqrtRatioAtTick(MAX_TICK + 1), RangeError);
  assert.throws(() => getSqrtRatioAtTick(1.5), RangeError);
});

// ---------- the spacing guard ----------

test("the ladder reproduces the liquidity the pool reports", () => {
  // This is the invariant that PROVES tickSpacing is 200 rather than assuming
  // it. A wrong spacing decodes the bitmap into ticks that do not exist, and
  // the running sum stops matching getLiquidity.
  assert.equal(activeLiquidityAt(TICK, LADDER), LIQUIDITY);
});

test("liquidity returns to zero above the top of the ladder", () => {
  assert.equal(activeLiquidityAt(MAX_TICK, LADDER), 0n);
});

test("bitmap words decode to ticks at the given spacing", () => {
  // Bit 0 of word 0 is tick 0; bit 3 of word 1 is compressed 259.
  assert.deepEqual(ticksFromBitmapWord(0, 1n, SPACING), [0]);
  assert.deepEqual(ticksFromBitmapWord(1, 1n << 3n, SPACING), [259 * SPACING]);
  assert.deepEqual(ticksFromBitmapWord(0, 0n, SPACING), []);
  // -887200 is the lowest usable tick at spacing 200: compressed -4436.
  const { from, to } = bitmapWordRange(SPACING);
  assert.equal(from, -4436 >> 8);
  assert.equal(to, 4436 >> 8);
  assert.ok(to - from < 40, "spacing 200 covers the whole range in a few dozen words");
});

// ---------- the simulation ----------

test("selling the whole claimable position returns less than its mark", () => {
  // 2,651,057,093.4039 1F916 — the claimable tier-3 quantity on 2026-08-09,
  // which is 2.651% of the 100,000,000,000 total supply.
  const position = 2651057093403900521113739485n;
  const above = LADDER.filter((t) => t.tick > TICK);
  const r = simulateSellToken1(SQRT_P, LIQUIDITY, position, FEE_PIPS, above);

  // 4.4877 WETH. Everything fills inside the current range, so this figure
  // depends only on the live price, the live liquidity and the amount — no
  // tick crossing, hence no dependence on TickMath at all.
  assert.equal(r.ticksCrossed, 0);
  assert.equal(r.amountUnfilled, 0n);
  assert.equal(r.amountOut, 4487709929077892558n);

  // The no-slippage value at the marginal price, for comparison. Selling the
  // position realises about 88% of it.
  const marginalOut = (position * Q96 * Q96) / (SQRT_P * SQRT_P);
  assert.ok(r.amountOut < marginalOut, "a real sale never beats the marginal price");
  const pct = Number((r.amountOut * 10000n) / marginalOut) / 100;
  assert.ok(pct > 87 && pct < 89, `expected ~88% of the marginal value, got ${pct}%`);
});

const Q96 = 1n << 96n;

test("price impact grows with size — the property the notional mark hides", () => {
  const above = LADDER.filter((t) => t.tick > TICK);
  const full = 2651057093403900521113739485n;
  const rate = (amount: bigint) => {
    const r = simulateSellToken1(SQRT_P, LIQUIDITY, amount, FEE_PIPS, above);
    // token0 out per 1e18 token1 in
    return (r.amountOut * 10n ** 18n) / amount;
  };
  const small = rate(full / 100n);
  const half = rate(full / 2n);
  const whole = rate(full);
  assert.ok(small > half, "a 1% sale must get a better rate than a 50% sale");
  assert.ok(half > whole, "a 50% sale must get a better rate than the whole position");
});

test("the token0 in the pool is finite, and that ceiling is the real fact", () => {
  // The most surprising number here, and the one worth publishing beside any
  // mark: no sale of this token into this pool can ever produce more than
  // about 30.41 WETH, because that is all the WETH the pool's ranges hold.
  // Selling ten times the entire supply and selling a MILLION times the entire
  // supply differ by three thousandths of a WETH.
  const above = LADDER.filter((t) => t.tick > TICK);
  const supply = 100_000_000_000n * 10n ** 18n;
  const tenX = simulateSellToken1(SQRT_P, LIQUIDITY, 10n * supply, FEE_PIPS, above);
  const millionX = simulateSellToken1(SQRT_P, LIQUIDITY, 1_000_000n * supply, FEE_PIPS, above);

  const ceiling = 30_413_000_000_000_000_000n; // ~30.413 WETH
  assert.ok(tenX.amountOut < ceiling, "ten times the supply cannot exceed the pool's WETH");
  assert.ok(millionX.amountOut < ceiling, "nor can a million times it");
  // A 100,000x larger sale buys less than one part in ten thousand more.
  const extra = millionX.amountOut - tenX.amountOut;
  assert.ok(extra > 0n, "monotonic: more in never means less out");
  assert.ok((extra * 10_000n) / tenX.amountOut < 10n, `asymptote broken: ${extra} extra`);
});

test("an amount beyond the whole ladder reports what it could not fill", () => {
  // Above the top initialized tick there is no liquidity at any price, so the
  // simulation must return the unfillable remainder rather than a number.
  const r = simulateSellToken1(SQRT_P, LIQUIDITY, 10n ** 60n, FEE_PIPS, LADDER.filter((t) => t.tick > TICK));
  assert.ok(r.amountUnfilled > 0n, "the pool cannot absorb this and must say so");
  assert.equal(r.ticksCrossed, 3);
});

test("the fee reduces the output, and zero fee is the ceiling", () => {
  const above = LADDER.filter((t) => t.tick > TICK);
  const position = 2651057093403900521113739485n;
  const withFee = simulateSellToken1(SQRT_P, LIQUIDITY, position, FEE_PIPS, above).amountOut;
  const noFee = simulateSellToken1(SQRT_P, LIQUIDITY, position, 0, above).amountOut;
  assert.ok(noFee > withFee);
  // 0.70% off the input, so the outputs differ by roughly that.
  const diffPct = Number(((noFee - withFee) * 10000n) / noFee) / 100;
  assert.ok(diffPct > 0.6 && diffPct < 0.9, `expected ~0.7%, got ${diffPct}%`);
});

test("degenerate inputs return nothing rather than inventing a number", () => {
  const above = LADDER.filter((t) => t.tick > TICK);
  for (const [p, l, a] of [
    [0n, LIQUIDITY, 1n],
    [SQRT_P, 0n, 1n],
    [SQRT_P, LIQUIDITY, 0n],
  ] as const) {
    const r = simulateSellToken1(p, l, a, FEE_PIPS, above);
    assert.equal(r.amountOut, 0n);
  }
});
