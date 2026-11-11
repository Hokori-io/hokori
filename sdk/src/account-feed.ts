/**
 * A wallet's coins and trades, from the market-data service's `accounts/<address>.json`: what it holds
 * of each Hokori coin, from the coins' transfers (holders.ts), and its last trades across coins. Display only, like
 * everything the service publishes.
 *
 * Freshness is judged as for coin pages (data-feed.ts): by `status.json`'s last complete publication. The account's file
 * is read only when the index has moved. An account the service has no file for, while its data is fresh, holds no
 * coin and never traded one: `found` is false and the lists are empty. Anything that can't be used (missing, stale, an
 * HTTP error, a bad file, a timeout) throws PublishedUnavailable and keeps what was last read.
 */
import { DATA_TIMEOUT_MS, PublishedUnavailable, acceptsFactories, followsFactory, freshness, servedBeyond, type FactoryMatch } from "./data-feed.ts";
import { STRK_CURRENCY, currencyFromJson, type Currency } from "./currency.ts";
import type { Trade } from "./trades.ts";

export type AccountHolding = { token: string; balance: bigint; symbol: string; name: string };
export type AccountTrade = Trade & { token: string };
/** What the account paid for a coin and got back from it, over every trade (for its profit and loss). */
/** `transferredIn` / `transferredOut`: the coins that came in or left other than by trading (gross: a lot sent away and
 *  another received both count); `transferred` is their net, the balance against the trades' net tokens. A position with
 *  either movement has no complete cost basis, so no profit or loss is shown. */
export type AccountPosition = { token: string; bought: bigint; sold: bigint; tokensBought: bigint; tokensSold: bigint; buys: number; sells: number; transferred: bigint; transferredIn: bigint; transferredOut: bigint };
/** A coin the account launched (a hidden one keeps its address and no name). */
export type AccountLaunch = { token: string; name: string; symbol: string; launchTime: number; graduated: boolean };
/** A coin whose trading fees the account receives a share of (its vault's payee list): the share in basis points and
 *  how many recipients the coin has (a hidden one keeps its address and no name). */
export type AccountPayee = { token: string; name: string; symbol: string; launchTime: number; shareBps: number; payees: number };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ADDRESS = /^0x[0-9a-f]{64}$/, AMOUNT = /^[0-9]{1,78}$/;
const canon = (a: string) => "0x" + BigInt(a).toString(16).padStart(64, "0");
const same = (a: unknown, b: string) => { try { return BigInt(a as string) === BigInt(b); } catch { return false; } };

/** The file's currencies (the ZEC launchpad, 1 Nov): per coin not trading in STRK, its currency; none from files before,
 *  or for an account with only STRK coins. One that can't be used refuses the file (an amount read in the wrong
 *  decimals is off by 10^10). */
function currenciesOf(v: unknown): Record<string, Currency> {
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new PublishedUnavailable("invalid account data");
  const out: Record<string, Currency> = {};
  for (const [token, c] of Object.entries(v)) {
    const currency = ADDRESS.test(token) ? currencyFromJson(c) : null;
    if (!currency) throw new PublishedUnavailable("invalid account data");
    out[canon(token)] = currency;
  }
  return out;
}
/** A coin's currency in an account's file: the one it names, else STRK. */
export const accountCurrency = (currencies: Readonly<Record<string, Currency>>, token: string): Currency => currencies[canon(token)] ?? STRK_CURRENCY;

function holdingOf(h: Json): AccountHolding {
  if (!h || typeof h.token !== "string" || !ADDRESS.test(h.token) || typeof h.balance !== "string" || !AMOUNT.test(h.balance) || BigInt(h.balance) <= 0n
    || typeof h.symbol !== "string" || typeof h.name !== "string") throw new PublishedUnavailable("invalid account data");
  return { token: h.token, balance: BigInt(h.balance), symbol: h.symbol.slice(0, 32), name: h.name.slice(0, 64) };
}
function tradeOf(t: Json, account: string): AccountTrade {
  if (!t || typeof t.token !== "string" || !ADDRESS.test(t.token) || typeof t.tx !== "string" || !["curve", "pool"].includes(t.venue) || !["buy", "sell"].includes(t.side)
    || !Number.isSafeInteger(t.block) || !Number.isSafeInteger(t.time) || typeof t.tokens !== "string" || !AMOUNT.test(t.tokens)
    || typeof t.currency !== "string" || !AMOUNT.test(t.currency) || typeof t.priceAfter !== "number" || !same(t.trader, account))
    throw new PublishedUnavailable("invalid account data");
  return { token: t.token, time: t.time, block: t.block, tx: t.tx, venue: t.venue, side: t.side, trader: canon(t.trader), tokens: BigInt(t.tokens), currency: BigInt(t.currency), priceAfter: t.priceAfter };
}

