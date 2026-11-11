/**
 * Trades routed through Hokori's TradeAdapter contract: one-click session trades and filled limit orders. On chain the curve names the adapter as the
 * buyer or seller, and a pool trade's sender is the account (a session) or the order keeper (an order): neither says
 * whose trade it is. The adapter's own `Bought` and `Sold` events name the account.
 *
 * Each record is matched, by amounts, to the trade events of its coin in the same transaction: a curve trade (its spent
 * and tokens), a pool trade (the swap's), or a buy that crossed graduation (its curve buy and pool swap together). A
 * matched trade is the account's. A curve trade by the adapter that no record matches is credited to nobody, never to
 * the adapter. Pool amounts are matched allowing for the Router's leftovers: the adapter clears whatever the Router holds,
 * so what it counts as spent can only be less, and as received only more, than the pool moved.
 */
import { allEvents, type ChainEvent, type EventSource } from "./events.ts";
import { eventAmounts } from "./protected.ts";
import { SELECTOR } from "./selectors.ts";
import type { Venue } from "./trades.ts";

/** The TradeAdapter as deployed: its address and deployment block. */
export type TradeAdapterRef = { address: string; block: number };
/** One routed trade, as the adapter recorded it: what the account spent and received. */
export type RoutedRecord = { adapter: string; tx: string; account: string; coin: string; sell: boolean; amountIn: bigint; amountOut: bigint; venue: "curve" | "pool" | "both" };

const hex = (v: string | bigint) => "0x" + BigInt(v).toString(16).padStart(64, "0");
const is = (a: string, b: string) => { try { return BigInt(a) === BigInt(b); } catch { return false; } };
const u256 = (d: string[], i: number) => BigInt(d[i]) + (BigInt(d[i + 1]) << 128n);
/** The adapter's venue short strings: 'curve', 'pool', 'curve+pool'. */
const VENUES: Record<string, RoutedRecord["venue"]> = { [hex(0x6375727665n)]: "curve", [hex(0x706f6f6cn)]: "pool", [hex(0x63757276652b706f6f6cn)]: "both" };
type EventLike = Pick<ChainEvent, "keys" | "data" | "transaction_hash"> & { from_address?: string };

/**
 * A record from the adapter's `Bought { #[key] account, #[key] coin, spent: u256, tokens: u256, venue, budgeted }` or
 * `Sold { #[key] account, #[key] coin, tokens: u256, paid: u256, venue, budgeted }`; null for anything else.
 */
export function parseRouted(e: EventLike): RoutedRecord | null {
  if (!e.from_address || e.keys.length < 3 || e.data.length < 6) return null;
  const bought = is(e.keys[0], SELECTOR.Bought), sold = is(e.keys[0], SELECTOR.Sold);
  if (!bought && !sold) return null;
  try {
    const venue = VENUES[hex(e.data[4])];
    if (!venue) return null;
    return { adapter: hex(e.from_address), tx: hex(e.transaction_hash), account: hex(e.keys[1]), coin: hex(e.keys[2]), sell: sold,
      amountIn: u256(e.data, 0), amountOut: u256(e.data, 2), venue };
  } catch { return null; }
}

/** The adapter's records in blocks `from`..`to` (from its deployment on): one read, whatever the network's traffic. */
export async function readRoutedRecords(provider: EventSource, adapter: TradeAdapterRef | undefined, from: number, to: number,
  opts?: { chunk?: number; maxPages?: number }): Promise<RoutedRecord[]> {
  if (!adapter || from > to || adapter.block > to) return [];
  const events = await allEvents(provider, { address: adapter.address, keys: [[SELECTOR.Bought, SELECTOR.Sold]], from: Math.max(from, adapter.block), to }, opts);
  return events.map(parseRouted).filter((r): r is RoutedRecord => r !== null);
}

/** One trade event to attribute: the event, its venue and its coin. */
export type RoutedTradeRef = { e: Pick<ChainEvent, "keys" | "data" | "transaction_hash">; venue: Venue; coin: string };

/**
 * For each trade, in order: the account that made it through the adapter; `null` for a curve trade by the adapter that
 * no record matches (credited to nobody); `undefined` for a trade the adapter didn't route (left as it is).
 */
export function routedAccounts(trades: readonly RoutedTradeRef[], records: readonly RoutedRecord[], adapter: TradeAdapterRef | undefined): (string | null | undefined)[] {
  const out: (string | null | undefined)[] = trades.map(() => undefined);
  if (!adapter) return out;
  const me = hex(adapter.address);
  const facts = trades.map(t => ({ tx: hex(t.e.transaction_hash), coin: hex(t.coin), venue: t.venue, moved: eventAmounts(t.e, t.venue, t.coin),
    byAdapter: t.venue === "curve" && !!t.e.keys[1] && is(t.e.keys[1], me) }));
  const open = (i: number, r: RoutedRecord, venue: Venue) => out[i] === undefined && facts[i].venue === venue && facts[i].tx === r.tx
    && facts[i].coin === r.coin && facts[i].moved !== null && facts[i].moved!.sell === r.sell && (venue === "pool" || facts[i].byAdapter);
  // The pool's side of a routed swap: the adapter's count can only be lower in, higher out (the Router's leftovers).
  const poolFits = (i: number, wantIn: bigint, wantOut: bigint) => { const m = facts[i].moved!; return wantIn <= m.amountIn && wantOut >= m.amountOut && wantIn > 0n; };
  for (const r of records) {
    if (r.adapter !== me) continue;
    const idx = (venue: Venue) => trades.map((_, i) => i).filter(i => open(i, r, venue));
    if (r.venue === "curve") {
      const i = idx("curve").find(j => facts[j].moved!.amountIn === r.amountIn && facts[j].moved!.amountOut === r.amountOut);
      if (i !== undefined) out[i] = r.account;
    } else if (r.venue === "pool") {
      const i = idx("pool").find(j => poolFits(j, r.amountIn, r.amountOut));
      if (i !== undefined) out[i] = r.account;
    } else {
      // A buy that crossed graduation: its curve buy (the curve's last tokens) and the pool swap after it.
      for (const c of idx("curve")) {
        const cm = facts[c].moved!;
        if (cm.amountIn > r.amountIn || cm.amountOut > r.amountOut) continue;
        const p = idx("pool").find(j => poolFits(j, r.amountIn - cm.amountIn, r.amountOut - cm.amountOut));
        if (p !== undefined) { out[c] = r.account; out[p] = r.account; break; }
      }
    }
  }
  // A curve trade by the adapter that no record claims: nobody's.
  facts.forEach((f, i) => { if (f.byAdapter && out[i] === undefined) out[i] = null; });
  return out;
}

/** `trade` as `routedAccounts` found it: the account's (attribution "account", its trader the account), nobody's
 *  (`null`: "unknown", no trader), or unchanged (`undefined`: not routed). */
export function withRouted<T extends { trader: string; attribution?: "account" | "protected" | "unknown" }>(trade: T, account: string | null | undefined): T {
  if (account === undefined) return trade;
  if (account === null) return { ...trade, attribution: "unknown", trader: "0x" + "0".repeat(64) };
  return { ...trade, attribution: "account", trader: account };
}
