// Who each trade is credited to, through the high-level client (createHokori), as an SDK user or the MCP server reads
// it (the client once built its market without the network's adapters, so a
// trade routed through the TradeAdapter was the adapter's and a protected trade an ordinary account's). From the chain:
// a routed trade is the account its record names; one without its record, or one a record can't single out, is
// nobody's ("unknown"); a protected trade names no one; a direct trade is its trader's. From the market-data service:
// a trade published without attribution by a privacy adapter is protected. The matching itself is tested in
// routed.test.mjs and protected.test.mjs; these check the client hands it what it needs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT, SELECTOR, attributionOf, byteArrayFelts, hasTrader } from "../src/index.ts";
import { createHokori } from "../src/client.ts";
import { NETWORKS } from "../src/networks.ts";
import { CURVE, FACTORY, P, TOKEN, hex, provider, u } from "./fake-chain.mjs";

const E = 10n ** 18n, TX = "0x123", ALICE = hex(0xa11ce), BOB = hex(0xb0b);
// The network's own TradeAdapter (from block 0 here, so the scripted chain's blocks are read), and a privacy adapter
// for the scripted factory.
const ADAPTER = { ...NETWORKS.mainnet.tradeAdapter, block: 0 };
const PRIVACY = { address: hex(0xabcd), factory: FACTORY, block: 0 };
const NETWORK = { ...NETWORKS.mainnet, tradeAdapter: ADAPTER, privacy: { ...NETWORKS.mainnet.privacy, adapters: [PRIVACY] } };
const felts = s => byteArrayFelts(s).map(hex);

const LAUNCH = { from_address: FACTORY, transaction_hash: "0x122", block_number: 90, keys: [EVENT.LAUNCH, TOKEN, "0xc0"],
  data: [CURVE, "0x0", ...felts("Test"), ...felts("TST"), ...felts("ar://fixture"), ...u(0n), ...u(0n), ...u(0n), ...u(0n)] };
/** A curve Buy { #[key] buyer, spent, fee, tokens, q, t } in TX. */
const buy = (buyer, spent = E, tokens = 1000n * E) => ({ from_address: CURVE, transaction_hash: TX, block_number: 100, keys: [EVENT.BUY, buyer],
  data: [...u(spent), ...u(spent / 100n), ...u(tokens), ...u(31n * E), ...u(P.t0 - tokens)] });
/** The TradeAdapter's Bought { #[key] account, #[key] coin, spent, tokens, venue, budgeted } for a curve buy in TX. */
const bought = (account, spent = E, tokens = 1000n * E) => ({ from_address: ADAPTER.address, transaction_hash: TX, block_number: 100,
  keys: [SELECTOR.Bought, account, TOKEN], data: [...u(spent), ...u(tokens), "0x6375727665", "0x1"] });
/** A privacy adapter's ProtectedTrade record for a buy in TX. */
const protectedRecord = { from_address: PRIVACY.address, transaction_hash: TX, block_number: 100, keys: [SELECTOR.ProtectedTrade, TOKEN], data: ["0x0", "0x0", hex(E), hex(1000n * E)] };

/** A chain with the launch and `events` (each read from the address it was emitted by); records the addresses asked. */
function chain(events) {
  const p = provider({ head: 100, launchBlock: 90, chainId: NETWORKS.mainnet.chainId }), asked = [];
  return { ...p, asked, async getEvents(q) { asked.push(BigInt(q.address)); return { events: [LAUNCH, ...events].filter(e => BigInt(e.from_address) === BigInt(q.address)) }; } };
}
/** The client's recent trades, oldest first, read from the chain. */
async function fromChain(events) {
  const p = chain(events);
  const market = createHokori({ network: NETWORK, factories: [{ address: FACTORY, block: 90 }], provider: p, fetcher: async () => new Response("{}") }).market();
  await market.poll();
  assert.equal(market.getState().error, null);
  return { trades: market.getState().recent.map(r => r.trade).reverse(), asked: p.asked };
}

test("from the chain: a trade routed through the TradeAdapter is the account its record names, and the adapter is read", async () => {
  const { trades, asked } = await fromChain([buy(ADAPTER.address), bought(ALICE)]);
  assert.equal(trades.length, 1);
  assert.equal(BigInt(trades[0].trader), BigInt(ALICE));
  assert.equal(attributionOf(trades[0]), "account");
  assert.ok(asked.includes(BigInt(ADAPTER.address)), "the client reads the adapter's records");
});

test("from the chain: an adapter's trade without its record, or one the record can't single out, is nobody's", async () => {
  const unproven = await fromChain([buy(ADAPTER.address)]);
  assert.equal(attributionOf(unproven.trades[0]), "unknown");
  assert.equal(hasTrader(unproven.trades[0]), false, "not credited to the adapter");
  // Two identical buys by the adapter in one transaction, one record: which one it proves can't be told.
  const ambiguous = await fromChain([buy(ADAPTER.address), buy(ADAPTER.address), bought(ALICE)]);
  assert.deepEqual(ambiguous.trades.map(attributionOf), ["unknown", "unknown"]);
});

test("from the chain: a protected trade names no one; a direct trade is its trader's", async () => {
  const shielded = await fromChain([buy(PRIVACY.address), protectedRecord]);
  assert.equal(attributionOf(shielded.trades[0]), "protected");
  assert.equal(hasTrader(shielded.trades[0]), false);
  const direct = await fromChain([buy(BOB)]);
  assert.equal(BigInt(direct.trades[0].trader), BigInt(BOB));
  assert.equal(attributionOf(direct.trades[0]), "account");
});

test("from the market-data service: a trade published without attribution by a privacy adapter is protected", async () => {
  const MARKET = {
    chainId: NETWORKS.mainnet.chainId, factories: [FACTORY], updatedAt: Date.now(), params: { startPrice: 1e-8, supply: 1e9, t0: String(P.t0), curveTokens: String(P.curve_tokens) },
    coins: [{ token: TOKEN, curve: CURVE, creator: hex(0xc0), index: 0, name: "Test", symbol: "TST", metadataUri: "ar://fixture", metadataSha256: "0x0", devTokens: "0", launchFee: "0",
      launchBlock: 90, launchTime: 1, pool: null, curveT: null, stats: {}, spark: [], factory: FACTORY }],
    recent: [{ token: TOKEN, trade: { time: 2, block: 100, tx: TX, venue: "curve", side: "buy", trader: PRIVACY.address, tokens: String(1000n * E), currency: String(E), priceAfter: 1e-8 } },
      { token: TOKEN, trade: { time: 1, block: 99, tx: "0x121", venue: "curve", side: "buy", trader: BOB, tokens: String(1000n * E), currency: String(E), priceAfter: 1e-8 } }],
  };
  const fetcher = async url => (String(url).endsWith("/market.json") ? new Response(JSON.stringify(MARKET), { headers: { "content-type": "application/json" } }) : new Response("", { status: 404 }));
  const market = createHokori({ network: NETWORK, factories: [{ address: FACTORY, block: 90 }], provider: chain([]), dataUrl: "https://data.test", fetcher }).market();
  await market.poll();
  assert.equal(market.getState().error, null);
  assert.deepEqual(market.getState().recent.map(r => attributionOf(r.trade)), ["protected", "account"]);
});
