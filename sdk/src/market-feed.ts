/**
 * The live market read straight from the chain, as a store: every coin the factory has launched and every trade
 * since, kept current by polling and reading only what is new. Coins come from the factory's LaunchCreated events;
 * trades from each curve's Buy/Sell and, after graduation, Ekubo Core's Swapped events for its pool, each carrying the
 * price after the trade. Used where there's no market-data service (a page on the devnet), and by the service's
 * verifier; elsewhere the service's published files (data-feed.ts) are lighter.
 *
 * Each poll reads one block range completely (events.ts) into a staging area, and commits it together
 * with the cursor only when every read in it succeeded. A failed poll changes nothing, reads still in flight from it
 * can't touch the store, and the next poll reads the same range again: no trade is counted twice or skipped.
 *
 * Prices need the factory's own settings (start price, supply, curve size), read from the chain before anything else.
 * Until they are, the market isn't ready and shows no figures; the planned settings never price real coins.
 */
import { priceScale, type Currency } from "./currency.ts";
import type { CoinStats, MarketTrade } from "./market-stats.ts";
import { allEvents, type ChainEvent, type EventSource } from "./events.ts";
import {
  EVENT, POOL_FALLBACK_BLOCKS, STRK, blockTimes, coinSwaps, curveTAfter, parseLaunch, poolPrice, readCoinRange, readHokoriSwaps, senderOf,
  tradeFrom, txSenders,
} from "./trades.ts";
import type { CoinMeta } from "./metadata.ts";
import type { PrivacyAdapterRef } from "./networks.ts";
import { adapterFor, attributed, attributeTrades, readProtectedRecords } from "./protected.ts";

export type MarketCoin = {
  token: string; curve: string; creator: string; index: number; name: string; symbol: string;
  metadataUri: string; metadataSha256: bigint; devTokens: bigint; launchFee: bigint;
  launchBlock: number; launchTime: number; pool: string | null; trades: MarketTrade[];
  meta: CoinMeta | null | undefined;   // undefined: not fetched yet
  t: bigint | null;                    // the curve's virtual token reserve after its last trade (for progress)
  stats?: CoinStats; spark?: number[];  // from the market-data service: its figures and recent prices (trades stay empty)
  /** From the service with moderation on: "pending" while a new coin's picture awaits its content check (its file carries
   *  no picture meanwhile), "shown" once decided. Absent with moderation off or from the chain. */
  moderation?: "shown" | "pending";
  /** Reading the chain itself: some of its pool trades weren't read (review b37a86c R5). */
  historyPartial?: boolean;
  /** For such a coin, its pool's current price (currency per token), read from Ekubo Core. */
  poolPrice?: number;
  /** The factory that launched it, and that factory's settings (several factories may be followed; each coin is priced
   *  with its own factory's). Absent from data published before format 6, where `params` applies to every coin. */
  factory?: string;
  params?: MarketParams;
};
/** The factory's settings that market figures are computed from, as read from the chain. `startPrice` is in whole
 *  currency per whole token; `currency` is the factory's (absent: STRK, as before the ZEC launchpad). */
export type MarketParams = { startPrice: number; supply: number; t0: bigint; curveTokens: bigint; currency?: Currency;
  /** Exact factory settings for a service-only page load. Strings retain all 256 bits. Display, never signing authority. */
  display?: { curve: Record<string, string>; supply: string; vault: string; locker: string; core: string; poolFee: string };
};
export type MarketState = {
  coins: MarketCoin[]; recent: { coin: MarketCoin; trade: MarketTrade }[]; params: MarketParams | null;
  ready: boolean;            // a first complete read (settings and events) has been committed
  error: string | null;      // the last poll failed; whatever is shown is from `updatedAt`
  updatedAt: number; revision: number;
};
export type FeedDeps = {
  provider: EventSource & { getBlockNumber(): Promise<number>; getBlockWithTxHashes(block: number): Promise<unknown>; getTransactionByHash(hash: string): Promise<unknown>;
    callContract(call: { contractAddress: string; entrypoint: string; calldata: string[] }): Promise<string[]> };
  /** The launch factory, or (`factories`) every factory followed, oldest first: the newest is the launch factory. */
  factory?: string;
  factories?: string[];
  /** Ekubo Core, whose Swapped events record every pool trade. */
  core: string;
  /** A factory's settings (the figures are computed from its own: start price, supply, curve size). */
  loadParams: (factory: string) => Promise<MarketParams>;
  fetchMeta: (uri: string, sha: bigint) => Promise<{ meta: CoinMeta | null }>;
  /** The network's privacy adapters (networks.ts `privacy`): their records mark protected trades (sdk/src/protected.ts). */
  adapters?: readonly PrivacyAdapterRef[];
};
/** The factories a feed follows, as given: the one, or the list. */
export const feedFactories = (d: { factory?: string; factories?: string[] }): string[] => d.factories ?? (d.factory ? [d.factory] : []);

