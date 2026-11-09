/**
 * Trades, from quote to the calls a wallet signs: what a buy or sell gets, its fee, the minimum it accepts after
 * slippage, its price impact, and the last-buy partial fill on the curve; the order for a quote the trader accepted,
 * checked against the chain's state just before signing; and its calls. After graduation the coin trades in its Ekubo
 * pool (contract v2), quoted using Core's single-step arithmetic (ekubo.ts documents the remaining multi-step parity
 * check). Also: amounts typed in the coin, STRK or USD, and the room a trade must leave for its network fee. Pure;
 * amounts are BigInt base units. The site's trade panel and bots use the same code.
 */
import { BPS } from "./math.ts";
import { QuoteError, costForTokens, quoteBuy, quoteSell, type CurveParams, type CurveState } from "./curve.ts";
import { ekuboPrice, ekuboQuoteBuy, ekuboQuoteSell, ekuboReserves, type EkuboPool } from "./ekubo.ts";
import { buildEkuboTradeCalls, curveTradeCalls, ekuboPoolKey, type HokoriCall } from "./calls.ts";
import { selectorOf } from "./selectors.ts";
import type { Venue } from "./trades.ts";

export type Side = "buy" | "sell";
export type TradeQuote = {
  venue: Venue; side: Side;
  pay: bigint;          // what the trader hands over (STRK for a buy, tokens for a sell)
  spend: bigint;        // what is actually taken (a last curve buy can take less than offered)
  refund: bigint;       // offered but not taken (last curve buy)
  receive: bigint;      // tokens for a buy, STRK for a sell (after fees)
  fee: bigint;          // the trading fee: in STRK, except a pool sell's, which is in the coin (feeInCoin)
  feeInCoin: boolean;
  minReceive: bigint;   // receive less the slippage allowance: the trade refuses less
  priceBefore: number;  // spot price, STRK per token
  priceAfter: number;
  impactPpm: number;    // spot price change, parts per million (signed)
  /** The coin quoted, when the quote came from the client (createHokori): prepareTrade refuses it for another coin. */
  token?: string;
  /** A client quote of a curve buy: the fee rate it was quoted at (the launch window's, or the normal one). */
  buyFeeBps?: bigint;
};

export const SLIPPAGES_BPS = [50, 100, 200, 500] as const;

const spot = (num: bigint, den: bigint) => Number(num) / Number(den);
/** STRK per token in an Ekubo pool at `sqrtRatio`. */
const poolSpot = (pool: EkuboPool, sqrtRatio: bigint) => { const p = ekuboPrice(sqrtRatio, pool.coinIsToken0); return spot(p.num, p.den); };
const withSlippage = (v: bigint, bps: number) => (v * (BPS - BigInt(bps))) / BPS;

/** Quotes a trade; throws QuoteError where the contract would refuse it (too small, nothing to sell, closed...). */
export function tradeQuote(o: {
  venue: Venue; side: Side; amount: bigint; slippageBps: number;
  curve?: { state: CurveState; params: CurveParams }; pool?: EkuboPool;
}): TradeQuote {
  if (o.amount <= 0n) throw new QuoteError("enter an amount");
  if (o.venue === "curve") {
    if (!o.curve) throw new QuoteError("curve state missing");
    const { state, params } = o.curve;
    const before = spot(state.q, state.t);
    if (o.side === "buy") {
      const r = quoteBuy(state, params, o.amount);
      const after = spot(r.new_q, r.new_t);
      return { venue: "curve", side: "buy", pay: o.amount, spend: r.spent, refund: r.refund, receive: r.out, fee: r.fee, feeInCoin: false,
        minReceive: withSlippage(r.out, o.slippageBps), priceBefore: before, priceAfter: after, impactPpm: Math.round((after / before - 1) * 1e6) };
    }
    const r = quoteSell(state, params, o.amount);
    const after = spot(r.new_q, r.new_t);
    return { venue: "curve", side: "sell", pay: o.amount, spend: o.amount, refund: 0n, receive: r.paid, fee: r.fee, feeInCoin: false,
      minReceive: withSlippage(r.paid, o.slippageBps), priceBefore: before, priceAfter: after, impactPpm: Math.round((after / before - 1) * 1e6) };
  }
  if (!o.pool) throw new QuoteError("pool state missing");
  const pool = o.pool, before = poolSpot(pool, pool.sqrtRatio);
  if (o.side === "buy") {
    const r = ekuboQuoteBuy(pool, o.amount);
    const after = poolSpot(pool, r.sqrtRatioAfter);
    return { venue: "pool", side: "buy", pay: o.amount, spend: o.amount, refund: 0n, receive: r.out, fee: r.fee, feeInCoin: false,
      minReceive: withSlippage(r.out, o.slippageBps), priceBefore: before, priceAfter: after, impactPpm: Math.round((after / before - 1) * 1e6) };
  }
  const r = ekuboQuoteSell(pool, o.amount);
  const after = poolSpot(pool, r.sqrtRatioAfter);
  return { venue: "pool", side: "sell", pay: o.amount, spend: o.amount, refund: 0n, receive: r.paid, fee: r.fee, feeInCoin: true,
    minReceive: withSlippage(r.paid, o.slippageBps), priceBefore: before, priceAfter: after, impactPpm: Math.round((after / before - 1) * 1e6) };
}

