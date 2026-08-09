// What a position would actually fetch, as opposed to what it is marked at.
//
// GET /treasury publishes a tier-3 holding and calls it NOTIONAL: "a price, not
// an offer. A position this size cannot be sold at the quoted price, because
// selling it is what moves the price." That sentence was true and unquantified.
// It told a reader the number was wrong without telling them by how much, which
// is a warning label, not a measurement — and it is the same defect class as the
// verify recipe that named four calls without saying how they combine.
//
// This file answers the question. It walks the pool's own tick ladder and
// simulates selling the position into it, so the mark can be published beside a
// figure derived from the liquidity that would actually have to absorb the sale.
//
// WHAT THIS IS NOT. It is a single-pool, single-transaction, no-adversary
// simulation: one seller, no other trades in the block, no route through any
// other venue, no sandwich. Real execution is not better than this; it can be
// worse. Read the output as an upper bound on a bad outcome, not as a quote.

/** Uniswap's Q96 fixed point. */
const Q96 = 1n << 96n;

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/**
 * sqrtPriceX96 at a tick, by Uniswap's TickMath.
 *
 * The magic constants are the binary expansion of sqrt(1.0001) — each bit of
 * |tick| multiplies in one precomputed factor. Reproduced rather than
 * approximated with Math.pow because the whole point of this file is to be
 * checkable against the chain, and the chain uses exactly these.
 */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new RangeError(`tick ${tick} out of range`);
  }
  const abs = BigInt(Math.abs(tick));
  let ratio = (abs & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const mul = (hex: bigint, bit: bigint) => {
    if ((abs & bit) !== 0n) ratio = (ratio * hex) >> 128n;
  };
  mul(0xfff97272373d413259a46990580e213an, 0x2n);
  mul(0xfff2e50f5f656932ef12357cf3c7fdccn, 0x4n);
  mul(0xffe5caca7e10e4e61c3624eaa0941cd0n, 0x8n);
  mul(0xffcb9843d60f6159c9db58835c926644n, 0x10n);
  mul(0xff973b41fa98c081472e6896dfb254c0n, 0x20n);
  mul(0xff2ea16466c96a3843ec78b326b52861n, 0x40n);
  mul(0xfe5dee046a99a2a811c461f1969c3053n, 0x80n);
  mul(0xfcbe86c7900a88aedcffc83b479aa3a4n, 0x100n);
  mul(0xf987a7253ac413176f2b074cf7815e54n, 0x200n);
  mul(0xf3392b0822b70005940c7a398e4b70f3n, 0x400n);
  mul(0xe7159475a2c29b7443b29c7fa6e889d9n, 0x800n);
  mul(0xd097f3bdfd2022b8845ad8f792aa5825n, 0x1000n);
  mul(0xa9f746462d870fdf8a65dc1f90e061e5n, 0x2000n);
  mul(0x70d869a156d2a1b890bb3df62baf32f7n, 0x4000n);
  mul(0x31be135f97d08fd981231505542fcfa6n, 0x8000n);
  mul(0x9aa508b5b7a84e1c677de54f3e99bc9n, 0x10000n);
  mul(0x5d6af8dedb81196699c329225ee604n, 0x20000n);
  mul(0x2216e584f5fa1ea926041bedfe98n, 0x40000n);
  mul(0x48a170391f7dc42444e8fa2n, 0x80000n);
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  // Q128.128 -> Q96, rounding up so the result is never below the true ratio.
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** One initialized tick and the liquidity delta crossing it upward applies. */
export interface TickDelta {
  tick: number;
  liquidityNet: bigint;
}

export interface SwapResult {
  /** Token0 received, raw units. */
  amountOut: bigint;
  /** Input that could not be filled because the ladder ran out of liquidity. */
  amountUnfilled: bigint;
  /** How many initialized ticks the sale crossed. 0 means it stayed in range. */
  ticksCrossed: number;
  /** Price after the sale, for callers that want to report the impact. */
  sqrtPriceX96After: bigint;
}

/**
 * Sell `amountIn` of token1 into the pool for token0, walking the tick ladder.
 *
 * Selling token1 raises token1/token0, so the price walks UP and the relevant
 * ticks are the initialized ones above the current price. Within a range the
 * pool is a constant-liquidity curve:
 *
 *   amount1 in  = L * (sqrtP_next - sqrtP)  / Q96
 *   amount0 out = L * (sqrtP_next - sqrtP) * Q96 / (sqrtP * sqrtP_next)
 *
 * Every division truncates, which biases the answer DOWN. For a figure whose
 * purpose is to stop a treasury overstating itself, rounding against ourselves
 * is the only defensible direction.
 *
 * `feePips` is the LP fee in hundredths of a basis point, as the pool reports
 * it — 7000 is 0.70%. It is taken off the input before any of it reaches the
 * curve, which is why a fee makes the output smaller rather than the price
 * worse.
 */
export function simulateSellToken1(
  sqrtPriceX96: bigint,
  liquidity: bigint,
  amountIn: bigint,
  feePips: number,
  ticksAbove: TickDelta[],
): SwapResult {
  if (amountIn <= 0n || liquidity <= 0n || sqrtPriceX96 <= 0n) {
    return { amountOut: 0n, amountUnfilled: amountIn > 0n ? amountIn : 0n, ticksCrossed: 0, sqrtPriceX96After: sqrtPriceX96 };
  }
  let remaining = (amountIn * BigInt(1_000_000 - feePips)) / 1_000_000n;
  let sqrtP = sqrtPriceX96;
  let L = liquidity;
  let out = 0n;
  let crossed = 0;

  const ladder = [...ticksAbove].sort((a, b) => a.tick - b.tick);
  for (const step of ladder) {
    if (remaining <= 0n || L <= 0n) break;
    const sqrtNext = getSqrtRatioAtTick(step.tick);
    if (sqrtNext <= sqrtP) continue;
    // Most token1 this range can absorb before the price reaches the next tick.
    const capacity = (L * (sqrtNext - sqrtP)) / Q96;
    if (remaining < capacity) {
      const sqrtNew = sqrtP + (remaining * Q96) / L;
      out += (L * (sqrtNew - sqrtP) * Q96) / (sqrtP * sqrtNew);
      return { amountOut: out, amountUnfilled: 0n, ticksCrossed: crossed, sqrtPriceX96After: sqrtNew };
    }
    out += (L * (sqrtNext - sqrtP) * Q96) / (sqrtP * sqrtNext);
    remaining -= capacity;
    sqrtP = sqrtNext;
    // Crossing upward applies liquidityNet as written; it goes negative when
    // the range above is thinner, which is exactly the case that makes a large
    // sale worse than a small one.
    L += step.liquidityNet;
    crossed++;
  }
  // The ladder ran out: there is no more liquidity to sell into at any price.
  return { amountOut: out, amountUnfilled: remaining, ticksCrossed: crossed, sqrtPriceX96After: sqrtP };
}

/**
 * Rebuild the active liquidity at `tick` from the full ladder, so it can be
 * checked against what the pool reports.
 *
 * This is the guard that lets tickSpacing be a hardcoded constant. A wrong
 * spacing decodes the tick bitmap into ticks that are not real, and the running
 * sum then disagrees with getLiquidity — loudly, not subtly. Callers must treat
 * a mismatch as "unknown" and publish nothing, never as a reason to guess.
 */
export function activeLiquidityAt(tick: number, ladder: TickDelta[]): bigint {
  let sum = 0n;
  for (const t of ladder) if (t.tick <= tick) sum += t.liquidityNet;
  return sum;
}

/** Decode one 256-bit tick-bitmap word into the ticks it marks initialized. */
export function ticksFromBitmapWord(wordPos: number, word: bigint, tickSpacing: number): number[] {
  const ticks: number[] = [];
  for (let bit = 0; bit < 256; bit++) {
    if ((word >> BigInt(bit)) & 1n) ticks.push(((wordPos << 8) + bit) * tickSpacing);
  }
  return ticks;
}

/** The bitmap word positions covering the whole legal tick range at a spacing. */
export function bitmapWordRange(tickSpacing: number): { from: number; to: number } {
  return { from: Math.floor(MIN_TICK / tickSpacing) >> 8, to: Math.floor(MAX_TICK / tickSpacing) >> 8 };
}
