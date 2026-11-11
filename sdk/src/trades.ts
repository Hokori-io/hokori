/**
 * Trades from the chain's own events: each curve's Buy and Sell and, after graduation, Ekubo Core's Swapped events for
 * the coin's pool (a pool whose key names the factory's locker as its extension; one locker serves every coin of a
 * factory). The locker has no swap hooks (so Ekubo routes the pools as plain pools), so Core's event is
 * the only record of a pool trade. It names the pool but not the trader: the trader is the transaction's sender, read
 * separately. Each event carries the price after the trade. Shared by the site (its market and coin pages, the coin
 * page's incremental log below, the trade panel), the market-data service, and bots.
 */
import { byteArrayFromFelts } from "./address.ts";
import { allEvents, type ChainEvent, type EventSource } from "./events.ts";
import type { PrivacyAdapterRef } from "./networks.ts";
import { attributed, attributeTrades, readProtectedRecords, type Attribution } from "./protected.ts";
import { readRoutedRecords, routedAccounts, withRouted, type TradeAdapterRef } from "./routed.ts";

export type Venue = "curve" | "pool";
/** `attribution` (sdk/src/protected.ts): whose trade it is. "protected" and "unknown" trades carry the zero address as
 *  `trader` and belong to no account. Absent (a trade read or published before attribution existed): an account's. */
export type Trade = { time: number; block: number; tx: string; venue: Venue; side: "buy" | "sell"; trader: string; tokens: bigint; currency: bigint; priceAfter: number;
  attribution?: Attribution };
export type BlockSource = { getBlockWithTxHashes(block: number): Promise<unknown> };
export type TxSource = { getTransactionByHash(hash: string): Promise<unknown> };

/** STRK, the currency on every Starknet network (the same address on mainnet, Sepolia and devnet). */
export const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
/** The events Hokori reads, by their selectors (starknet_keccak of the event's name; checked against starknet.js in
 *  the SDK's tests). Hokori's contracts: LaunchCreated (factory), Buy, Sell, Graduated, FeesFlushed (curve; the
 *  locker's own Graduated shares the name), Transfer (the coin, OpenZeppelin's ERC-20); Ekubo Core's Swapped. */
export const EVENT = {
  LAUNCH: "0x357d68fbe7a6a30028c88b1094efd4614d9eed65cf27f0d40da9c405a629a12",
  BUY: "0x1bc0fdda630693f7eb9d27232dd4b373ff0c495943884038449200ada7d93e6",
  SELL: "0x160d925d7f3fc57a6fc5d05aac27fd1ae17fcf2a31a901375f427c5224e3219",
  GRAD: "0x36c2bc6e1f3df003a7f84d1a6f715017a63a49e4cf2f4d6c448a3b271423543",
  SWAPPED: "0x157717768aca88da4ac4279765f09f4d0151823d573537fbbeb950cdbd9a870",
  FLUSH: "0x29458367c57b45c7125511b508445adbe00588d5aaaa9ce8bda3e0fe357f304",
  TRANSFER: "0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9",
} as const;
/** A page that reads the chain itself (no market-data service) reads a graduated coin's pool trades over only this many
 *  recent blocks: Core's Swapped event can't be filtered by pool, so a read covers every Ekubo swap on Starknet. Such a
 *  page says its pool history is partial, and doesn't show figures that need all of it (review b37a86c R5). The
 *  service, and its verifier, read the whole history. */
export const POOL_FALLBACK_BLOCKS = 5_000;
/** Block ranges a whole-history read of Core's swaps is split into, so no single read grows too large. */
export const SWAP_READ_BLOCKS = 10_000;
const is = (key: string, selector: string) => BigInt(key) === BigInt(selector);
const u256 = (d: string[], i: number) => BigInt(d[i]) + (BigInt(d[i + 1]) << 128n);
const hex = (v: string | bigint) => "0x" + BigInt(v).toString(16).padStart(64, "0");

/** Currency per token at an Ekubo 128.128 sqrt ratio (token1 per token0), for display. */
export function poolPrice(sqrtRatio: bigint, token: string, currency: string): number {
  const r = Number(sqrtRatio) / 2 ** 128;
  return BigInt(token) < BigInt(currency) ? r * r : 1 / (r * r);
}