/** A contract refusal in plain words. */
/** `symbol`: the coin's currency, for the messages that name it (STRK, or ZEC on the ZEC launchpad). */
export function quoteProblem(e: unknown, symbol = "STRK"): string {
  const reason = e instanceof QuoteError ? e.reason : e instanceof Error ? e.message : String(e);
  if (/below minimum trade/.test(reason)) return "That's below the smallest trade the curve takes.";
  if (/sell exceeds sold/.test(reason)) return "That's more than the curve can buy back (more than it has sold).";
  if (/closed/.test(reason)) return "The curve is closed: it sold out and graduates into its pool.";
  if (/zero|pays nothing|pays zero/.test(reason)) return "That's too small to trade.";
  if (/price limit|amount too large/.test(reason)) return "That's more than the pool can trade at once.";
  if (/enter an amount/.test(reason)) return "Enter an amount.";
  if (/more than is left/.test(reason)) return "That's more tokens than the curve has left.";
  if (/more than the pool holds/.test(reason)) return "That's more tokens than the pool holds.";
  if (/pays less than asked/.test(reason)) return `Selling everything wouldn't return that much ${symbol}.`;
  if (/no USD price/.test(reason)) return `The ${symbol} price isn't available right now; use ${symbol} or the coin.`;
  return reason;
}

/** What gets signed for an accepted quote: where, how much is offered at most, and the least that must come back. */
export type Order = { venue: Venue; side: Side; amount: bigint; minReceive: bigint };

/**
 * The order for a quote the trader accepted, checked against the chain's state read just before signing. The order
 * keeps the accepted quote's venue and minimum, and it never offers more than that quote spends: a last buy on the curve
 * (which takes only part of what was entered) offers just that part, which still buys out the curve exactly, so trades
 * landing in between can't turn it into a bigger spend than was shown. Anything that would need a different order (the
 * curve sold out or graduated, or the price moved past the slippage limit) returns a problem instead: the panel shows
 * the new quote, and the trader accepts it with another press.
 */
export function placeOrder(shown: TradeQuote, chain: { venue: Venue; curve?: { state: CurveState; params: CurveParams }; pool?: EkuboPool }, minTrade: bigint):
  { order: Order; fresh: TradeQuote } | { problem: string } {
  if (chain.venue !== shown.venue) return { problem: "The curve sold out and the coin graduated since this quote, so it now trades in its pool. Check the new quote, then press again." };
  const amount = shown.venue === "curve" && shown.side === "buy" && shown.refund > 0n ? (shown.spend > minTrade ? shown.spend : minTrade) : shown.pay;
  let fresh: TradeQuote;
  try { fresh = tradeQuote({ venue: shown.venue, side: shown.side, amount, slippageBps: 0, curve: chain.curve, pool: chain.pool }); }
  catch (e) { return { problem: `${quoteProblem(e)} Check the new quote.` }; }
  if (fresh.receive < shown.minReceive) return { problem: "The price moved past your slippage limit since the quote. Check the new quote and try again." };
  return { order: { venue: shown.venue, side: shown.side, amount, minReceive: shown.minReceive }, fresh };
}

const hex = (v: string | bigint | number) => "0x" + BigInt(v).toString(16);

/** Where a graduated coin trades (contract v2): its Ekubo pool, through Ekubo's Router. */
export type PoolRoute = {
  router: string;     // Ekubo's Router
  locker: string;     // the factory's locker: the pool's extension, and the deadline check
  coin: string; currency: string;
  coinIsToken0: boolean;
  fee: string;        // the pool key's fee: the factory's trading fee, as Ekubo encodes it (read from the locker)
};
/** The pool key's felts: token0 (the lower address), token1, fee, tick spacing, extension. */
export const poolKeyFelts = (r: PoolRoute): string[] => ekuboPoolKey({ coin: r.coin, currency: r.currency, extension: r.locker, fee: r.fee });

