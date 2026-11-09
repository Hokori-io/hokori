/**
 * Reading the market-data service's published files: the whole market, one coin's
 * trades, chart, state and holders, instead of reading the chain. Display only: quotes and everything that's signed
 * still read the chain.
 *
 * Freshness is judged here, because a service that's down can't say so: if `updatedAt` doesn't move for a minute
 * while we keep reading, or the first file read is already more than five minutes old, or the files can't be read,
 * the market shows as delayed (the last data stays on screen). Comparing a server's time with this computer's clock
 * only for the generous first check keeps a wrong clock from causing false alarms.
 */
import { currencyFromJson } from "./currency.ts";
import type { MarketCoin, MarketParams, MarketState } from "./market-feed.ts";
import type { Trade } from "./trades.ts";
import { stateFromJson, type PublishedState } from "./coin-state.ts";
import { holdersFromJson, type PublishedHolders } from "./holders.ts";
import { candleOf, MINUTE, type Candle } from "./candles.ts";
import { legacyAttribution } from "./protected.ts";
import type { PrivacyAdapterRef } from "./networks.ts";

export const STALE_MS = 60_000, FIRST_LOAD_STALE_MS = 300_000;
/** A sealed history piece's name (indexer/history.ts). */
const PIECE = /^[0-9a-f]{16}$/;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const same = (a: string, b: string) => { try { return BigInt(a) === BigInt(b); } catch { return false; } };
const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 120);
/** A published trade; one from a service on older code, made by a privacy adapter, is shown as protected. */
const tradeOf = (t: Json, adapters?: readonly PrivacyAdapterRef[]): Trade => legacyAttribution({ ...t, tokens: BigInt(t.tokens), currency: BigInt(t.currency) } as Trade, adapters);
const paramsOf = (p: Json): MarketParams => {
  // None named: STRK, as before. One named but refused (malformed, or a known token published wrong) refuses the update:
  // dropping it would show the factory's coins as STRK ones, 10^10 off for a ZEC coin.
  const currency = p.currency === undefined ? null : currencyFromJson(p.currency);
  if (p.currency !== undefined && !currency) throw new Error("the market data names an invalid currency");
  return { startPrice: p.startPrice, supply: p.supply, t0: BigInt(p.t0), curveTokens: BigInt(p.curveTokens), ...(currency ? { currency } : {}) };
};
const norm = (a: string) => "0x" + BigInt(a).toString(16);
/** A published coin; `byFactory` (format 6) gives each coin its own factory's settings. */
const coinOf = (c: Json, byFactory?: Json): MarketCoin => ({
  token: c.token, curve: c.curve, creator: c.creator, index: c.index, name: c.name, symbol: c.symbol,
  metadataUri: c.metadataUri, metadataSha256: BigInt(c.metadataSha256), devTokens: BigInt(c.devTokens), launchFee: BigInt(c.launchFee),
  launchBlock: c.launchBlock, launchTime: c.launchTime, pool: c.pool, trades: [], meta: c.meta ?? null,
  t: c.curveT === null ? null : BigInt(c.curveT), stats: c.stats, spark: c.spark,
  ...(c.moderation === "pending" || c.moderation === "shown" ? { moderation: c.moderation } : {}),
  ...(typeof c.factory === "string" ? { factory: norm(c.factory), ...(byFactory?.[norm(c.factory)] ? { params: paramsOf(byFactory[norm(c.factory)]) } : {}) } : {}),
});

/**
 * How a reader matches the launchpads a market-data service follows.
 * - "includes" (the default): the service follows at least the reader's factories, and coins of any other factory are
 *   left out. A reader keeps working the day the service follows a new launchpad (otherwise every
 *   bot on an older SDK would have the market data refused).
 * - "exact": the service follows exactly the reader's factories (the hokori.io site's rule).
 */
export type FactoryMatch = "includes" | "exact";
type FollowedFactories = { factory?: string; factories?: string[]; match?: FactoryMatch };
const followed = (o: FollowedFactories) => o.factories ?? (o.factory ? [o.factory] : []);

/** Whether published files are for the factories a reader follows (`factories`, format 6; a service from before
 *  names one `factory`), under the reader's `match`. Either way the service's own launch factory must be one it names:
 *  a forged `factory` is refused. A reader following nothing in particular accepts any service. */