/** A trade from one curve event, or one of Core's Swapped events for a Hokori pool (null for any other event). `time` is
 *  its block's timestamp; `currency` places the coin in its Ekubo pool (token0 is the lower address); `trader` is a
 *  pool trade's transaction sender (Core's event doesn't name it). `priceScale` turns the event's price (base units per
 *  base unit) into whole currency per whole token: 1 for STRK, 10^10 for ZEC (sdk/src/currency.ts). */
export function tradeFrom(e: { keys: string[]; data: string[]; block_number?: number; transaction_hash: string }, venue: Venue, time: number, currency = STRK, trader?: string, priceScale = 1): Trade | null {
  const k = e.keys[0], d = e.data, block = e.block_number ?? 0;
  if (venue === "curve" && (is(k, EVENT.BUY) || is(k, EVENT.SELL))) {
    const buy = is(k, EVENT.BUY);
    return { time, block, tx: e.transaction_hash, venue, side: buy ? "buy" : "sell", trader: hex(e.keys[1]),
      tokens: buy ? u256(d, 4) : u256(d, 0), currency: buy ? u256(d, 0) : u256(d, 2), priceAfter: Number(u256(d, 6)) / Number(u256(d, 8)) * priceScale };
  }
  if (venue === "pool" && is(k, EVENT.SWAPPED) && d.length >= SWAPPED_LENGTH) {
    // Core's Swapped { locker, pool_key, params, delta { amount0, amount1 }, sqrt_ratio_after, .. }: amounts from the
    // pool's side, so the coin leaving the pool (negative) is a buy.
    const coinIs0 = BigInt(d[1]) !== BigInt(currency);
    const [coinAt, moneyAt] = coinIs0 ? [12, 14] : [14, 12];
    return { time, block, tx: e.transaction_hash, venue, side: BigInt(d[coinAt + 1]) !== 0n ? "buy" : "sell", trader: hex(trader ?? 0n),
      tokens: BigInt(d[coinAt]), currency: BigInt(d[moneyAt]), priceAfter: poolPrice(u256(d, 16), coinIs0 ? d[1] : d[2], currency) * priceScale };
  }
  return null;
}

/** Core's Swapped data: locker; pool_key (token0, token1, fee, tick_spacing, extension); params (amount { mag, sign },
 *  is_token1, sqrt_ratio_limit { low, high }, skip_ahead); delta (amount0 { mag, sign }, amount1 { mag, sign });
 *  sqrt_ratio_after { low, high }; tick_after { mag, sign }; liquidity_after. As Ekubo's own indexer parses it
 *  (EkuboProtocol/indexer src/starknet/core.ts), and checked against Core on Sepolia and mainnet forks. */
export const SWAPPED_LENGTH = 21;
/** The extension a Swapped event's pool names: a Hokori locker for a Hokori pool. */
type EventLike = Pick<ChainEvent, "keys" | "data" | "from_address">;
export const swappedExtension = (e: EventLike) => hex(e.data[5]);
/** The coin of a Hokori pool's Swapped event: whichever of the pool's tokens isn't the currency. */
export const swappedCoin = (e: EventLike, currency = STRK) => (BigInt(e.data[1]) === BigInt(currency) ? hex(e.data[2]) : hex(e.data[1]));
/** The other token of a Swapped event's pool when `coin` is one of its two (the currency), else null. */
export function swappedCurrencyFor(e: EventLike, coin: string): string | null {
  if (BigInt(e.data[1]) === BigInt(coin)) return hex(e.data[2]);
  if (BigInt(e.data[2]) === BigInt(coin)) return hex(e.data[1]);
  return null;
}
/** Whether `e` is Core's Swapped event for a pool of one of `lockers` (from Core itself, and well formed). */
export const isHokoriSwap = (e: EventLike, core: string, lockers: ReadonlySet<string>) =>
  !!e.from_address && BigInt(e.from_address) === BigInt(core) && e.keys.length > 0 && is(e.keys[0], EVENT.SWAPPED)
  && e.data.length >= SWAPPED_LENGTH && lockers.has(swappedExtension(e));

/** Fills `cache` with the senders of `hashes` it doesn't have yet (each pool trade's trader), at most `concurrency`
 *  reads at a time. A transaction's sender never changes. */
export async function txSenders(provider: TxSource, hashes: string[], cache: Map<string, string>, { concurrency = 8 } = {}) {
  const missing = [...new Set(hashes.map(h => hex(h)))].filter(h => !cache.has(h));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, missing.length) }, async () => {
    while (next < missing.length) {
      const h = missing[next++];
      const tx = await provider.getTransactionByHash(h) as { sender_address?: string };
      cache.set(h, hex(tx.sender_address ?? 0n));
    }
  }));
}

