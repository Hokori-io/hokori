/**
 * Protected trades: trades made through Hokori's privacy adapters from Starknet's STRK20 privacy pool. On chain a
 * protected curve trade's buyer or seller is the adapter, and a pool trade's sender is the wallet's relayer: neither is
 * the trader. Such a trade has no trader account. It is `attribution: "protected"`, its `trader` is the zero address,
 * and it never enters anyone's history, profit and loss, position or wallet counts.
 *
 * Provenance, never names. A trade is protected only when the adapter pinned to its coin's factory (networks.ts
 * `privacy`) emitted ProtectedTrade in the same transaction, for the same coin, side and venue, with exactly the amounts
 * the curve's Buy or Sell, or Ekubo Core's Swapped event, moved. Each record proves one trade, so nothing is counted
 * twice. A curve trade whose buyer or seller is an adapter with no such record is "unknown": credited to nobody.
 *
 * Shared by every reader that builds trades from the chain: the market-data service and the site's own
 * readers (market-feed.ts, trades.ts createTradeLog), so all of them attribute a trade the same way.
 */
import { allEvents, type ChainEvent, type EventSource } from "./events.ts";
import type { PrivacyAdapterRef } from "./networks.ts";
import { SELECTOR } from "./selectors.ts";
import { EVENT, type Trade, type Venue } from "./trades.ts";

export type Attribution = "account" | "protected" | "unknown";
/** The trader a protected or unknown trade carries: nobody. */
export const NO_TRADER = "0x" + "0".repeat(64);
export const PROTECTED_TRADE = SELECTOR.ProtectedTrade;

/** The adapter's `ProtectedTrade { #[key] coin, sell, graduated, amount_in: u128, amount_out: u128 }`: what one
 *  protected trade spent and received. */
export type ProtectedRecord = { adapter: string; tx: string; coin: string; sell: boolean; graduated: boolean; amountIn: bigint; amountOut: bigint };

const hex = (v: string | bigint) => "0x" + BigInt(v).toString(16).padStart(64, "0");
const is = (a: string, b: string) => { try { return BigInt(a) === BigInt(b); } catch { return false; } };
const u256 = (d: string[], i: number) => BigInt(d[i]) + (BigInt(d[i + 1]) << 128n);
type EventLike = Pick<ChainEvent, "keys" | "data" | "transaction_hash"> & { from_address?: string };

/** A ProtectedTrade record from an adapter's event, or null for anything else. */
export function parseProtectedTrade(e: EventLike): ProtectedRecord | null {
  if (!e.from_address || e.keys.length < 2 || e.data.length < 4 || !is(e.keys[0], PROTECTED_TRADE)) return null;
  try {
    return { adapter: hex(e.from_address), tx: hex(e.transaction_hash), coin: hex(e.keys[1]), sell: BigInt(e.data[0]) !== 0n,
      graduated: BigInt(e.data[1]) !== 0n, amountIn: BigInt(e.data[2]), amountOut: BigInt(e.data[3]) };
  } catch { return null; }
}

/**
 * What a curve or pool trade event moved, as the adapter records a trade: the input spent and the output received.
 * - Curve `Buy { #[key] buyer, spent, fee, tokens, q, t }`: spent in (the fee included), tokens out.
 * - Curve `Sell { #[key] seller, tokens, gross, fee, q, t }`: tokens in, gross − fee out (what the seller received).
 * - Core's Swapped for the coin's pool (trades.ts SWAPPED_LENGTH): the amounts from the pool's side, so the coin leaving
 *   the pool is a buy.
 */
export function eventAmounts(e: Pick<ChainEvent, "keys" | "data">, venue: Venue, coin: string): { sell: boolean; amountIn: bigint; amountOut: bigint } | null {
  const d = e.data;
  try {
    if (venue === "curve" && is(e.keys[0], EVENT.BUY) && d.length >= 6) return { sell: false, amountIn: u256(d, 0), amountOut: u256(d, 4) };
    if (venue === "curve" && is(e.keys[0], EVENT.SELL) && d.length >= 6) return { sell: true, amountIn: u256(d, 0), amountOut: u256(d, 2) - u256(d, 4) };
    if (venue === "pool" && is(e.keys[0], EVENT.SWAPPED) && d.length >= 16) {
      const coinIs0 = is(d[1], coin);
      if (!coinIs0 && !is(d[2], coin)) return null;
      const [coinAt, moneyAt] = coinIs0 ? [12, 14] : [14, 12];
      const buy = BigInt(d[coinAt + 1]) !== 0n;
      return buy ? { sell: false, amountIn: BigInt(d[moneyAt]), amountOut: BigInt(d[coinAt]) } : { sell: true, amountIn: BigInt(d[coinAt]), amountOut: BigInt(d[moneyAt]) };
    }
  } catch { /* malformed: not a trade */ }
  return null;
}