export function acceptsFactories(j: { factory?: string; factories?: string[] }, o: FollowedFactories): boolean {
  const want = followed(o);
  if (!want.length) return true;
  const have = Array.isArray(j.factories) ? j.factories.filter(h => typeof h === "string") : typeof j.factory === "string" ? [j.factory] : [];
  const covers = want.every(w => have.some(h => same(h, w)));
  if ((o.match ?? "includes") === "exact") {
    const sameSet = have.length === want.length && covers;
    return sameSet && (typeof j.factory !== "string" || want.some(w => same(w, j.factory!)));
  }
  return covers && (typeof j.factory !== "string" || have.some(h => same(h, j.factory!)));
}

/** Whether a published coin belongs to the factories a reader follows (any coin for a reader following nothing in
 *  particular, and a coin published without its factory, from a service before format 6, which named one factory). */
export function followsCoin(c: { factory?: string }, o: FollowedFactories): boolean {
  const want = followed(o);
  return !want.length || c.factory === undefined || want.some(w => same(w, c.factory!));
}

/** Tells fresh data from data that has stopped moving. A value that arrives already old (more than five minutes by
 *  this computer's clock) is delayed, and stays delayed on repeated reads until a newer value arrives (review 5325953,
 *  N7); otherwise a value that hasn't moved for a minute of reading is delayed. */
export function freshness(now: () => number = Date.now) {
  let last: number | null = null, seenAt = 0, arrivedOld = false;
  return (updatedAt: number): "fresh" | "delayed" => {
    const t = now();
    if (updatedAt !== last) {
      last = updatedAt; seenAt = t;
      arrivedOld = t - updatedAt > FIRST_LOAD_STALE_MS;
    }
    return arrivedOld || t - seenAt > STALE_MS ? "delayed" : "fresh";
  };
}

/** How long a read of the published files may take before it counts as failed. */
export const DATA_TIMEOUT_MS = 10_000;

const EMPTY: MarketState = { coins: [], recent: [], params: null, ready: false, error: null, updatedAt: 0, revision: 0 };

/** Where a browser keeps its last copy of market.json between visits (the site passes localStorage, wrapped so a
 *  blocked or full storage is simply no copy). Both calls may throw or return nothing; the feed copes. */
export type MarketCache = { load(): string | null; save(text: string): void };
/** A saved copy older than this is not shown: a coin hidden since then would otherwise show until the first read. */
export const SAVED_MAX_AGE_MS = 10 * 60_000;
/** The copy is rewritten at most this often (market.json changes every few seconds; the copy only has to be recent). */
export const SAVE_EVERY_MS = 30_000;
/** How often the whole coin list is read even while market-live.json is in use: figures that drift with time alone
 *  (a 24-hour volume as trades age) come with it. */
export const LIVE_FULL_EVERY_MS = 30_000;
/** A market.json larger than this is not saved (browser storage is a few megabytes, shared with everything else). */
export const SAVE_MAX_CHARS = 2_000_000;

/** The landing page's market, from `<url>/market.json`, as the same store the chain feed is. With a `cache`, the
 *  browser's last copy (when it is for this service, network and factories, and under ten minutes old) is shown at
 *  once and the first read replaces it, so a refresh or a return visit never starts empty; the copy is refreshed at
 *  most every 30 seconds. The first read asks the browser's cache as normal, so it takes the response the page
 *  started early (`<link rel="preload" as="fetch">`, components/market/market-preload.tsx); later reads revalidate. */
