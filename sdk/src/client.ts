// One object for a bot, an agent or an app: Hokori on one network, through your own provider (starknet.js's RpcProvider
// fits), with its launch factory from the network list. Everything that signs starts from the chain, read through the
// factory; published market data (the market-data service) is for display and discovery only. Nothing here holds keys,
// signs or sends: it returns calls, which your account executes as one multicall.
import { priceScale } from "./currency.ts";
import { curveState as normalizeState } from "./curve.ts";
import { orderCalls, placeOrder, tradeQuote, type Market, type Order, type Side, type TradeQuote } from "./orders.ts";
import type { HokoriCall } from "./calls.ts";
import { NETWORKS, historyStart, launchFactory, networkFactories, type FactoryRef, type HokoriNetwork, type NetworkName } from "./networks.ts";
import {
  claimFeeCalls, readCoin, readFactory, readWaitingPoolFees, refreshCoin, resolveFactory, type CallSource, type CoinOnChain, type FactorySettings, type HeadSource,
} from "./reads.ts";
import { confirmTx, type ReceiptSource } from "./tx.ts";
import type { EventSource } from "./events.ts";
import type { BlockSource, TxSource } from "./trades.ts";
import { createDataFeed, createPublishedTrades } from "./data-feed.ts";
import { createMarketFeed, type MarketParams } from "./market-feed.ts";
import { createPublishedAccount } from "./account-feed.ts";
import { fetchMetadata } from "./metadata.ts";

/** What the client needs from a provider: starknet.js's RpcProvider has all of it. */
export type HokoriProvider = CallSource & HeadSource & EventSource & BlockSource & TxSource & ReceiptSource & { getChainId(): Promise<string> };

/** A coin's live state, as quotes need it: its curve, or its Ekubo pool once graduated. */
export const marketOf = (c: CoinOnChain): Market => ({
  venue: c.state.graduated ? "pool" : "curve",
  curve: { state: normalizeState(c.state), params: c.params },
  pool: c.pool ?? undefined,
});

/** A trade ready to sign: its calls (one multicall), the order they carry, and the quote they were checked against. */
export type PreparedTrade = { calls: HokoriCall[]; order: Order; fresh: TradeQuote; coin: CoinOnChain; graduates: boolean; deadline: number };

/**
 * The calls for a quote the trader accepted, checked against the chain now (the site's trade panel does the same):
 * the coin is read again; a curve buy inside the launch window (a 99% fee for its first two blocks) is refused; the
 * order keeps the accepted venue and minimum and never offers more than the quote spends (placeOrder); a buy that
 * takes the curve's last tokens calls buy_and_graduate. Anything that would need a different order returns a problem
 * instead: quote again and accept the new quote. `deadline` is unix seconds; the contracts refuse the trade after it.
 */
/** `currency`, when given, must be the coin's own (its factory's); a buy pays in the coin's currency either way. */
export async function prepareTrade(read: () => Promise<CoinOnChain>, quote: TradeQuote, deadline: number, currency?: string): Promise<PreparedTrade | { problem: string }> {
  const coin = await read();
  if (quote.token !== undefined && BigInt(quote.token) !== BigInt(coin.token)) return { problem: "That quote is for another coin." };
  if (quote.venue === "curve" && quote.side === "buy" && coin.state.open && coin.buyFeeBps > coin.params.fee_bps)
    return { problem: "The launch window is still open (buys pay a 99% fee for the first two blocks). Try again in a few seconds." };
  // A buy quoted at the window's fee has a minimum about 1% of what it buys after the window: quote again.
  if (quote.venue === "curve" && quote.side === "buy" && quote.buyFeeBps !== undefined && quote.buyFeeBps > coin.buyFeeBps)
    return { problem: "The launch window has ended since this quote, so buys pay the normal fee now. Check the new quote." };
  const placed = placeOrder(quote, marketOf(coin), coin.params.min_trade);
  if ("problem" in placed) return placed;
  const { order } = placed;
  const graduates = order.venue === "curve" && order.side === "buy" && placed.fresh.receive === coin.params.curve_tokens - coin.state.sold;
  if (currency !== undefined && BigInt(currency) !== BigInt(coin.route.currency)) return { problem: `this coin trades against ${coin.currency.symbol}, not ${currency}` };
  const calls = orderCalls(order, { target: order.venue === "pool" ? coin.route.locker : coin.curve, payToken: order.side === "buy" ? coin.route.currency : coin.token,
    deadline, route: coin.route, graduate: graduates });
  return { calls, order, fresh: placed.fresh, coin, graduates, deadline };
}