/** The adapter pinned to `factory`, or null (no protected trading for its coins). */
export function adapterFor(adapters: readonly PrivacyAdapterRef[] | undefined, factory: string | null | undefined): string | null {
  if (!adapters || !factory) return null;
  const a = adapters.find(x => is(x.factory, factory));
  return a ? hex(a.address) : null;
}

/** One trade event to attribute: its coin, and the adapter pinned to that coin's factory (null: none). */
export type TradeEventRef = { e: Pick<ChainEvent, "keys" | "data" | "transaction_hash">; venue: Venue; coin: string; adapter: string | null };

/**
 * Each trade event's attribution, in order. `records`: the ProtectedTrade records of the same blocks (from the pinned
 * adapters only: readProtectedRecords). `adapters`: every pinned adapter, so a curve trade by an adapter without a
 * matching record is "unknown", never credited to the adapter's address.
 */
export function attributeTrades(trades: readonly TradeEventRef[], records: readonly ProtectedRecord[], adapters: readonly PrivacyAdapterRef[] = []): Attribution[] {
  const unused = [...records];
  const known = new Set(adapters.map(a => hex(a.address)));
  return trades.map(t => {
    const curveTrader = t.venue === "curve" && t.e.keys[1] ? hex(t.e.keys[1]) : null;
    const moved = t.adapter ? eventAmounts(t.e, t.venue, t.coin) : null;
    if (t.adapter && moved) {
      const adapter = hex(t.adapter), tx = hex(t.e.transaction_hash), coin = hex(t.coin);
      const i = unused.findIndex(r => r.adapter === adapter && r.tx === tx && r.coin === coin && r.sell === moved.sell && r.graduated === (t.venue === "pool")
        && r.amountIn === moved.amountIn && r.amountOut === moved.amountOut && (curveTrader === null || curveTrader === adapter));
      if (i >= 0) { unused.splice(i, 1); return "protected"; }
    }
    return curveTrader !== null && known.has(curveTrader) ? "unknown" : "account";
  });
}

/** `trade` with its attribution: a protected or unknown trade carries no trader. */
export const attributed = <T extends Trade>(trade: T, attribution: Attribution): T =>
  (attribution === "account" ? { ...trade, attribution } : { ...trade, attribution, trader: NO_TRADER });

/**
 * A trade published without an attribution (by a data service on code from before P4) whose trader is one of `adapters`:
 * a protected trade. A pinned adapter has no owner and trades only when Starknet's privacy pool calls it, so every trade
 * it made came from the pool (the preview's service, on the older code, showed the launch adapter's
 * address as the trader). Any other trade is returned as it is.
 */
export function legacyAttribution<T extends Trade>(trade: T, adapters: readonly PrivacyAdapterRef[] | undefined): T {
  if (trade.attribution !== undefined || !adapters?.length) return trade;
  let trader: string;
  try { trader = hex(trade.trader); } catch { return trade; }
  return adapters.some(a => hex(a.address) === trader) ? attributed(trade, "protected") : trade;
}

/** A trade's attribution; a trade published before attribution existed is an account's. */
export const attributionOf = (t: Pick<Trade, "attribution">): Attribution => t.attribution ?? "account";
/** Whether a trade belongs to its `trader` account (not protected, not unknown). */
export const hasTrader = (t: Pick<Trade, "attribution">) => attributionOf(t) === "account";

/** The ProtectedTrade records of `adapters` in blocks `from`..`to` (each adapter from its deployment block on): one read
 *  per adapter, so a reader's cost doesn't grow with the network's traffic. */
export async function readProtectedRecords(provider: EventSource, adapters: readonly PrivacyAdapterRef[] | undefined, from: number, to: number,
  opts?: { chunk?: number; maxPages?: number }): Promise<ProtectedRecord[]> {
  if (!adapters?.length || from > to) return [];
  const lists = await Promise.all(adapters.filter(a => a.block <= to).map(a =>
    allEvents(provider, { address: a.address, keys: [[PROTECTED_TRADE]], from: Math.max(from, a.block), to }, opts)));
  return lists.flat().map(parseProtectedTrade).filter((r): r is ProtectedRecord => r !== null);
}