export const EMPTY_MARKET: MarketState = { coins: [], recent: [], params: null, ready: false, error: null, updatedAt: 0, revision: 0 };

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 120);

/** `startBlock`: the factory's deployment block (nothing before it is read). `poolHistory`: "recent" (a page: the last
 *  POOL_FALLBACK_BLOCKS of pool trades, saying when that leaves some out) or "full" (the verifier: all of them, read
 *  in block ranges). */
export function createMarketFeed(deps: FeedDeps, { pollMs = 4_000, startBlock = 0, poolHistory = "recent" }: { pollMs?: number; startBlock?: number; poolHistory?: "recent" | "full" } = {}) {
  const { provider } = deps;
  const poolWindow = poolHistory === "full" ? null : POOL_FALLBACK_BLOCKS;
  const poolKeys = new Map<string, string[]>();   // a graduated coin's Ekubo pool key, read once from its locker
  /** A pool's current price from Ekubo Core (for a coin whose pool trades are partial). */
  async function currentPoolPrice(coin: MarketCoin) {
    let key = poolKeys.get(coin.token);
    if (!key) { key = await provider.callContract({ contractAddress: coin.pool!, entrypoint: "pool_key", calldata: [coin.token] }); poolKeys.set(coin.token, key); }
    const r = await provider.callContract({ contractAddress: deps.core, entrypoint: "get_pool_price", calldata: key });
    return poolPrice(BigInt(r[0]) + (BigInt(r[1]) << 128n), coin.token, currencyOf(coin)) * priceScale(coin.params?.currency);
  }
  /** A coin's currency (its factory's; STRK when its settings name none): it places the coin in its pool. */
  const currencyOf = (coin: MarketCoin) => coin.params?.currency?.address ?? STRK;
  const factories = feedFactories(deps);
  if (!factories.length) throw new Error("the market feed needs a launch factory");
  const norm = (a: string) => "0x" + BigInt(a).toString(16);
  const coins = new Map<string, MarketCoin>();
  const times = new Map<number, number>();   // block timestamps, a cache; filling it from a failed poll is harmless
  const senders = new Map<string, string>();  // pool trades' transaction senders (their traders), likewise
  let lastBlock = startBlock - 1;
  const params = new Map<string, MarketParams>();   // by factory
  let state: MarketState = EMPTY_MARKET;
  const listeners = new Set<() => void>();

  function publish(patch: Partial<MarketState> = {}) {
    const list = [...coins.values()];
    const recent = list.flatMap(coin => coin.trades.slice(-12).map(trade => ({ coin, trade }))).sort((a, b) => b.trade.block - a.trade.block || b.trade.time - a.trade.time).slice(0, 16);
    // `params`: the launch factory's (the newest); each coin carries its own factory's.
    state = { ...state, coins: list, recent, params: params.get(norm(factories[factories.length - 1])) ?? null, ...patch, revision: state.revision + 1 };
    listeners.forEach(l => l());
  }

  const launchFrom = (e: ChainEvent, factory: string): MarketCoin => {
    const { tx: _tx, ...launch } = parseLaunch(e);
    return { ...launch, factory: norm(factory), params: params.get(norm(factory)), launchTime: 0, pool: null, trades: [], meta: undefined, t: null };
  };

  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      for (const f of factories) if (!params.has(norm(f))) {
        try { params.set(norm(f), await deps.loadParams(f)); }
        catch (e) { throw new Error(`couldn't read the launch factory's settings (${short(e)})`); }
      }
      const latest = await provider.getBlockNumber();
      if (latest <= lastBlock) { publish({ ready: true, error: null, updatedAt: Date.now() }); return; }
      const from = lastBlock + 1;

      // Stage: the range's new coins (each factory's launches), then every coin's events in it. Nothing shared changes
      // until all of it is read.
      const launches = (await Promise.all(factories.map(async f => (await allEvents(provider, { address: f, keys: [[EVENT.LAUNCH]], from, to: latest })).map(e => ({ e, f })))))
        .flat().sort((a, b) => (a.e.block_number ?? 0) - (b.e.block_number ?? 0)).map(({ e, f }) => ({ e, coin: launchFrom(e, f) }));
      const fresh = new Map<string, MarketCoin>();
      for (const { coin: c } of launches) if (!coins.has(c.token) && !fresh.has(c.token)) fresh.set(c.token, c);
      // Each coin's curve events (and so any new graduation), then Core's swaps for all their pools in one read: Core's
      // event can't be filtered by pool, so it's read once (over at most POOL_FALLBACK_BLOCKS, for a page) rather than
      // per coin.
      const curves = await Promise.all([...coins.values(), ...fresh.values()].map(async coin =>
        ({ coin, ...await readCoinRange(provider, coin, Math.max(from, coin.launchBlock), latest, { core: deps.core, swaps: [], poolWindow }) })));
      const lockers = new Set(curves.flatMap(s => (s.pool ? [s.pool] : [])));
      const swaps = await readHokoriSwaps(provider, deps.core, lockers, poolWindow === null ? from : Math.max(from, latest - poolWindow + 1), latest);
      const staged = curves.map(s => ({ ...s, poolEvents: s.pool ? coinSwaps(swaps, s.coin.token, s.pool, s.poolFrom) : [] }));
      const [, , records] = await Promise.all([
        blockTimes(provider, [...launches.map(l => l.e), ...staged.flatMap(s => [...s.curveEvents, ...s.poolEvents])].map(e => e.block_number ?? 0), times),
        txSenders(provider, staged.flatMap(s => s.poolEvents.map(e => e.transaction_hash)), senders),
        staged.some(s => s.curveEvents.length || s.poolEvents.length) ? readProtectedRecords(provider, deps.adapters, from, latest) : Promise.resolve([]),
      ]);
      const time = (e: ChainEvent) => times.get(e.block_number ?? 0) ?? 0;

      // Commit, all at once, with the cursor.
      for (const c of fresh.values()) { c.launchTime = times.get(c.launchBlock) ?? 0; coins.set(c.token, c); }
      for (const { coin, pool, curveEvents, poolEvents, poolComplete } of staged) {
        const add: MarketTrade[] = [];
        // Prices in whole currency per whole token, each coin in its own factory's currency (the ZEC launchpad, 1 Nov).
        const scale = priceScale(coin.params?.currency);
        const adapter = adapterFor(deps.adapters, coin.factory ?? factories[factories.length - 1]);
        const events = [...curveEvents.map(e => ({ e, venue: "curve" as const })), ...poolEvents.map(e => ({ e, venue: "pool" as const }))];
        const attribution = attributeTrades(events.map(x => ({ ...x, coin: coin.token, adapter })), records, deps.adapters);
        events.forEach(({ e, venue }, i) => {
          const t = tradeFrom(e, venue, time(e), currencyOf(coin), venue === "pool" ? senderOf(senders, e.transaction_hash) : undefined, scale);
          if (!t) return;
          add.push(attributed(t, attribution[i]));
          if (venue === "curve") coin.t = curveTAfter(e);
        });
        coin.pool = pool;
        if (!poolComplete) coin.historyPartial = true;
        if (add.length) coin.trades = [...coin.trades, ...add].sort((a, b) => a.block - b.block);
      }
      lastBlock = latest;
      // A coin missing some pool trades gets its current price from its pool, so its market cap isn't a stale trade's.
      await Promise.all([...coins.values()].filter(c => c.historyPartial && c.pool).map(async c => {
        try { c.poolPrice = await currentPoolPrice(c); } catch { /* kept from the last poll */ }
      }));
      publish({ ready: true, error: null, updatedAt: Date.now() });
      for (const c of fresh.values()) {
        void deps.fetchMeta(c.metadataUri, c.metadataSha256).then(r => { c.meta = r.meta; }, () => { c.meta = null; }).then(() => publish());
      }
    } catch (e) {
      publish({ error: `Couldn't read the market: ${short(e)}` });
    } finally { polling = false; }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  function subscribe(listener: () => void) {
    listeners.add(listener);
    if (!timer) { void poll(); timer = setInterval(() => void poll(), pollMs); }
    return () => { listeners.delete(listener); if (!listeners.size && timer) { clearInterval(timer); timer = null; } };
  }

  return { poll, subscribe, getState: () => state };
}