export function createDataFeed(o: { url: string; factory?: string; factories?: string[]; match?: FactoryMatch; chainId: string; fetcher?: typeof fetch; now?: () => number; cache?: MarketCache;
  hidden?: () => boolean; adapters?: readonly PrivacyAdapterRef[] }, { pollMs = 3_000 } = {}) {
  const fetcher = o.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = o.now ?? Date.now;
  const fresh = freshness(o.now);
  let state: MarketState = EMPTY;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<MarketState>) => { state = { ...state, ...patch, revision: state.revision + 1 }; listeners.forEach(l => l()); };
  const show = (j: Json, error: string | null) => {
    const coins = (j.coins as Json[]).map(c => coinOf(c, j.paramsByFactory)).filter(c => followsCoin(c, o)), byToken = new Map(coins.map(c => [c.token, c]));
    const recent = (j.recent as Json[]).flatMap(x => (byToken.has(x.token) ? [{ coin: byToken.get(x.token)!, trade: tradeOf(x.trade, o.adapters) }] : []));
    publish({ coins, recent,
      params: paramsOf(j.params), ready: true, updatedAt: j.updatedAt, error });
  };
  const accepted = (j: Json) => acceptsFactories(j, o) && same(j.chainId, o.chainId);

  // The browser's last copy, shown before the first read. Anything odd about it (another service or network, too
  // old, unreadable) and it is simply not shown.
  // The publication of the last full list shown (market.json, or the saved copy of one): a full list of that same
  // publication still completes rows a merge of market-live.json didn't carry.
  let savedAt = 0, fullRevision = -Infinity;
  try {
    const saved = JSON.parse(o.cache?.load() ?? "null") as { v?: number; url?: string; chainId?: string; at?: number; text?: string } | null;
    const age = saved && typeof saved.at === "number" ? now() - saved.at : NaN;
    if (saved?.v === 1 && saved.url === o.url && typeof saved.chainId === "string" && same(saved.chainId, o.chainId) && typeof saved.text === "string" && age >= 0 && age <= SAVED_MAX_AGE_MS) {
      const j = JSON.parse(saved.text) as Json;
      if (accepted(j) && Array.isArray(j.coins) && Array.isArray(j.recent)) { show(j, null); savedAt = saved.at!; fullRevision = j.updatedAt; }
    }
  } catch { /* no usable copy */ }
  const save = (text: string) => {
    if (!o.cache || text.length > SAVE_MAX_CHARS || now() - savedAt < SAVE_EVERY_MS) return;
    savedAt = now();
    try { o.cache.save(JSON.stringify({ v: 1, url: o.url, chainId: o.chainId, at: savedAt, text })); } catch { /* storage full or blocked */ }
  };

  let polling = false, reads = 0, fullAt = -Infinity, liveMissing = false;
  /** market.json: every coin. The first read asks the browser's cache as normal (it takes the page's early request). */
  async function readFull() {
    const r = await fetcher(`${o.url}/market.json`, { cache: reads++ === 0 ? "default" : "no-cache", signal: AbortSignal.timeout(DATA_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`the market data answered ${r.status}`);
    const text = await r.text();
    const j = JSON.parse(text) as Json;
    if (!accepted(j)) throw new Error("the market data is for a different launch factory or network");
    // Never backwards: market.json and market-live.json are cached separately, and a
    // first read can come from the browser's cache, so a full list older than what is shown is not applied, and is not
    // a full read: the next poll reads market.json again.
    if (j.updatedAt < state.updatedAt) return;
    fullAt = now();
    const delayed = fresh(j.updatedAt) === "delayed", error = delayed ? "The market data is delayed" : null;
    // Newer, or the publication already shown but from market-live.json, whose rows carry only the coins that changed:
    // the full list completes them (a 24-hour volume that moved with time alone).
    if (j.updatedAt > state.updatedAt || j.updatedAt !== fullRevision) {
      show(j, error); fullRevision = j.updatedAt;
      if (!delayed) save(text);
    } else if (state.error !== error) publish({ error });
  }
  /** market-live.json: the coins changed since its `since`, merged into the coins held. False when it can't be used
   *  (a service without it, or data held from before its window) and market.json is read instead. */
  async function readLive(): Promise<boolean> {
    const r = await fetcher(`${o.url}/market-live.json`, { cache: "no-cache", signal: AbortSignal.timeout(DATA_TIMEOUT_MS) });
    if (r.status === 404) { await r.body?.cancel().catch(() => {}); liveMissing = true; return false; }
    if (!r.ok) throw new Error(`the market data answered ${r.status}`);
    const j = await r.json() as Json;
    if (!accepted(j)) throw new Error("the market data is for a different launch factory or network");
    if (j.live !== 1 || typeof j.since !== "number" || !Array.isArray(j.changed) || !Array.isArray(j.gone) || !Array.isArray(j.recent)) return false;
    if (state.updatedAt < j.since) return false;
    const delayed = fresh(j.updatedAt) === "delayed", error = delayed ? "The market data is delayed" : null;
    if (j.updatedAt > state.updatedAt) {
      const byToken = new Map(state.coins.map(c => [c.token, c]));
      for (const token of j.gone as unknown[]) if (typeof token === "string") byToken.delete(token);
      for (const row of j.changed as Json[]) { const c = coinOf(row, j.paramsByFactory); if (followsCoin(c, o)) byToken.set(c.token, c); }
      const recent = (j.recent as Json[]).flatMap(x => (byToken.has(x.token) ? [{ coin: byToken.get(x.token)!, trade: tradeOf(x.trade, o.adapters) }] : []));
      publish({ coins: [...byToken.values()], recent,
        params: paramsOf(j.params), ready: true, updatedAt: j.updatedAt, error });
    } else if (state.error !== error) publish({ error });
    return true;
  }
  /** Between full reads (every LIVE_FULL_EVERY_MS) only market-live.json is read: a few kilobytes, whatever the
   *  number of coins. A service without it is read in full every time, as before. */
  async function poll() {
    // A hidden tab reads nothing; the page calls poll() again when the tab is shown (lib/page-visibility.ts).
    if (polling || o.hidden?.()) return;
    polling = true;
    try {
      const full = reads === 0 || !state.ready || liveMissing || now() - fullAt >= LIVE_FULL_EVERY_MS;
      if (full || !(await readLive())) await readFull();
    } catch (e) {
      publish({ error: `Couldn't read the market data (${short(e)})` });
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

/** How many sealed pieces of a coin's history are read at once. */
export const PIECE_READS = 6;
/** `read` over `items`, `limit` at a time, in order; the first failure stops the rest and is thrown. */
async function readLimited<T, R>(items: T[], limit: number, read: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0, failed = false;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try { out[i] = await read(items[i]); } catch (e) { failed = true; throw e; }
    }
  }));
  return out;
}

