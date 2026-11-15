/**
 * Trades routed through Hokori's TradeAdapter contract: one-click session trades and filled limit orders. On chain the curve names the adapter as the
 * buyer or seller, and a pool trade's sender is the account (a session) or the order keeper (an order): neither says
 * whose trade it is. The adapter's own `Bought` and `Sold` events name the account.
 *
 * Each record is matched, by exact amounts, to the trade events of its coin in the same transaction: a curve trade (its
 * spent and tokens), a pool trade (the swap's), or a buy that crossed graduation (its curve buy and pool swap together).
 * A matched trade is the account's; each trade event is credited at most once. A curve trade by the adapter that no
 * record matches is credited to nobody, never to the adapter.
 *
 * Exact, with no tolerance: the adapter records what the venue moved, the curve's own figures or Ekubo's swap result,
 * which is the pool's Swapped event. Anything the Router held besides goes to the account but isn't in the record. A
 * tolerance would let a record claim an unrelated swap of the same coin in the same transaction.
 *
 * Unproven matches stay unknown. Amounts and a transaction hash don't identify an event: two swaps of the coin in one
 * transaction can move exactly the same amounts. Identical records (same transaction, coin, side, venue and amounts)
 * are matched together. When the trades they could be are exactly as many, each takes one: the trades are identical,
 * so which takes which changes nothing. When there are more such trades than records, or a trade that another record
 * could also be, nothing proves which are the adapter's, and all of them are credited to nobody (`null`) rather than
 * guessed. A trade already credited as protected (protected.ts) is never a routed one.
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

/** One trade event to attribute: the event, its venue and its coin; `protected` when protected.ts already credited it
 *  as a protected trade (then it is never a routed one). */
export type RoutedTradeRef = { e: Pick<ChainEvent, "keys" | "data" | "transaction_hash">; venue: Venue; coin: string; protected?: boolean };

/**
 * For each trade, in order: the account that made it through the adapter; `null` for a trade by the adapter that no
 * record proves whose it is (credited to nobody: a curve trade no record matches, or trades a match can't tell apart);
 * `undefined` for a trade the adapter didn't route (left as it is).
 */
export function routedAccounts(trades: readonly RoutedTradeRef[], records: readonly RoutedRecord[], adapter: TradeAdapterRef | undefined): (string | null | undefined)[] {
  const out: (string | null | undefined)[] = trades.map(() => undefined);
  if (!adapter) return out;
  const me = hex(adapter.address);
  const facts = trades.map(t => ({ tx: hex(t.e.transaction_hash), coin: hex(t.coin), venue: t.venue, moved: eventAmounts(t.e, t.venue, t.coin),
    byAdapter: t.venue === "curve" && !!t.e.keys[1] && is(t.e.keys[1], me), protected: !!t.protected }));
  const fits = (i: number, r: RoutedRecord, venue: Venue) => !facts[i].protected && facts[i].venue === venue && facts[i].tx === r.tx
    && facts[i].coin === r.coin && facts[i].moved !== null && facts[i].moved!.sell === r.sell && (venue === "pool" || facts[i].byAdapter);
  const exactly = (i: number, amountIn: bigint, amountOut: bigint) => { const m = facts[i].moved!; return m.amountIn === amountIn && m.amountOut === amountOut; };
  /** The trades a record could be: each one trade (a curve or pool trade) or two (a crossing buy's curve buy and the
   *  pool swap that took the rest). */
  const candidates = (r: RoutedRecord): number[][] => {
    const idx = (venue: Venue) => trades.map((_, i) => i).filter(i => fits(i, r, venue));
    if (r.venue !== "both") return idx(r.venue).filter(j => exactly(j, r.amountIn, r.amountOut)).map(j => [j]);
    const sets: number[][] = [];
    for (const c of idx("curve")) {
      const cm = facts[c].moved!;
      if (cm.amountIn >= r.amountIn || cm.amountOut > r.amountOut) continue;   // the pool took something
      for (const p of idx("pool")) if (exactly(p, r.amountIn - cm.amountIn, r.amountOut - cm.amountOut)) sets.push([c, p]);
    }
    return sets;
  };
  // Identical records together, with the trades they could be.
  const groups = new Map<string, { records: RoutedRecord[]; sets: number[][] }>();
  for (const r of records) {
    if (r.adapter !== me) continue;
    const key = [r.tx, r.coin, r.sell, r.venue, r.amountIn, r.amountOut].join(":");
    const g = groups.get(key);
    if (g) g.records.push(r); else groups.set(key, { records: [r], sets: candidates(r) });
  }
  // How many groups could each trade be: a trade two groups could both be proves neither.
  const claims = new Map<number, number>();
  for (const g of groups.values()) for (const i of new Set(g.sets.flat())) claims.set(i, (claims.get(i) ?? 0) + 1);
  for (const { records: same, sets } of groups.values()) {
    const all = sets.flat();
    if (!all.length) continue;
    const proven = sets.length === same.length && new Set(all).size === all.length && all.every(i => claims.get(i) === 1);
    if (proven) sets.forEach((s, n) => s.forEach(i => { out[i] = same[n].account; }));
    else all.forEach(i => { out[i] = null; });
  }
  // A curve trade by the adapter that no record claims: nobody's.
  facts.forEach((f, i) => { if (f.byAdapter && out[i] === undefined) out[i] = null; });
  return out;
}

/** `trade` as `routedAccounts` found it: the account's (attribution "account", its trader the account), nobody's
 *  (`null`: "unknown", no trader), or unchanged (`undefined`: not routed). A protected trade stays as it is: its
 *  attribution is proven by its own adapter's record. */
export function withRouted<T extends { trader: string; attribution?: "account" | "protected" | "unknown" }>(trade: T, account: string | null | undefined): T {
  if (account === undefined || trade.attribution === "protected") return trade;
  if (account === null) return { ...trade, attribution: "unknown", trader: "0x" + "0".repeat(64) };
  return { ...trade, attribution: "account", trader: account };
}
