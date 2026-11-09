// The ZEC launchpad: the agent tools name each coin's currency.
// A ZEC coin's amounts use ZEC's 8 decimals and its prices are whole ZEC per whole token; no `*_strk` field ever
// carries a ZEC figure; coins in both currencies are sorted in dollars, or within each currency when the prices aren't
// known. STRK coins keep every field they had (test/tools.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { hokoriTools, usdFromService, type UsdPrices } from "../tools.ts";
import { STRK_CURRENCY, ZEC_MAINNET } from "@hokoridotio/sdk";

const ONE = 10n ** 18n;
const PARAMS = { startPrice: 1, supply: 1_000_000_000, t0: 1_073_000_000n * ONE, curveTokens: 793_100_000n * ONE };
const listed = (n: number, mcap: number, currency = STRK_CURRENCY) => ({ token: `0x${n.toString(16).padStart(64, "0")}`, name: `Coin ${n}`, symbol: `C${n}`, meta: null, pool: null, t: null,
  trades: [], launchTime: 1_700_000_000 + n, launchBlock: n, stats: { mcap, volume24h: mcap / 10, trades: 1 }, params: { ...PARAMS, currency } });
/** A ZEC coin on its curve: 0.5 ZEC (50,000,000 base units) against 1,000,000,000 tokens. */
const zecCoin = { token: "0x1dab", creator: "0x2", devTokens: 0n, supply: 1_000_000_000n * ONE, currency: ZEC_MAINNET,
  state: { q: 50_000_000n, t: 1_000_000_000n * ONE, sold: 0n, graduated: false, open: true }, params: { curve_tokens: 793_100_000n * ONE, fee_bps: 90n }, buyFeeBps: 90n, pool: null, readAt: 5 };

function client(coins = [listed(1, 400_000), listed(2, 30, ZEC_MAINNET), listed(3, 5, ZEC_MAINNET)]) {
  const asked: { side: string; amount: bigint }[] = [];
  const store = { poll: async () => {}, getState: () => ({ ready: true, error: null, params: PARAMS, coins, recent: [] }) };
  const h = {
    network: { label: "Starknet" }, factories: [{ address: "0x2ec", block: 0 }, { address: "0xfac", block: 0 }],
    market: () => store,
    coin: async () => zecCoin,
    metadata: async () => ({ meta: null, problem: null }),
    quote: (_c: unknown, q: { side: string; amount: bigint }) => {
      asked.push(q);
      return { venue: "curve", side: q.side, pay: q.amount, spend: q.amount, refund: 0n, receive: 19_000_000n * ONE, fee: 9_000n, feeInCoin: false, minReceive: 18_810_000n * ONE,
        priceBefore: 5e-20, priceAfter: 5.1e-20, impactPpm: 20_000 };
    },
    settings: async () => settings("0xfac", STRK_CURRENCY),
    settingsOf: async (a: string) => settings(a, BigInt(a) === 0x2ecn ? ZEC_MAINNET : STRK_CURRENCY),
  };
  return { h: h as never, asked };
}
function settings(address: string, currencyInfo: typeof STRK_CURRENCY) {
  return { address, currencyInfo, params: { fee_bps: 90n, grad_fee_bps: 100n, sniper_fee_bps: 9900n, sniper_blocks: 2n, curve_tokens: 793_100_000n * ONE }, protocolBps: 1500,
    supply: 1_000_000_000n * ONE, launchFee: 0n, maxDevTokens: null, addressRule: { suffix: 0xdabn, digits: 3 } };
}
const tool = (h: never, name: string, usd?: () => Promise<UsdPrices>) => hokoriTools(h, usd ? { usd } : {}).find(t => t.name === name)!;

test("a ZEC coin's quote: the amount in ZEC's 8 decimals, its figures in ZEC, its prices per whole ZEC, no STRK fields", async () => {
  const c = client();
  const q = await tool(c.h, "quote_trade").run({ token: "0x1dab", side: "buy", amount: "0.01" }) as Record<string, unknown>;
  assert.equal(c.asked[0].amount, 1_000_000n, "0.01 ZEC is 1,000,000 base units, not 10^16");
  assert.equal(q.currency, "ZEC");
  assert.match(String(q.pay), /^0\.01(0*)? ZEC$/); assert.match(String(q.fee), /^0\.00009(0*)? ZEC$/); assert.match(String(q.receive), / tokens$/);
  assert.ok(Math.abs((q.price_before_per_token as number) / 5e-10 - 1) < 1e-12, "whole ZEC per whole token: 10^10 times the base-unit ratio");
  assert.equal(q.price_before_strk_per_token, undefined); assert.equal(q.price_after_strk_per_token, undefined);
  await assert.rejects(tool(c.h, "quote_trade").run({ token: "0x1dab", side: "buy", amount: "0.000000001" }), /paid in ZEC, which has 8 decimals/);
  await tool(c.h, "quote_trade").run({ token: "0x1dab", side: "sell", amount: "1.5" });
  assert.equal(c.asked.at(-1)!.amount, 3n * ONE / 2n, "a sell's amount is tokens, 18 decimals");
});