export type HokoriClient = ReturnType<typeof createHokori>;

/**
 * Hokori on `network` ("mainnet" or "sepolia", or your own HokoriNetwork), read through `provider`. By default it
 * follows every launchpad's factories (STRK, ZEC and BTC), the same set the network's market-data service follows, and
 * `factory`, where new launches go, is the STRK launchpad's newest (`launchFactory(network, "ZEC")` or `"BTC"` names the others).
 * `factories` (oldest first; or one `factory`) replaces that list, for a test factory, and its newest takes launches.
 * `dataUrl` is a market-data service (e.g. https://data.hokori.io), without which the market is read from the chain;
 * `gateway` serves coins' ar:// metadata. A coin is read through the factory that launched it, with that factory's
 * settings and currency, so a later factory never drops earlier coins.
 */
export function createHokori(o: { network: NetworkName | HokoriNetwork; provider: HokoriProvider; factory?: FactoryRef; factories?: FactoryRef[];
  dataUrl?: string; gateway?: string; fetcher?: typeof fetch }) {
  const network = typeof o.network === "string" ? NETWORKS[o.network] : o.network;
  const own = o.factories ?? (o.factory ? [o.factory] : null);
  const factories = own ?? networkFactories(network);
  const factory = own ? own[own.length - 1] : launchFactory(network);
  if (!factory) throw new Error(`Hokori has no launch factory on ${network.label} yet`);
  const addresses = factories.map(f => f.address);
  const p = o.provider, gateway = o.gateway ?? "https://arweave.net/", dataUrl = o.dataUrl?.replace(/\/$/, "");
  const settings = new Map<string, Promise<FactorySettings>>();   // by factory
  const key = (a: string) => BigInt(a).toString(16);
  // The provider must be on this network (checked once): a factory address means nothing on another chain.
  let chainChecked: Promise<void> | null = null;
  const onNetwork = () => (chainChecked ??= p.getChainId().then(id => {
    if (BigInt(id) !== BigInt(network.chainId)) throw new Error(`the provider is on chain ${id}, not ${network.label} (${network.chainId})`);
  }).catch(e => { chainChecked = null; throw e; }));
  // Which factory launched a coin, asked once per coin (a coin never changes factory).
  const homes = new Map<string, string>();
  const factoryOf = async (token: string): Promise<string> => {
    await onNetwork();
    const k = key(token);
    let f = homes.get(k);
    if (!f) {
      f = (await resolveFactory(p, addresses, token)) ?? undefined;
      if (!f) throw new Error(`unknown token: no Hokori factory on ${network.label} launched ${token}`);
      homes.set(k, f);
    }
    return f;
  };
  // Read through the coin's factory once known; the first time, readCoin resolves it after its head read (so the
  // watermark still precedes every state read) and the answer is kept.
  const coin = async (token: string) => {
    await onNetwork();
    const known = homes.get(key(token));
    const c = await readCoin(p, { ...(known ? { factory: known } : { factories: addresses }), token, ekubo: network.ekubo });
    homes.set(key(token), c.factory);
    return c;
  };
  // Every chain read goes through the network check, including the settings cache and the market feed (review
  // 2026-10-16: market() and marketParams() bypassed it, so a wrong-chain provider returned an empty market, no error).
  const settingsOf = (address: string) => {
    const k = key(address);
    let s = settings.get(k);
    if (!s) { s = onNetwork().then(() => readFactory(p, address)); settings.set(k, s); s.catch(() => settings.delete(k)); }
    return s;
  };
  const marketParams = async (address: string = factory.address): Promise<MarketParams> => {
    const f = await settingsOf(address);
    // In whole currency per whole token, with the factory's currency (without them a ZEC
    // factory's coins were priced as STRK, 10^10 too small, and their pools read with STRK as the other token).
    return { startPrice: Number(f.params.v0) / Number(f.params.t0) * priceScale(f.currencyInfo), supply: Number(f.supply) / 1e18, t0: f.params.t0, curveTokens: f.params.curve_tokens, currency: f.currencyInfo };
  };
  return {
    network,
    /** The launch factory: where new launches go (the STRK launchpad's newest, unless `factories` was given). */
    factory,
    /** Every factory followed, oldest first: by default every launchpad's. */
    factories,
    /** The launch factory's settings: curve, fees, supply, vault, locker, launch fee, dev buy cap (read once). */
    settings: () => settingsOf(factory.address),
    /** Any followed factory's settings (a coin's own: `factoryOf`). */
    settingsOf,
    /** The factory that launched `token` (throws for a token none did: isUnknownToken). */
    factoryOf,
    /** A coin as it stands on the chain now, read through the factory that launched it (throws for a token none of the
     *  followed factories launched: isUnknownToken). */
    coin,
    /** The same coin re-read where it moves (curve state, launch-window fee, pool). */
    refresh: async <C extends CoinOnChain>(c: C) => { await onNetwork(); return refreshCoin(p, c); },
    /** A quote on a coin as read: `amount` is STRK offered for a buy, tokens for a sell (base units). */
    // A curve buy is quoted at the fee it would pay now: inside the launch window, the window's (prepareTrade then
    // refuses it until the window ends).
    quote: (c: CoinOnChain, q: { side: Side; amount: bigint; slippageBps: number }): TradeQuote => {
      const m = marketOf(c);
      const windowFee = m.venue === "curve" && q.side === "buy" && c.buyFeeBps !== c.params.fee_bps;
      const quoted = { ...tradeQuote({ ...m, ...(windowFee ? { curve: { ...m.curve!, params: { ...m.curve!.params, fee_bps: c.buyFeeBps } } } : {}), ...q }), token: c.token };
      return m.venue === "curve" && q.side === "buy" ? { ...quoted, buyFeeBps: c.buyFeeBps } : quoted;
    },
    /** The calls for an accepted quote, checked against the chain now (see prepareTrade). Default deadline: 2 minutes. */
    prepareTrade: (quote: TradeQuote, token: string, { deadline = Math.floor(Date.now() / 1000) + 120 }: { deadline?: number } = {}) =>
      prepareTrade(() => coin(token), quote, deadline),
    /** The calls that claim a payee's share of a coin's fees (flushing the curve's and collecting the pool's first). */
    claimCalls: async (token: string) => { const c = await coin(token); return claimFeeCalls(c, await readWaitingPoolFees(p, c)); },
    /** A coin's metadata, checked against the hash its launch committed. */
    metadata: (c: Pick<CoinOnChain, "metadataUri" | "metadataSha256">) => fetchMetadata(c.metadataUri, c.metadataSha256, { gateway, fetcher: o.fetcher }),
    /** Waits until a sent transaction is accepted, then says whether it executed. */
    confirm: (hash: string, opts?: { intervalMs?: number; timeoutMs?: number }) => confirmTx(p, hash, opts),
    /** The live market as a store (subscribe / getState / poll): from the market-data service when `dataUrl` is set,
     *  otherwise read from the chain. Display only. */
    market: () => {
      if (dataUrl) return createDataFeed({ url: dataUrl, factories: addresses, chainId: network.chainId, fetcher: o.fetcher });
      const feed = createMarketFeed({ provider: p, factories: addresses, core: network.ekubo.core, loadParams: marketParams,
        fetchMeta: (uri, sha) => fetchMetadata(uri, sha, { gateway, fetcher: o.fetcher }) }, { startBlock: historyStart(factories) });
      // The chain is checked before the feed's first read, whatever the feed reads first.
      return { ...feed, poll: async () => { await onNetwork(); return feed.poll(); } };
    },
    /** One coin's published trades, chart, state and holders (needs `dataUrl`). Display only. */
    coinData: (token: string) => { if (!dataUrl) throw new Error("coinData needs a market-data service (dataUrl)"); return createPublishedTrades({ url: dataUrl, token, factories: addresses, chainId: network.chainId, fetcher: o.fetcher }); },
    /** An account's published holdings and trades (needs `dataUrl`). Display only. */
    account: (address: string) => { if (!dataUrl) throw new Error("account needs a market-data service (dataUrl)"); return createPublishedAccount({ url: dataUrl, address, factories: addresses, chainId: network.chainId, fetcher: o.fetcher }); },
  };
}
