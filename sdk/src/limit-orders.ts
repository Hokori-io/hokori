/**
 * Limit orders' prices, exactly.
 *
 * A price P is the ALL-IN average price: currency spent (or received) per token, Hokori's trading fee included. It's
 * held as an exact fraction of base units, so 18-decimal coins against STRK (18) and against ZEC and strkBTC (8) round
 * the same way, with no floating point anywhere:
 *
 * - a limit buy spends X for at least `min_out = ceil(X / P)` tokens, so its average price is never above P;
 * - a sell (take-profit, or a stop's floor) of N tokens receives at least `min_paid = ceil(N × P)`, so its average price
 *   is never below P;
 * - the fill fee (the keeper's gas, plan B5) is separate: on a buy it is paid on top of X; on a sell it comes out of
 *   the proceeds, so the trader's net is at least `min_paid − fill fee`, which the form shows.
 *
 * Every rounding is in the trader's favour by at most one base unit, and the tests hold both bounds: the minimum
 * achieves the price, and one base unit less would not. Pure.
 */
import { COIN_DECIMALS } from "./currency.ts";

/** A price as an exact fraction: `num` currency base units per `den` coin base units. Always reduced, both positive. */
export type Price = { num: bigint; den: bigint };

const gcd = (a: bigint, b: bigint): bigint => { while (b) [a, b] = [b, a % b]; return a; };
const reduced = (num: bigint, den: bigint): Price => { const g = gcd(num, den); return { num: num / g, den: den / g }; };
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const positive = (v: bigint, what: string) => { if (v <= 0n) throw new RangeError(`${what} must be more than zero`); return v; };

/** The most decimal places a typed price may have: enough for a token worth a billionth of a satoshi. */
export const PRICE_MAX_PLACES = 36;

/**
 * A typed price, "currency per whole token" (e.g. "0.000002" STRK, or "0.00000001" BTC), as an exact fraction of base
 * units for a currency with `currencyDecimals` (STRK 18, ZEC and strkBTC 8) and a coin with `coinDecimals` (18).
 * Plain decimals only: no sign, no exponent, at most PRICE_MAX_PLACES places, and more than zero.
 */
export function priceFromText(text: string, currencyDecimals: number, coinDecimals = COIN_DECIMALS): Price {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new RangeError(`"${text}" isn't a plain decimal price`);
  const places = (m[2] ?? "").length;
  if (places > PRICE_MAX_PLACES) throw new RangeError(`a price has at most ${PRICE_MAX_PLACES} decimal places`);
  const scaled = positive(BigInt(m[1] + (m[2] ?? "")), "a price");   // the price × 10^places
  return reduced(scaled * 10n ** BigInt(currencyDecimals), 10n ** BigInt(places + coinDecimals));
}

/** The price as "currency per whole token" with `places` decimals, rounded down (for display only). */
export function priceText(p: Price, currencyDecimals: number, places = 12, coinDecimals = COIN_DECIMALS): string {
  const scale = 10n ** BigInt(places);
  const v = (p.num * 10n ** BigInt(coinDecimals) * scale) / (p.den * 10n ** BigInt(currencyDecimals));
  const whole = v / scale, frac = (v % scale).toString().padStart(places, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** The exact average price of a fill: `currency` base units for `tokens` coin base units. */
export const averagePrice = (currency: bigint, tokens: bigint): Price => reduced(positive(currency, "the currency amount"), positive(tokens, "the token amount"));

/** a ≤ b, exactly. */
export const priceAtMost = (a: Price, b: Price): boolean => a.num * b.den <= b.num * a.den;

/** A limit buy's minimum: spending `spend` (currency base units, trading fee included) at an average price no higher
 *  than `limit` buys at least this many coin base units. */
export function limitBuyMinOut(spend: bigint, limit: Price): bigint {
  return ceilDiv(positive(spend, "the amount to spend") * limit.den, limit.num);
}

/** A sell's minimum: `tokens` coin base units at an average price no lower than `limit` pay at least this much
 *  (currency base units, after the trading fee, before the fill fee). For a take-profit `limit` is its price; for a stop,
 *  its floor. */
export function limitSellMinPaid(tokens: bigint, limit: Price): bigint {
  return ceilDiv(positive(tokens, "the tokens to sell") * limit.num, limit.den);
}

/** What the trader is sure to keep from a sell once the fill fee is paid: its minimum less the fee. Refuses an order
 *  whose fee would take all of its minimum. */
export function sellNetAfterFillFee(minPaid: bigint, fillFee: bigint): bigint {
  if (fillFee < 0n) throw new RangeError("a fill fee can't be negative");
  if (fillFee >= minPaid) throw new RangeError("the fill fee would take all of this order's minimum: sell more, or at a higher price");
  return minPaid - fillFee;
}

/** A stop-loss's terms: it may fire once the spot price is at or below `trigger`, and then sells `tokens` for no less than
 *  `floor`, which must not be above the trigger. Returns the sell's minimum. */
export function stopLossMinPaid(tokens: bigint, trigger: Price, floor: Price): bigint {
  if (!priceAtMost(floor, trigger)) throw new RangeError("a stop's floor must be at or below its trigger");
  return limitSellMinPaid(tokens, floor);
}