/**
 * The wallet calls for an order.
 * - On the curve: an exact approval of what it offers, then buy(gross, min_out, deadline) or sell(tokens, min_paid,
 *   deadline) on the curve at `target`. With `graduate`, for a buy known to take the curve's last tokens (its network
 *   fee estimated with graduation), buy_and_graduate instead: the same buy, which also graduates the coin. A plain buy
 *   never graduates, so one that ends up the last only because others bought first still fits its fee (contract v2,
 *   review d2684e0 R3); Hokori's graduation service then graduates the coin.
 * - In the pool (contract v2): the locker's check_deadline(deadline) first (Ekubo's Router has no deadline, so a trade
 *   that reaches the chain late reverts whole), then the input sent to the Router, swap(route, exact input),
 *   clear_minimum(output, min) (it refuses less than the minimum), and clear(input) (anything not taken comes back).
 */
export function orderCalls(order: Order, o: { target: string; payToken: string; deadline: number; route?: PoolRoute; graduate?: boolean }): HokoriCall[] {
  const trade = { side: order.side, amount: order.amount, minReceive: order.minReceive, deadline: o.deadline };
  if (order.venue === "curve")
    return curveTradeCalls({ ...trade, curve: o.target, payToken: o.payToken, graduate: order.side === "buy" && !!o.graduate });
  // A pool order needs its route: never fall back to curve calls.
  if (!o.route) throw new QuoteError("pool: the coin's pool route is missing");
  if (order.amount >= 1n << 128n) throw new QuoteError("pool: amount too large");
  const r = o.route;
  return buildEkuboTradeCalls({ ...trade, coin: r.coin, currency: r.currency, extension: r.locker, fee: r.fee, router: r.router });
}

/** A trade's ordered calls: each [target, selector] is paired with the following argument array. Recovery decodes
 * the account calldata and compares the complete calls, including order and multiplicity. */
export function callFingerprint(calls: { contractAddress: string; entrypoint: string; calldata: string[] }[]): string[][] {
  return calls.flatMap(c => [[hex(c.contractAddress), hex(selectorOf(c.entrypoint))], c.calldata.map(v => hex(v))]);
}

// ---- Amounts in the coin, in STRK or in USD ------------------------------------------------------------------------

/** What an amount is typed in. A buy offers STRK and a sell offers tokens (the trade's own amount); the other units
 *  are converted to it: "exactly N tokens" and "exactly N STRK back" are inverted from the same arithmetic the
 *  contracts run, and USD goes through the STRK price (display-grade). */
export type Unit = "coin" | "strk" | "usd";
export type Market = { venue: Venue; curve?: { state: CurveState; params: CurveParams }; pool?: EkuboPool };

const attempt = (ok: (x: bigint) => boolean, x: bigint) => { try { return ok(x); } catch { return false; } };
/** The smallest x >= 1 with ok(x), for ok monotone in x and no larger than `cap`; null if even `cap` fails. */
function smallest(ok: (x: bigint) => boolean, cap: bigint): bigint | null {
  let hi = 1n;
  while (!attempt(ok, hi)) { if (hi >= cap) return null; hi = hi * 2n > cap ? cap : hi * 2n; }
  let lo = 0n;
  while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (attempt(ok, mid)) hi = mid; else lo = mid; }
  return hi;
}
const BIG = (1n << 128n) - 1n;   // the most Ekubo takes in one trade

/** The STRK a buy must offer to receive at least `tokens`. */
export function costOfTokens(m: Market, tokens: bigint): bigint {
  if (tokens <= 0n) throw new QuoteError("enter an amount");
  if (m.venue === "curve") return costForTokens(m.curve!.state, m.curve!.params, tokens).gross;
  const pool = m.pool!;
  const g = tokens < ekuboReserves(pool).tokens ? smallest(x => ekuboQuoteBuy(pool, x).out >= tokens, BIG) : null;
  if (g === null) throw new QuoteError("pool: asks for more than the pool holds");
  return g;
}

/** The tokens a sell must offer to receive at least `strk`. */
export function tokensForProceeds(m: Market, strk: bigint): bigint {
  if (strk <= 0n) throw new QuoteError("enter an amount");
  const t = m.venue === "curve"
    ? smallest(x => quoteSell(m.curve!.state, m.curve!.params, x).paid >= strk, m.curve!.state.sold)
    : smallest(x => ekuboQuoteSell(m.pool!, x).paid >= strk, BIG);
  if (t === null) throw new QuoteError("pays less than asked");
  return t;
}