const SIGNED_AMOUNT = /^-?[0-9]{1,78}$/;
function positionOf(p: Json): AccountPosition {
  if (!p || typeof p.token !== "string" || !ADDRESS.test(p.token) || ![p.bought, p.sold, p.tokensBought, p.tokensSold].every(v => typeof v === "string" && AMOUNT.test(v))
    || !Number.isSafeInteger(p.buys) || !Number.isSafeInteger(p.sells) || p.buys < 0 || p.sells < 0
    || (p.transferred !== undefined && !(typeof p.transferred === "string" && SIGNED_AMOUNT.test(p.transferred)))
    || [p.transferredIn, p.transferredOut].some(v => v !== undefined && !(typeof v === "string" && AMOUNT.test(v)))) throw new PublishedUnavailable("invalid account data");
  const net = p.transferred === undefined ? 0n : BigInt(p.transferred);
  // A file from before the gross fields (18 Oct) has only the net: read it as the movement it implies.
  const transferredIn = p.transferredIn === undefined ? (net > 0n ? net : 0n) : BigInt(p.transferredIn);
  const transferredOut = p.transferredOut === undefined ? (net < 0n ? -net : 0n) : BigInt(p.transferredOut);
  return { token: p.token, bought: BigInt(p.bought), sold: BigInt(p.sold), tokensBought: BigInt(p.tokensBought), tokensSold: BigInt(p.tokensSold), buys: p.buys, sells: p.sells, transferred: net, transferredIn, transferredOut };
}
function launchOf(l: Json): AccountLaunch {
  if (!l || typeof l.token !== "string" || !ADDRESS.test(l.token) || typeof l.name !== "string" || typeof l.symbol !== "string" || !Number.isSafeInteger(l.launchTime) || typeof l.graduated !== "boolean")
    throw new PublishedUnavailable("invalid account data");
  return { token: l.token, name: l.name.slice(0, 64), symbol: l.symbol.slice(0, 32), launchTime: l.launchTime, graduated: l.graduated };
}

function payeeOf(p: Json): AccountPayee {
  if (!p || typeof p.token !== "string" || !ADDRESS.test(p.token) || typeof p.name !== "string" || typeof p.symbol !== "string" || !Number.isSafeInteger(p.launchTime)
    || !Number.isSafeInteger(p.shareBps) || p.shareBps < 1 || p.shareBps > 10_000 || !Number.isSafeInteger(p.payees) || p.payees < 1 || p.payees > 10)
    throw new PublishedUnavailable("invalid account data");
  return { token: p.token, name: p.name.slice(0, 64), symbol: p.symbol.slice(0, 32), launchTime: p.launchTime, shareBps: p.shareBps, payees: p.payees };
}

/**
 * Which of an account file's coins a reader keeps: every one when the service follows only launch
 * factories the reader follows (no other launchpad's coin can be in it); otherwise those the file's `coinFactories` map
 * gives a followed factory. A file that would need the map and has none can't be scoped: refused.
 */
function accountScope(j: Json, o: { factory?: string; factories?: string[]; match?: FactoryMatch }): ((token: string) => boolean) | null {
  if (!servedBeyond(j, o)) return null;
  const map = j.coinFactories;
  if (!map || typeof map !== "object" || Array.isArray(map))
    throw new PublishedUnavailable("the market data follows launch factories this reader doesn't, and doesn't say which of the account's coins are whose");
  const factoryOf = new Map<string, unknown>();
  for (const [token, factory] of Object.entries(map as Record<string, unknown>)) { try { factoryOf.set(canon(token), factory); } catch { /* not an address */ } }
  return token => followsFactory(factoryOf.get(canon(token)), o);
}