export type Launch = {
  token: string; curve: string; creator: string; index: number; name: string; symbol: string;
  metadataUri: string; metadataSha256: bigint; devTokens: bigint; launchFee: bigint; launchBlock: number; tx: string;
  /** The launch factory that created the coin (the event's emitter), when known. A site may follow several factories
   * , and each coin keeps the settings of the one that launched it. */
  factory?: string;
};
/** A coin from a factory's LaunchCreated event (`factory`: the event's emitter). */
export function parseLaunch(e: ChainEvent): Launch {
  const d = e.data;
  const name = byteArrayFromFelts(d, 2), symbol = byteArrayFromFelts(d, name.next), uri = byteArrayFromFelts(d, symbol.next);
  const at = uri.next;
  return {
    token: hex(e.keys[1]), curve: hex(d[0]), creator: hex(e.keys[2]), index: Number(BigInt(d[1])), name: name.text, symbol: symbol.text,
    metadataUri: uri.text, metadataSha256: u256(d, at), devTokens: u256(d, at + 4), launchFee: u256(d, at + 6), launchBlock: e.block_number ?? 0, tx: e.transaction_hash,
    ...(e.from_address ? { factory: hex(e.from_address) } : {}),
  };
}

/** The locker a Graduated event handed the reserve to (it holds the coin's Ekubo pool liquidity). */
export const graduatedPool = (e: ChainEvent) => hex(e.data[0]);

/** The curve's virtual token reserve after a curve trade event (for progress). */
export const curveTAfter = (e: ChainEvent) => u256(e.data, 8);

/** Fills `cache` with the timestamps of `blocks` it doesn't have yet, at most `concurrency` reads at a time. Block
 *  timestamps never change, so a cache is kept for as long as its reader lives. */
export async function blockTimes(provider: BlockSource, blocks: number[], cache: Map<number, number>, { concurrency = 8 } = {}) {
  const missing = [...new Set(blocks)].filter(b => !cache.has(b));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, missing.length) }, async () => {
    while (next < missing.length) {
      const b = missing[next++];
      cache.set(b, (await provider.getBlockWithTxHashes(b) as { timestamp: number }).timestamp);
    }
  }));
}

/** Core's Swapped events in blocks `from`..`to` for the pools of `lockers`. One chain-wide read of Core's swaps, kept
 *  only for Hokori pools (Core's event has no keys to filter by pool). */
export async function readHokoriSwaps(provider: EventSource, core: string, lockers: ReadonlySet<string>, from: number, to: number) {
  if (!lockers.size || from > to) return [];
  const out: ChainEvent[] = [];
  for (let start = from; start <= to; start += SWAP_READ_BLOCKS) {
    const end = Math.min(to, start + SWAP_READ_BLOCKS - 1);
    for (const e of await allEvents(provider, { address: core, keys: [[EVENT.SWAPPED]], from: start, to: end })) if (isHokoriSwap(e, core, lockers)) out.push(e);
  }
  return out;
}

/** One coin's events in blocks `from`..`to`, complete or an error: its curve's trades and graduation, and its pool's
 *  swaps (Core's Swapped events for the coin's pool, whose key names the locker the graduation hands the reserve to,
 *  perhaps in this same range). `pool` is that locker once known. Pool swaps are read over at most the last
 *  `poolWindow` blocks of the range (null: all of it), or taken from `swaps` (Core's Hokori swaps for the range, read
 *  once for many coins). `poolComplete` is false when pool trades in the range were left unread. */
export async function readCoinRange(provider: EventSource, coin: { token: string; curve: string; pool: string | null }, from: number, to: number,
  { core, currency = STRK, swaps, poolWindow = POOL_FALLBACK_BLOCKS }: { core: string; currency?: string; swaps?: ChainEvent[]; poolWindow?: number | null }) {
  const curveEvents = await allEvents(provider, { address: coin.curve, keys: [[EVENT.BUY, EVENT.SELL, EVENT.GRAD]], from, to });
  const grad = curveEvents.find(e => is(e.keys[0], EVENT.GRAD));
  const pool = coin.pool ?? (grad ? graduatedPool(grad) : null);
  const poolStart = grad?.block_number ?? from;
  const poolFrom = poolWindow === null ? poolStart : Math.max(poolStart, to - poolWindow + 1);
  const poolEvents = !pool ? [] : coinSwaps(swaps ?? await readHokoriSwaps(provider, core, new Set([hex(pool)]), poolFrom, to), coin.token, pool, poolFrom, currency);
  return { pool, curveEvents, poolEvents, poolFrom, poolComplete: !pool || poolFrom <= poolStart };
}

