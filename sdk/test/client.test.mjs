// The client's trade path, against a scripted chain: a quote, then the calls for it checked against the chain again,
// as the site's trade panel does (launch window, moved price, last buy, graduated coin).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ONE, ZEC_MAINNET, ceilDiv } from "../src/index.ts";
import { createHokori } from "../src/client.ts";
import { NETWORKS } from "../src/networks.ts";
import { FACTORY, P, STRK, TOKEN, provider } from "./fake-chain.mjs";

const K = P.v0 * P.t0;
/** A curve with `sold` tokens sold, its reserves consistent with the curve. */
const curveAt = sold => { const t = P.t0 - sold; return { sold, t, q: ceilDiv(K, t) }; };
const network = { ...NETWORKS.sepolia, factories: [{ address: FACTORY, block: 0 }] };
const client = chain => createHokori({ network, provider: chain });

test("a curve buy inside the launch window is refused; after it, the calls are an exact approval and the buy", async () => {
  const early = client(provider({ head: 100, launchBlock: 100, ...curveAt(73_000_000n * ONE) }));
  const coin = await early.coin(TOKEN);
  const q = early.quote(coin, { side: "buy", amount: ONE, slippageBps: 100 });
  assert.match((await early.prepareTrade(q, TOKEN)).problem, /launch window/);
  const later = client(provider({ head: 200, launchBlock: 100, ...curveAt(73_000_000n * ONE) }));
  const r = await later.prepareTrade(later.quote(await later.coin(TOKEN), { side: "buy", amount: ONE, slippageBps: 100 }), TOKEN, { deadline: 1_900_000_000 });
  assert.equal(r.problem, undefined);
  assert.deepEqual(r.calls.map(c => c.entrypoint), ["approve", "buy"]);
  assert.equal(BigInt(r.calls[0].contractAddress), BigInt(STRK));
  assert.equal(r.order.amount, ONE); assert.equal(r.graduates, false);
  assert.equal(BigInt(r.calls[1].calldata[4]), 1_900_000_000n, "the deadline is signed");
});

test("a price that moved past the accepted minimum needs a new quote; nothing is built", async () => {
  const before = client(provider({ head: 200, ...curveAt(73_000_000n * ONE) }));
  const q = before.quote(await before.coin(TOKEN), { side: "buy", amount: 10n * ONE, slippageBps: 0 });
  const after = client(provider({ head: 201, ...curveAt(300_000_000n * ONE) }));   // others bought in between
  assert.match((await after.prepareTrade(q, TOKEN)).problem, /slippage/);
});

test("a last buy offers only what it spends and graduates the coin in the same call", async () => {
  const left = 1_000n * ONE, h = client(provider({ head: 200, ...curveAt(P.curve_tokens - left) }));
  const q = h.quote(await h.coin(TOKEN), { side: "buy", amount: 1_000_000n * ONE, slippageBps: 100 });
  assert.equal(q.receive, left); assert.ok(q.refund > 0n);
  const r = await h.prepareTrade(q, TOKEN);
  assert.equal(r.graduates, true);
  assert.equal(r.calls[1].entrypoint, "buy_and_graduate");
  assert.equal(r.order.amount, q.spend, "never more than the quote spends");
});

test("a graduated coin trades in its Ekubo pool through the Router, protected by the locker's deadline check", async () => {
  const h = client(provider({ graduated: true, head: 500 }));
  const coin = await h.coin(TOKEN);
  assert.ok(coin.pool);
  const r = await h.prepareTrade(h.quote(coin, { side: "buy", amount: ONE, slippageBps: 100 }), TOKEN);
  assert.deepEqual(r.calls.map(c => c.entrypoint), ["check_deadline", "transfer", "swap", "clear_minimum", "clear"]);
  assert.equal(BigInt(r.calls[2].contractAddress), BigInt(NETWORKS.sepolia.ekubo.router));
});

test("the client needs a factory: a network without one is refused; mainnet has the launch factory (28 Oct 2026)", () => {
  assert.throws(() => createHokori({ network: { ...NETWORKS.mainnet, factories: [] }, provider: provider() }), /no launch factory/);
  assert.ok(createHokori({ network: "mainnet", provider: provider({ chainId: NETWORKS.mainnet.chainId }) }));
});

test("the provider must be on the client's network", async () => {
  const wrong = createHokori({ network, provider: provider({ chainId: NETWORKS.mainnet.chainId }) });
  await assert.rejects(wrong.coin(TOKEN), /not Starknet Sepolia/);
  await assert.rejects(wrong.settings(), /not Starknet Sepolia/);
});

test("a quote carries its coin, and prepareTrade refuses it for another", async () => {
  const h = client(provider({ head: 200, ...curveAt(73_000_000n * ONE) }));
  const q = h.quote(await h.coin(TOKEN), { side: "buy", amount: ONE, slippageBps: 100 });
  assert.equal(BigInt(q.token), BigInt(TOKEN));
  assert.match((await h.prepareTrade({ ...q, token: "0x9999" }, TOKEN)).problem, /another coin/);
});

test("a launch-window buy is quoted at the window's fee", async () => {
  const h = client(provider({ head: 100, launchBlock: 100, ...curveAt(73_000_000n * ONE) }));
  const coin = await h.coin(TOKEN);
  const q = h.quote(coin, { side: "buy", amount: ONE, slippageBps: 0 });
  assert.equal(q.fee, ONE * 9_900n / 10_000n, "99% of the offer, not the normal 0.9%");
  // Accepted after the window, its minimum (about 1% of the fair amount) would barely protect the buy: quote again.
  const after = client(provider({ head: 200, launchBlock: 100, ...curveAt(73_000_000n * ONE) }));
  assert.match((await after.prepareTrade(q, TOKEN)).problem, /launch window has ended/);
  const fresh = after.quote(await after.coin(TOKEN), { side: "buy", amount: ONE, slippageBps: 0 });
  assert.equal((await after.prepareTrade(fresh, TOKEN)).problem, undefined);
});

test("the client's market feed prices a ZEC factory in whole ZEC per whole token; STRK as before", async () => {
  const paramsOn = async currency => { const m = client(provider({ currency })).market(); await m.poll(); return m.getState().params; };
  const strk = await paramsOn(STRK), zec = await paramsOn(ZEC_MAINNET.address);
  assert.equal(strk.startPrice, Number(P.v0) / Number(P.t0), "STRK unchanged");
  assert.equal(BigInt(strk.currency.address), BigInt(STRK));
  assert.deepEqual(zec.currency, ZEC_MAINNET, "the factory's currency, with its 8 decimals");
  assert.equal(zec.startPrice, Number(P.v0) / Number(P.t0) * 1e10, "a ZEC base unit is 10^10 times an 18-decimal one");
});