// USD amounts are 18-decimal fixed point like STRK; the price is a float (display-grade).
export const usdToStrk = (usd: bigint, usdPerStrk: number) => BigInt(Math.round(Number(usd) / usdPerStrk));
export const strkToUsd = (strk: bigint, usdPerStrk: number) => BigInt(Math.round(Number(strk) * usdPerStrk));

/** The trade's own amount (currency offered for a buy, tokens for a sell) for `value` typed in `unit`. The "strk" unit
 *  is the coin's currency, in its own base units; "usd" and "coin" values have 18 decimals. `currencyDecimals` (18,
 *  STRK's, unless the coin's currency has fewer: ZEC's 8) converts a dollar amount; `usdPerStrk` is one whole unit of
 *  the currency in dollars. */
export function nativeAmount(o: { side: Side; unit: Unit; value: bigint; usdPerStrk: number | null; market: Market; currencyDecimals?: number }): bigint {
  const scale = 10n ** BigInt(18 - (o.currencyDecimals ?? 18));
  const fromUsd = (v: bigint) => { if (!o.usdPerStrk) throw new QuoteError("no USD price"); return usdToStrk(v, o.usdPerStrk) / scale; };
  if (o.side === "buy") return o.unit === "strk" ? o.value : o.unit === "usd" ? fromUsd(o.value) : costOfTokens(o.market, o.value);
  return o.unit === "coin" ? o.value : tokensForProceeds(o.market, o.unit === "usd" ? fromUsd(o.value) : o.value);
}

/** The same trade's amount in another unit, for switching what the amount box shows (null: no USD price). The "strk"
 *  amount is in the currency's base units; a dollar amount has 18 decimals (`currencyDecimals` as in nativeAmount). */
export function amountIn(q: TradeQuote, unit: Unit, usdPerStrk: number | null, currencyDecimals = 18): bigint | null {
  const strk = q.side === "buy" ? q.pay : q.receive, coin = q.side === "buy" ? q.receive : q.pay;
  if (unit === "strk") return strk;
  if (unit === "coin") return coin;
  return usdPerStrk ? strkToUsd(strk * 10n ** BigInt(18 - currencyDecimals), usdPerStrk) : null;
}

/** A buy of `percent` of the STRK balance. Starknet charges fees in STRK, so it leaves `reserve` for
 *  them (see feeReserve), and a smaller share is capped the same way. Rounded down to 0.0001 STRK. */
export function buyShare(balance: bigint, percent: number, reserve: bigint): bigint {
  const spendable = balance > reserve ? balance - reserve : 0n;
  const share = (balance * BigInt(percent)) / 100n;
  const v = share < spendable ? share : spendable;
  return v - (v % 10n ** 14n);
}
/** What a share buy keeps back for fees, from Starknet's estimate for it: room for this trade (see feeShortfall) and
 *  about as much again for one more, such as selling later. Not a promise about later fees. */
export const feeReserve = (estimate: bigint) => estimate * 3n;
/** Room a trade must leave for its own network fee: Starknet takes the fee after the trade runs, so a buy that spends
 *  the STRK its fee needs reverts and is still charged. 1.5x the estimate: the fee charged can come in above it (gas
 *  prices move before the block), and wallets set their fee limit above it (Braavos at 1.3x, measured 15 Oct). */
export const feeHeadroom = (estimate: bigint) => (estimate * 3n) / 2n;
/** Null when `balance` covers `spend` plus the fee's headroom; otherwise the most that could be spent instead (rounded
 *  down to 0.0001 STRK; 0 when not even the fee is covered). A typed amount is never shrunk silently: callers say so. */
export function feeShortfall(balance: bigint, spend: bigint, estimate: bigint): { maxSpend: bigint } | null {
  const need = feeHeadroom(estimate);
  if (balance >= spend + need) return null;
  const max = balance > need ? balance - need : 0n;
  return { maxSpend: max - (max % 10n ** 14n) };
}
/** Whether a quoted curve buy takes the curve's last tokens (`remaining`), graduating the coin in the same call: an exact
 *  fill with nothing refunded graduates too. */
export const buyGraduates = (q: TradeQuote, remaining: bigint) => q.venue === "curve" && q.side === "buy" && q.receive === remaining;