export function createPublishedAccount(o: { url: string; address: string; factory?: string; factories?: string[]; match?: FactoryMatch; chainId?: string; fetcher?: typeof fetch; now?: () => number;
  timeoutMs?: number }) {
  const fetcher = o.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const fresh = freshness(o.now);
  const address = canon(o.address);
  let holdings: AccountHolding[] = [], trades: AccountTrade[] = [], positions: AccountPosition[] = [], launched: AccountLaunch[] = [], payees: AccountPayee[] = [], tradeCount = 0, found = false, atBlock = -1, statusAt = -Infinity, publishedAt = -Infinity;
  let currencies: Record<string, Currency> = {};
  const read = async (path: string) => {
    const r = await fetcher(`${o.url}/${path}`, { cache: "no-cache", signal: AbortSignal.timeout(o.timeoutMs ?? DATA_TIMEOUT_MS) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`the market data answered ${r.status}`);
    return await r.json() as Json;
  };
  const identity = (j: Json) => {
    if (!acceptsFactories(j, o) || (o.chainId && !same(j.chainId, o.chainId)))
      throw new PublishedUnavailable("the market data is for a different launch factory or network");
  };
  return {
    get address() { return address; },
    /** The account's balances of Hokori coins, largest first (new arrays only when something changed). */
    get holdings() { return holdings; },
    /** Its last trades across coins, oldest first (at most 500; `tradeCount` has them all). */
    get trades() { return trades; },
    get tradeCount() { return tradeCount; },
    /** Per coin, over every trade: its currency paid for buys and received from sells, and the tokens (empty from a service older than 17 Oct 2026). */
    get positions() { return positions; },
    /** The currency of each coin listed that doesn't trade in STRK, by canonical address (accountCurrency reads it). */
    get currencies() { return currencies; },
    /** The coins the account launched, newest first (empty from a service older than 17 Oct 2026). */
    get launched() { return launched; },
    /** The coins whose fees it receives a share of, newest first (empty from a service older than 27 Oct 2026). */
    get payeeOf() { return payees; },
    /** Whether the service has a file for it (false: it holds no coin and never traded one). */
    get found() { return found; },
    /** The block the data is complete to (-1 before the first read). */
    get atBlock() { return atBlock; },
    /** Reads what's new; true if anything changed. Throws PublishedUnavailable when the data can't be used. */
    async update(): Promise<boolean> {
      try {
        const status = await read("status.json");
        if (!status) throw new PublishedUnavailable("the market data has no status");
        identity(status);
        if (typeof status.lastSuccessAt !== "number" || fresh(status.lastSuccessAt) === "delayed") throw new PublishedUnavailable("the market data is delayed");
        if (!Number.isSafeInteger(status.indexedBlock) || status.indexedBlock < 0) throw new PublishedUnavailable("invalid market data block");
        if (status.indexedBlock === atBlock && status.lastSuccessAt === statusAt) return false;
        const j = await read(`accounts/${address}.json`);
        if (!j) {
          // Account files are written before status.json, so a fresh status without one means there's nothing to show.
          let changed = found || holdings.length > 0 || trades.length > 0 || positions.length > 0 || launched.length > 0 || payees.length > 0;
          holdings = []; trades = []; positions = []; launched = []; payees = []; currencies = {}; tradeCount = 0; found = false; atBlock = status.indexedBlock; statusAt = status.lastSuccessAt;
          return changed;
        }
        identity(j);
        if (!same(j.account, address)) throw new PublishedUnavailable("the market data is for another account");
        if (typeof j.updatedAt !== "number" || !Number.isSafeInteger(j.indexedBlock)) throw new PublishedUnavailable("invalid account data");
        if (j.updatedAt < publishedAt) return false;   // an older publication than the one held (caches): read again next time
        if (!Array.isArray(j.holdings) || !Array.isArray(j.trades) || !Number.isSafeInteger(j.tradeCount) || j.tradeCount < j.trades.length)
          throw new PublishedUnavailable("invalid account data");
        // Only the coins of the launch factories this reader follows, in every list and count.
        const keep = accountScope(j, o);
        const scoped = <T extends { token: string }>(list: T[]) => (keep ? list.filter(x => keep(x.token)) : list);
        const nextHoldings = scoped((j.holdings as Json[]).map(holdingOf)), nextTrades = scoped((j.trades as Json[]).map(t => tradeOf(t, address)));
        // Files from before 17 Oct 2026 have neither list.
        const nextPositions = scoped(Array.isArray(j.positions) ? (j.positions as Json[]).map(positionOf) : []), nextLaunched = scoped(Array.isArray(j.launched) ? (j.launched as Json[]).map(launchOf) : []);
        const nextPayees = scoped(Array.isArray(j.payeeOf) ? (j.payeeOf as Json[]).map(payeeOf) : []);   // files from before 27 Oct 2026 have none
        const nextCurrencies = keep ? Object.fromEntries(Object.entries(currenciesOf(j.currencies)).filter(([t]) => keep(t))) : currenciesOf(j.currencies);
        // The account's trade count across the kept coins: each position's buys and sells (every traded coin has one).
        const nextTradeCount = keep ? (Array.isArray(j.positions) ? nextPositions.reduce((n, p) => n + p.buys + p.sells, 0) : nextTrades.length) : j.tradeCount as number;
        const text = (l: unknown) => JSON.stringify(l, (_, v) => (typeof v === "bigint" ? String(v) : v));
        let changed = !found || text(nextHoldings) !== text(holdings) || text(nextTrades) !== text(trades) || nextTradeCount !== tradeCount
          || text(nextPositions) !== text(positions) || text(nextLaunched) !== text(launched) || text(nextPayees) !== text(payees)
          || text(nextCurrencies) !== text(currencies);
        if (changed) { holdings = nextHoldings; trades = nextTrades; positions = nextPositions; launched = nextLaunched; payees = nextPayees; currencies = nextCurrencies; tradeCount = nextTradeCount; }
        found = true; publishedAt = j.updatedAt; atBlock = status.indexedBlock; statusAt = status.lastSuccessAt;
        return changed;
      } catch (e) {
        throw e instanceof PublishedUnavailable ? e : new PublishedUnavailable(`the market data couldn't be read (${(e instanceof Error ? e.message : String(e)).slice(0, 120)})`);
      }
    },
  };
}