/** Thrown when a coin's published file can't be used (not published yet, or stale): the production page retains its last display and backs off. */
export class PublishedUnavailable extends Error {}
/** The service is up to date but has no file for this coin: a coin it hasn't reached yet, or no coin at all. */
export class NotPublished extends PublishedUnavailable {}
/** The market-data service hides this coin: its file is a stub with a note, which is the
 *  message. Not a PublishedUnavailable: nothing to wait for, and the chain isn't read instead. */
export class PublishedHidden extends Error {}

/** Everything that identifies a trade and what it showed: two lists of trades are the same only if these all match. */
const tradeKey = (t: Trade) => [t.block, t.tx, t.venue, t.side, t.trader, t.tokens, t.currency, t.priceAfter, t.time, t.attribution ?? "account"].join("|");
export const sameTrades = (a: Trade[], b: Trade[]) => a.length === b.length && a.every((t, i) => tradeKey(t) === tradeKey(b[i]));

/** A coin page's trades and chart from `<url>/coins/<token>.json`, with the trade log's shape (sdk/src/trades.ts).
 *  A coin's file is rewritten only when the coin changes, so freshness comes from `status.json`, which the service
 *  rewrites every cycle; the coin's file is read only when the index has moved past what this page has.
 *  The two files can be cached separately, so a newer status.json can come with an older coin file. A coin file
 *  published before the one this page holds (by its `updatedAt`, which the service keeps increasing) is ignored and
 *  read again next time, so the page never steps back to older trades (review d7b4264, R3).
 *  The file also carries the coin's curve and pool state (`coinState`), which the page uses instead of re-reading
 *  the chain (lib/starknet/coin-follow.ts); `state` is undefined for a service from before it was published.
 *  Since format 4 the file carries only the coin's last trades and newest minute candles; its older candles are in
 *  sealed pieces (indexer/history.ts), read once each and kept, so a long history costs nothing per poll. `candles` is
 *  null for an older service, whose file has every trade: the page builds the candles from those.
 *  Older history that can't be read (a piece failing or missing) never hides the coin: its trades
 *  and state are taken, the chart keeps the candles it had (on a first read, the newest minutes from the coin's file),
 *  `historyBehind` says so, and the history is read again on the next update, from the pieces not held yet. Pieces
 *  are read PIECE_READS at a time, and a failure stops the rest. */