/** The swaps among `swaps` in coin `token`'s pool (whose extension is `pool`), from block `from` on. */
// The coin is matched on either side of the pool's key, whatever its currency (the ZEC launchpad, 1 Nov: matching it
// as "the token that isn't STRK" missed a ZEC coin listed second). `currency` is kept for callers; it isn't needed.
export const coinSwaps = (swaps: ChainEvent[], token: string, pool: string, from: number, _currency = STRK) =>
  swaps.filter(e => swappedExtension(e) === hex(pool) && (hex(e.data[1]) === hex(token) || hex(e.data[2]) === hex(token)) && (e.block_number ?? 0) >= from);
/** A pool trade's trader, from a cache txSenders filled. */
export const senderOf = (cache: ReadonlyMap<string, string>, txHash: string) => cache.get(hex(txHash));

/**
 * One coin's trades, kept current by reading only blocks it hasn't read. Each update reads one block range completely
 * and commits it, with its cursor, only if every read succeeded; an update to a head it has already read reads nothing.
 * `adapter`: the privacy adapter pinned to the coin's factory, whose records mark protected trades; `adapters`: every
 * pinned adapter (sdk/src/protected.ts).
 */
export function createTradeLog(provider: EventSource & BlockSource & TxSource, coin: { token: string; curve: string; currency: string; core: string; priceScale?: number;
  adapter?: string | null; adapters?: readonly PrivacyAdapterRef[]; tradeAdapter?: TradeAdapterRef | null }, { concurrency = 8, startBlock = 0 } = {}) {
  const times = new Map<number, number>(), senders = new Map<string, string>();
  let lastBlock = startBlock - 1, pool: string | null = null, trades: Trade[] = [];   // nothing before startBlock is read
  let partial = false;   // pool trades older than the read window, or skipped over a long gap, are missing
  return {
    get trades() { return trades; },
    get lastBlock() { return lastBlock; },
    /** Whether some of the coin's pool trades weren't read (review b37a86c R5): figures needing all of them can't be shown. */
    get partial() { return partial; },
    /** Reads up to `head`. True if any trade was added. */
    async update(head: number): Promise<boolean> {
      if (head <= lastBlock) return false;
      const r = await readCoinRange(provider, { token: coin.token, curve: coin.curve, pool }, lastBlock + 1, head, { core: coin.core, currency: coin.currency });
      const events = [...r.curveEvents.map(e => [e, "curve"] as const), ...r.poolEvents.map(e => [e, "pool"] as const)];
      const pinned = coin.adapter ? (coin.adapters ?? []).filter(a => BigInt(a.address) === BigInt(coin.adapter!)) : [];
      const [, , records, routed] = await Promise.all([
        blockTimes(provider, events.map(([e]) => e.block_number ?? 0), times, { concurrency }),
        txSenders(provider, r.poolEvents.map(e => e.transaction_hash), senders, { concurrency }),
        events.length ? readProtectedRecords(provider, pinned, lastBlock + 1, head) : Promise.resolve([]),
        // Trades routed through the TradeAdapter: its records name the account (routed.ts).
        events.length ? readRoutedRecords(provider, coin.tradeAdapter ?? undefined, lastBlock + 1, head) : Promise.resolve([]),
      ]);
      const attribution = attributeTrades(events.map(([e, venue]) => ({ e, venue, coin: coin.token, adapter: coin.adapter ?? null })), records, coin.adapters);
      const accounts = routedAccounts(events.map(([e, venue]) => ({ e, venue, coin: coin.token })), routed, coin.tradeAdapter ?? undefined);
      const add = events.map(([e, venue], i) => {
        const t = tradeFrom(e, venue, times.get(e.block_number ?? 0) ?? 0, coin.currency, venue === "pool" ? senderOf(senders, e.transaction_hash) : undefined, coin.priceScale ?? 1);
        return t ? withRouted(attributed(t, attribution[i]), accounts[i]) : null;
      }).filter((t): t is Trade => !!t);
      pool = r.pool; lastBlock = head;
      if (!r.poolComplete) partial = true;
      if (add.length) trades = [...trades, ...add].sort((a, b) => a.block - b.block);
      return add.length > 0;
    },
  };
}
