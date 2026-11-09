/**
 * A coin's curve and pool state, followed from its events alone. The market-data service publishes it in each coin's
 * file, so coin pages don't each re-read it from the chain. It is exact, because every
 * field the curve and its Ekubo pool change is in an event (contracts/src/curve.cairo, locker.cairo):
 *
 *   curve Buy { spent, fee, tokens, q, t }   q, t; sold += tokens; real += spent - fee; fees += fee; closes at the cap
 *   curve Sell { tokens, gross, fee, q, t }  q, t; sold -= tokens; real -= gross; fees += fee
 *   curve Graduated { .., grad_fee, .. }     graduated; real = 0; fees += grad_fee
 *   curve FeesFlushed { amount }             fees = 0
 *   locker Graduated { .., liquidity, sqrt_ratio, .. }
 *                                            the pool's liquidity (fixed from then on: only the locked position can
 *                                            exist) and its opening price
 *   Core Swapped { .., sqrt_ratio_after, .. } the pool's price (Core's event for the coin's pool: the locker has no
 *                                            swap hooks, so emits nothing for trades)
 *
 * The curve's and the locker's Graduated events share a name (so a key), and the same data length; which contract
 * emitted one says which it is. Not followed: the pool's uncollected fees, and anything in Ekubo beyond this pool.
 */
import { EVENT } from "./trades.ts";

export type FollowedState = {
  /** The curve's virtual reserves; null until the first curve trade (until then they are the launch values). */
  q: bigint | null; t: bigint | null;
  sold: bigint; real: bigint; fees: bigint; open: boolean; graduated: boolean;
  /** The Ekubo pool, from graduation on. */
  sqrtRatio: bigint | null; liquidity: bigint | null;
};
/** A coin's state as its file publishes it: valid through block `atBlock`. */
export type PublishedState = FollowedState & { atBlock: number };

export const LAUNCHED: FollowedState = { q: null, t: null, sold: 0n, real: 0n, fees: 0n, open: true, graduated: false, sqrtRatio: null, liquidity: null };

const is = (key: string, selector: string) => BigInt(key) === BigInt(selector);
const u256 = (d: string[], i: number) => BigInt(d[i]) + (BigInt(d[i + 1]) << 128n);

/** The state after one event. `source` is what emitted it: the coin's curve, the factory's locker (its Graduated), or
 *  Ekubo Core for the coin's pool (its Swapped). Any other event leaves the state as it was. */
export function applyEvent(s: FollowedState, e: { keys: string[]; data: string[] }, source: "curve" | "locker" | "pool", curveTokens: bigint): FollowedState {
  const k = e.keys[0], d = e.data;
  if (source === "curve") {
    if (is(k, EVENT.BUY)) {
      const sold = s.sold + u256(d, 4);
      return { ...s, q: u256(d, 6), t: u256(d, 8), sold, real: s.real + u256(d, 0) - u256(d, 2), fees: s.fees + u256(d, 2), open: s.open && sold < curveTokens };
    }
    if (is(k, EVENT.SELL)) return { ...s, q: u256(d, 6), t: u256(d, 8), sold: s.sold - u256(d, 0), real: s.real - u256(d, 2), fees: s.fees + u256(d, 4) };
    if (is(k, EVENT.GRAD)) return { ...s, graduated: true, real: 0n, fees: s.fees + u256(d, 5) };
    if (is(k, EVENT.FLUSH)) return { ...s, fees: 0n };
    return s;
  }
  if (source === "locker") return is(k, EVENT.GRAD) ? { ...s, liquidity: BigInt(d[4]), sqrtRatio: u256(d, 5) } : s;
  if (is(k, EVENT.SWAPPED) && d.length >= 18) return { ...s, sqrtRatio: u256(d, 16) };
  return s;
}

const str = (v: bigint | null) => (v === null ? null : String(v));
const big = (v: unknown) => (v === null || v === undefined ? null : BigInt(v as string));

/** For storage and the published file: amounts as decimal strings (they exceed 2^53). */
export function stateJson(s: FollowedState) {
  return { q: str(s.q), t: str(s.t), sold: String(s.sold), real: String(s.real), fees: String(s.fees), open: s.open, graduated: s.graduated,
    sqrtRatio: str(s.sqrtRatio), liquidity: str(s.liquidity) };
}

/** Reads a stored or published state back; throws on anything malformed. */
export function stateFromJson(j: Record<string, unknown>): FollowedState {
  if (typeof j.open !== "boolean" || typeof j.graduated !== "boolean") throw new Error("invalid coin state");
  const s = { q: big(j.q), t: big(j.t), sold: BigInt(j.sold as string), real: BigInt(j.real as string), fees: BigInt(j.fees as string),
    open: j.open, graduated: j.graduated, sqrtRatio: big(j.sqrtRatio), liquidity: big(j.liquidity) };
  if ((s.q === null) !== (s.t === null) || (s.graduated && (s.sqrtRatio === null || s.liquidity === null))) throw new Error("invalid coin state");
  return s;
}
