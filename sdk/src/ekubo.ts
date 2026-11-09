// A graduated Hokori coin's Ekubo pool (contract v2): a single-step quote for its full-range position, rounded as
// the deployed Ekubo Core rounds that step. Per step:
//   - the fee is taken from the input first, rounded up: ceil(amount * fee / 2^128);
//   - token1 in:  next = sqrt + floor(in * 2^128 / L),  token0 out = floor(floor(L*2^128 * (next - sqrt) / next) / sqrt);
//   - token0 in:  token1 out = floor(L * (sqrt - next) / 2^128), with `next` depending on the Core version (17f1a14 V5):
//       Core v5 (mainnet, v5.0.2):  next = ceil(L*2^128 * sqrt / (L*2^128 + in * sqrt)), exactly;
//       Core v4 (Sepolia, v4.0.1):  next = ceil(L*2^128 / (floor(L*2^128 / sqrt) + in)), dropping the inner remainder
//                                   (Ekubo's own source calls it "the previous implementation").
// Core can also split a swap into several steps where tick-bitmap words end, even without another initialized tick; a
// trade crossing such a boundary can then differ from this single-step quote by a few base units (the order's
// slippage minimum covers it). Prices are 128.128 square roots of token1 per token0. Pure functions over BigInt.
import { QuoteError } from "./curve.ts";
import { uint, type IntLike } from "./math.ts";

export const TWO_128 = 1n << 128n;
/** Hokori pools: tick spacing 20000, and the factory's trading fee (ekuboFeeFor). */
export const EKUBO_TICK_SPACING = 20000n;
/** A pool fee equal to a curve fee in basis points, as Ekubo encodes it: floor(fee_bps * 2^128 / 10000). 1% gives
 *  floor(2^128 / 100); 0.7% gives 2381976568446569244243622252022377480. */
export const ekuboFeeFor = (feeBps: IntLike): bigint => (uint(feeBps, "feeBps") << 128n) / 10_000n;
export const MIN_SQRT_RATIO = 18446748437148339061n;
export const MAX_SQRT_RATIO = 6277100250585753475930931601400621808602321654880405518632n;
const U128_MAX = TWO_128 - 1n;
const TWO_320 = 1n << 320n;
/** The Ekubo Core version a pool runs on: "v5" (mainnet, v5.0.2) or "v4" (Sepolia, v4.0.1). It decides rounding. */
export type EkuboCore = "v4" | "v5";
/** A pool as read from Ekubo Core. */
export type EkuboPool = { sqrtRatio: bigint; liquidity: bigint; coinIsToken0: boolean; fee: bigint; core: EkuboCore };

/**
 * A pool as read from Ekubo Core: sqrtRatio (get_pool_price), liquidity (get_pool_liquidity), which side the coin is on
 * (token0 is the lower address), its fee (the pool key's: ekuboFeeFor(the curve's fee_bps)), and which Core version
 * runs it ("v5" mainnet, "v4" Sepolia), which decides rounding.
 */
export function ekuboPool({ sqrtRatio, liquidity, coinIsToken0, fee, core }: { sqrtRatio: IntLike; liquidity: IntLike; coinIsToken0: boolean; fee: IntLike; core: EkuboCore }): EkuboPool {
  if (core !== "v4" && core !== "v5") throw new QuoteError("pool: the Ekubo Core version (v4 or v5) is required");
  if (fee === undefined) throw new QuoteError("pool: the pool's fee is required (it is the factory's trading fee)");
  return { sqrtRatio: uint(sqrtRatio, "sqrtRatio"), liquidity: uint(liquidity, "liquidity"), coinIsToken0: !!coinIsToken0, fee: uint(fee, "fee"), core };
}

/** Whether `a` is the pool key's token0 (the lower address). */
export const isToken0 = (a: IntLike, b: IntLike): boolean => BigInt(a) < BigInt(b);

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const computeFee = (amount: bigint, fee: bigint) => ceilDiv(amount * fee, TWO_128);