test("a ZEC coin as it stands: its currency, price and market cap in ZEC, no STRK fields", async () => {
  const r = await tool(client().h, "get_coin").run({ token: "0x1dab" }) as Record<string, unknown>;
  assert.equal(r.currency, "ZEC");
  assert.ok(Math.abs((r.price_per_token as number) / 5e-10 - 1) < 1e-12, "0.5 ZEC over 10^9 tokens");
  assert.ok(Math.abs((r.market_cap as number) / 0.5 - 1) < 1e-12);
  assert.equal(r.price_strk_per_token, undefined); assert.equal(r.market_cap_strk, undefined);
});

test("coins in both currencies: sorted in dollars when both prices are known, else within each currency, STRK first", async () => {
  type Row = Record<string, unknown>;
  const list = async (usd?: UsdPrices) => await tool(client().h, "list_coins", usd && (async () => usd)).run({ sort: "mcap" }) as { coins: Row[]; sorted?: string };
  const priced = await list({ STRK: 0.05, ZEC: 1_000 });
  // 400,000 STRK at $0.05 is $20,000; 30 ZEC at $1,000 is $30,000; 5 ZEC is $5,000.
  assert.deepEqual(priced.coins.map(r => r.token), [listed(2, 0).token, listed(1, 0).token, listed(3, 0).token]);
  assert.match(priced.sorted ?? "", /in dollars/);
  const zec = priced.coins[0];
  assert.equal(zec.currency, "ZEC"); assert.equal(zec.market_cap, 30); assert.equal(zec.market_cap_usd, 30_000);
  assert.equal(zec.market_cap_strk, undefined, "a ZEC figure is never labelled STRK"); assert.equal(zec.volume_24h_strk, undefined);
  const strk = priced.coins[1];
  assert.equal(strk.market_cap_strk, 400_000, "STRK coins keep their fields"); assert.equal(strk.currency, "STRK");
  const unpriced = await list({ STRK: 0.05 });
  assert.deepEqual(unpriced.coins.map(r => r.token), [listed(1, 0).token, listed(2, 0).token, listed(3, 0).token], "STRK's first, then ZEC's by their own figures");
  assert.match(unpriced.sorted ?? "", /within each currency/);
  const strkOnly = await tool(client([listed(1, 5), listed(4, 9)]).h, "list_coins").run({ sort: "mcap" }) as { coins: Row[]; sorted?: string };
  assert.deepEqual(strkOnly.coins.map(r => r.market_cap_strk), [9, 5]); assert.equal(strkOnly.sorted, undefined, "one currency: as before");
});

test("an account's ZEC trades are in ZEC, from its file's currencies; STRK trades keep `strk`", async () => {
  const token = `0x${"1dab".padStart(64, "0")}`, other = `0x${"2dab".padStart(64, "0")}`;
  const trade = (t: string, currency: bigint) => ({ token: t, side: "buy", venue: "curve", tokens: ONE, currency, time: 1_700_000_000, tx: "0x9", block: 1, trader: "0x7a", priceAfter: 1 });
  const acc = { update: async () => true, holdings: [{ token, balance: ONE, symbol: "Z", name: "Zed" }], trades: [trade(token, 1_000_000n), trade(other, 2n * ONE)], tradeCount: 2, atBlock: 9,
    currencies: { [token]: ZEC_MAINNET } };
  const r = await tool({ account: () => acc } as never, "get_account").run({ address: "0x7a" }) as { holdings: Record<string, unknown>[]; trades: Record<string, unknown>[] };
  assert.equal(r.holdings[0].currency, "ZEC");
  const [strkTrade, zecTrade] = r.trades;   // newest first
  assert.equal(zecTrade.currency, "ZEC"); assert.match(String(zecTrade.amount), /^0\.01(0*)?$/); assert.equal(zecTrade.strk, undefined);
  assert.equal(strkTrade.currency, "STRK"); assert.match(String(strkTrade.strk), /^2(\.0+)?$/);
});

test("launch settings name the launch factory's currency, and each launchpad's rules when both are followed", async () => {
  const r = await tool(client().h, "launch_settings").run({}) as Record<string, unknown> & { launchpads?: Record<string, unknown>[] };
  assert.equal(r.currency, "STRK"); assert.equal(r.factory, "0xfac");
  assert.deepEqual(r.launchpads?.map(l => [l.factory, l.currency]), [["0x2ec", "ZEC"], ["0xfac", "STRK"]]);
  assert.match(String(r.launchpads![0].launch_fee), / ZEC$/);
});

test("dollar prices from price.json: each kept only while under ten minutes old, read at most every 30 seconds", async () => {
  let now = 1_000_000_000_000, reads = 0;
  const body = { usd: 0.05, at: now - 60_000, zec: { usd: 1_000, at: now - 11 * 60_000 } };
  const fetcher = (async () => { reads++; return new Response(JSON.stringify(body)); }) as unknown as typeof fetch;
  const usd = usdFromService("https://data.test/", fetcher, () => now);
  assert.deepEqual(await usd(), { STRK: 0.05 }, "ZEC's reading is stale: left out");
  await usd(); assert.equal(reads, 1, "held for 30 seconds");
  now += 31_000; body.zec.at = now;
  assert.deepEqual(await usd(), { STRK: 0.05, ZEC: 1_000 });
  const down = usdFromService("https://data.test", (async () => { throw new Error("down"); }) as unknown as typeof fetch, () => now);
  assert.deepEqual(await down(), {}, "unavailable: no prices, no error");
});