export function createPublishedTrades(o: { url: string; token: string; factory?: string; factories?: string[]; match?: FactoryMatch; chainId?: string; fetcher?: typeof fetch; now?: () => number;
  timeoutMs?: number; adapters?: readonly PrivacyAdapterRef[] }) {
  const fetcher = o.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const fresh = freshness(o.now);
  let trades: Trade[] = [], lastBlock = -1, publishedAt = -Infinity;
  let state: PublishedState | undefined, stateText = "";
  let holders: PublishedHolders | undefined, holdersText = "";
  let document: Json | undefined, statusAt = -Infinity;
  // The minute candles: the sealed pages held (by name) and the index naming them, then the file's tail.
  let candles: Candle[] | null = null, index: string | null | undefined, pages = new Map<string, Candle[]>(), sealed: Candle[] = [], tailText = "";
  let historyBehind = false;
  let fileBlock = -1;   // the last block the coin's own file covers (its header), for a page's own-trade display
  // Sealed pieces never change, so each one read and checked is kept, even when the rest of a read fails; `pages` is
  // then cut back to the pieces the index names once the whole history is taken.
  const indexes = new Map<string, string[]>();
  const identity = (j: Json) => {
    if (!acceptsFactories(j, o) || (o.chainId && !same(j.chainId, o.chainId)))
      throw new PublishedUnavailable("the market data is for a different launch factory or network");
  };
  // The first read of each file asks the browser's cache as normal, so it takes the response the coin's page started
  // early (`<link rel="preload" as="fetch">`, components/crosschain/coin-preload.tsx); later reads revalidate.
  const readBefore = new Set<string>();
  const read = async (path: string) => {
    const first = !readBefore.has(path); readBefore.add(path);
    const r = await fetcher(`${o.url}/${path}`, { cache: first ? "default" : "no-cache", signal: AbortSignal.timeout(o.timeoutMs ?? DATA_TIMEOUT_MS) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`the market data answered ${r.status}`);
    return await r.json() as Json;
  };
  /** A sealed piece of the coin's history. Missing only if the service replaced it after the coin's file was read:
   *  the next read starts again from the new file. */
  const piece = async (name: unknown, kind: string) => {
    if (typeof name !== "string" || !PIECE.test(name)) throw new PublishedUnavailable("invalid market data");
    const j = await read(`coins/${o.token}/${name}.json`);
    if (!j) throw new PublishedUnavailable("the coin's history moved on; reading it again");
    if (j.kind !== kind) throw new PublishedUnavailable("invalid market data");
    return j;
  };
  const indexPiece = async (name: string) => {
    const held = indexes.get(name);
    if (held) return held;
    const names: unknown = (await piece(name, "candle-index")).pages;
    if (!Array.isArray(names) || !names.every(n => typeof n === "string" && PIECE.test(n))) throw new PublishedUnavailable("invalid market data");
    indexes.clear(); indexes.set(name, names as string[]);
    return names as string[];
  };
  const reading = new Map<string, Promise<Candle[]>>();   // pieces being read: a retry joins them rather than asking twice
  const candlePiece = (name: string): Promise<Candle[]> => {
    const held = pages.get(name);
    if (held) return Promise.resolve(held);
    let p = reading.get(name);
    if (!p) {
      p = (async () => {
        const rows: unknown = (await piece(name, "candles")).candles;
        if (!Array.isArray(rows)) throw new PublishedUnavailable("invalid market data");
        const got = rows.map(candleOf);
        pages.set(name, got);
        return got;
      })().finally(() => reading.delete(name));
      reading.set(name, p);
    }
    return p;
  };
  return {
    get trades() { return trades; },
    /** The coin's minute candles, oldest first, in STRK per token (a new array only when they changed); null if the
     *  service doesn't publish them. */
    get candles() { return candles; },
    /** The complete validated publication, for service-only first loads. Never signing authority. */
    get document() { return document; },
    /** The coin's latest published state (a new object only when it changed); undefined if the service doesn't
     *  publish states. */
    get state() { return state; },
    /** The last block the published trades are complete to. */
    get lastBlock() { return lastBlock; },
    /** The last block the coin's own file covers (its header's indexedBlock; -1 when it doesn't say): its candles
     *  include every trade up to it, while its trade list holds only the latest few. status.json can be newer than
     *  the file read with it, so this, not lastBlock, says whether a given trade is in the file. */
    get fileBlock() { return fileBlock; },
    /** The coin's holders (count and top holders, sdk/src/holders.ts; a new object only when they changed):
     *  undefined from a service from before format 5, or when the file's holders can't be used. Holders that can't
     *  be used never hide the coin's trades or state. */
    get holders() { return holders; },
    /** True while the coin's older chart history couldn't be read: `candles` is then an older (or, on a first read, the
     *  most recent) coherent part, and the next update tries again. */
    get historyBehind() { return historyBehind; },
    /** Reads what's new. True if the trades or the candles changed in any way: added, removed or replaced (a
     *  corrected history can keep the same number of trades; review d7b4264, R1). Throws PublishedUnavailable whenever
     *  the published data can't be used, for any reason (missing, stale, an HTTP error, no connection, a bad file or a
     *  timeout; review 5325953, N6), and then keeps what it had: the page decides its retry policy. */
    async update(_head: number): Promise<boolean> {
      try {
        const status = await read("status.json");
        if (!status) throw new PublishedUnavailable("the market data has no status");
        identity(status);
        // Freshness by the last complete publication, not the service's heartbeat (a failing service still writes
        // status.json; review 5325953, N7).
        if (typeof status.lastSuccessAt !== "number" || fresh(status.lastSuccessAt) === "delayed") throw new PublishedUnavailable("the market data is delayed");
        if (!Number.isSafeInteger(status.indexedBlock) || status.indexedBlock < 0) throw new PublishedUnavailable("invalid market data block");
        if (status.indexedBlock === lastBlock && status.lastSuccessAt === statusAt && !historyBehind) return false;
        const j = await read(`coins/${o.token}.json`);
        if (!j) throw new NotPublished("this coin isn't in the market data yet");
        identity(j);
        if (j.hidden === true) throw new PublishedHidden(typeof j.note === "string" && j.note ? j.note : "This coin isn't shown on Hokori.");
        if ((o.factory || o.chainId) && !same(j.coin?.token, o.token)) throw new PublishedUnavailable("the market data is for another coin");
        if (typeof j.updatedAt !== "number") throw new PublishedUnavailable("the coin's file has no publication time");
        if (j.updatedAt < publishedAt) return false;   // an older publication than the one held: read again next time
        const next = (j.trades as Json[]).map(t => tradeOf(t, o.adapters)), tradesChanged = !sameTrades(next, trades);
        const nextStateText = j.coinState === undefined ? "" : JSON.stringify(j.coinState);
        if (j.coinState !== undefined && !Number.isSafeInteger(j.coinState.atBlock)) throw new PublishedUnavailable("the coin's state has no block");
        const nextState = nextStateText === stateText ? state
          : j.coinState === undefined ? undefined : { ...stateFromJson(j.coinState), atBlock: j.coinState.atBlock as number };
        // The candles: sealed pages only when the index changed (and only those not held already), then the tail.
        let nextCandles = candles, nextIndex = index, nextPages = pages, nextSealed = sealed, nextTail = tailText, behind = false;
        if (j.candles === undefined) nextCandles = null;
        else {
          const h = j.candles as Json;
          if (h.interval !== MINUTE || !Array.isArray(h.tail) || (h.index !== null && typeof h.index !== "string")) throw new PublishedUnavailable("invalid market data");
          const tail = (h.tail as unknown[]).map(candleOf);
          const ordered = (list: Candle[]) => { if (list.some((c, i) => i > 0 && c.time <= list[i - 1].time)) throw new PublishedUnavailable("invalid market data"); return list; };
          if (h.index !== index) {
            try {
              const names = h.index === null ? [] : await indexPiece(h.index);
              const got = await readLimited(names, PIECE_READS, candlePiece);
              nextPages = new Map(names.map((n, i) => [n, got[i]]));
              nextSealed = got.flat(); nextIndex = h.index;
            } catch { behind = true; }
          }
          if (!behind) {
            nextTail = JSON.stringify(h.tail);
            if (candles === null || nextIndex !== index || nextTail !== tailText) nextCandles = ordered(nextSealed.concat(tail));
          } else if (candles === null) nextCandles = ordered(tail);   // a first read: the newest minutes, until the rest is read
        }
        const changed = tradesChanged || nextCandles !== candles;
        // Everything read and checked: take it all at once.
        if (tradesChanged) trades = next;
        state = nextState; stateText = nextStateText;
        const nextHoldersText = j.holders === undefined ? "" : JSON.stringify(j.holders);
        if (nextHoldersText !== holdersText) { holders = holdersFromJson(j.holders); holdersText = nextHoldersText; }
        candles = nextCandles; index = nextIndex; pages = nextPages; sealed = nextSealed; tailText = nextTail; historyBehind = behind;
        publishedAt = j.updatedAt;
        fileBlock = Number.isSafeInteger(j.indexedBlock) ? j.indexedBlock as number : -1;
        document = j; statusAt = status.lastSuccessAt;
        lastBlock = status.indexedBlock;   // the service writes coin files before status.json, so the file is complete to here
        return changed;
      } catch (e) {
        throw e instanceof PublishedUnavailable || e instanceof PublishedHidden ? e : new PublishedUnavailable(`the market data couldn't be read (${short(e)})`);
      }
    },
  };
}