/** Ekubo's swap step for an exact input of token0 (isToken1 false) or token1. Returns the output and the new price. */
function swapExactIn(sqrt: bigint, liquidity: bigint, amountIn: bigint, isToken1: boolean, fee: bigint, core: EkuboCore) {
  if (amountIn <= 0n) throw new QuoteError("enter an amount");
  if (amountIn > U128_MAX) throw new QuoteError("pool: amount too large");
  if (liquidity === 0n) throw new QuoteError("pool: no liquidity");
  const feeAmount = computeFee(amountIn, fee);
  const impact = amountIn - feeAmount;
  const N = liquidity << 128n;
  let next: bigint, out: bigint;
  if (isToken1) {
    next = sqrt + (impact << 128n) / liquidity;
    if (next > MAX_SQRT_RATIO) throw new QuoteError("pool: price limit");
    out = next === sqrt ? 0n : ((N * (next - sqrt)) / next) / sqrt;
  } else {
    // A zero-impact input leaves the price alone (next_sqrt_ratio_from_amount0's early return).
    if (impact === 0n) next = sqrt;
    else if (core === "v4") next = ceilDiv(N, N / sqrt + impact);   // v4.0.1 floors N / sqrt first
    else {
      const den = N + impact * sqrt;
      if (den >= TWO_320) throw new QuoteError("pool: price limit");   // v5.0.2 refuses denominators past 2^320
      next = ceilDiv(N * sqrt, den);
    }
    if (next < MIN_SQRT_RATIO) throw new QuoteError("pool: price limit");
    out = next === sqrt ? 0n : ((sqrt - next) * liquidity) >> 128n;
  }
  if (out === 0n) throw new QuoteError("pool: pays zero");
  return { out, fee: feeAmount, sqrtRatioAfter: next };
}

/** Spend `currencyIn`; receive tokens. fee is in currency. */
export function ekuboQuoteBuy(pool: EkuboPool, currencyIn: IntLike): { out: bigint; fee: bigint; sqrtRatioAfter: bigint } {
  const r = swapExactIn(pool.sqrtRatio, pool.liquidity, uint(currencyIn, "currencyIn"), pool.coinIsToken0, pool.fee, pool.core);
  return { out: r.out, fee: r.fee, sqrtRatioAfter: r.sqrtRatioAfter };
}

/** Sell `tokensIn`; receive currency. fee is in the coin (burned when collected). */
export function ekuboQuoteSell(pool: EkuboPool, tokensIn: IntLike): { paid: bigint; fee: bigint; sqrtRatioAfter: bigint } {
  const r = swapExactIn(pool.sqrtRatio, pool.liquidity, uint(tokensIn, "tokensIn"), !pool.coinIsToken0, pool.fee, pool.core);
  return { paid: r.out, fee: r.fee, sqrtRatioAfter: r.sqrtRatioAfter };
}

/** The pool after a quoted trade. */
export const ekuboApply = (pool: EkuboPool, r: { sqrtRatioAfter: bigint }): EkuboPool => ({ ...pool, sqrtRatio: r.sqrtRatioAfter });

/** Currency per token at a 128.128 sqrt ratio, as { num, den } (exact) for a pool with the coin on `coinIsToken0`. */
export function ekuboPrice(sqrtRatio: IntLike, coinIsToken0: boolean): { num: bigint; den: bigint } {
  const p = uint(sqrtRatio) * uint(sqrtRatio);   // token1 per token0, times 2^256
  return coinIsToken0 ? { num: p, den: 1n << 256n } : { num: 1n << 256n, den: p };
}

/**
 * The pool's holdings implied by one full-range position at this price (what a constant-product pool with the
 * same liquidity would hold): coin and currency, for display ("liquidity") and impact. Exact to within rounding.
 */
export function ekuboReserves(pool: EkuboPool): { tokens: bigint; currency: bigint } {
  const { sqrtRatio: s, liquidity: L } = pool;
  const amount0 = (L << 128n) / s, amount1 = (L * s) >> 128n;
  return pool.coinIsToken0 ? { tokens: amount0, currency: amount1 } : { tokens: amount1, currency: amount0 };
}
