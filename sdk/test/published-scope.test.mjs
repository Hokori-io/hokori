// Account and coin readers against a service following more launchpads than the reader: the
// reader keeps only its own launchpads' coins. A coin file of another factory, or one that doesn't say its factory when
// the service follows others, is refused; an account file is scoped by its coin-to-factory map, in every list and the
// trade count, and refused when it would need the map and has none; a service following exactly the reader's
// launchpads is read as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NETWORKS, PublishedUnavailable, createPublishedAccount, createPublishedTrades } from "../src/index.ts";

const now = Date.now(), CHAIN = NETWORKS.mainnet.chainId;
const pad = v => "0x" + BigInt(v).toString(16).padStart(64, "0");
const ACCOUNT = pad(0xa), MINE = pad(0xb1), OTHERS = pad(0xb2);
const position = (token, buys, sells) => ({ token, bought: "100", sold: "50", tokensBought: "10", tokensSold: "5", buys, sells });
const holding = (token, name) => ({ token, balance: "1000000000000000000", name, symbol: name.toUpperCase().slice(0, 5) });
const launch = token => ({ token, name: "x", symbol: "X", launchTime: 1, graduated: false });
const payee = token => ({ token, name: "x", symbol: "X", launchTime: 1, shareBps: 5_000, payees: 2 });

/** A service's files: `id` its identity (the factories it follows), the account file and coin files. */
function service(id, { coinFactories, coinFactory = {} } = {}) {
  const status = { ...id, indexedBlock: 100, lastSuccessAt: now };
  const account = { ...id, account: ACCOUNT, updatedAt: now, indexedBlock: 100,
    holdings: [holding(MINE, "mine"), holding(OTHERS, "others")], trades: [], tradeCount: 12,
    positions: [position(MINE, 3, 2), position(OTHERS, 4, 3)], launched: [launch(MINE), launch(OTHERS)], payeeOf: [payee(MINE), payee(OTHERS)],
    ...(coinFactories ? { coinFactories } : {}) };
  const coin = token => ({ ...id, updatedAt: now, indexedBlock: 100, coin: { token, ...(coinFactory[token] ? { factory: coinFactory[token] } : {}) }, trades: [] });
  return async url => {
    const path = new URL(url).pathname;
    const body = path.endsWith("/status.json") ? status : path.includes("/accounts/") ? account : coin(path.match(/coins\/(0x[0-9a-f]+)\.json/)[1]);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}
const BOTH = { factory: "0x1", factories: ["0x1", "0x2"], chainId: CHAIN };
const reader = fetcher => ({ url: "https://fixture.invalid", factories: ["0x1"], chainId: CHAIN, fetcher, now: () => now });

test("a coin file of another factory is refused; one of the reader's own is read", async () => {
  const fetcher = service(BOTH, { coinFactory: { [MINE]: "0x1", [OTHERS]: "0x2" } });
  await assert.rejects(createPublishedTrades({ ...reader(fetcher), token: OTHERS }).update(0), e => e instanceof PublishedUnavailable && /doesn't follow/.test(e.message));
  const mine = createPublishedTrades({ ...reader(fetcher), token: MINE });
  await mine.update(0);
  assert.equal(mine.document.coin.factory, "0x1");
});

test("a coin file that doesn't say its factory is refused from a service following others, read from one that doesn't", async () => {
  await assert.rejects(createPublishedTrades({ ...reader(service(BOTH)), token: MINE }).update(0), PublishedUnavailable);
  const only = service({ factory: "0x1", factories: ["0x1"], chainId: CHAIN });
  const r = createPublishedTrades({ ...reader(only), token: MINE });
  await r.update(0);
  assert.ok(r.document);
});

test("an account file is scoped by its coin-to-factory map, in every list and the trade count", async () => {
  const acc = createPublishedAccount({ ...reader(service(BOTH, { coinFactories: { [MINE]: "0x1", [OTHERS]: "0x2" } })), address: ACCOUNT });
  await acc.update();
  for (const [name, list] of Object.entries({ holdings: acc.holdings, positions: acc.positions, launched: acc.launched, payeeOf: acc.payeeOf }))
    assert.deepEqual(list.map(x => x.token), [MINE], name);
  assert.equal(acc.tradeCount, 5, "the kept coin's buys and sells, not the file's 12");
});

test("an account file that would need the map and has none is refused; one from a service following only the reader's launchpads is read whole", async () => {
  await assert.rejects(createPublishedAccount({ ...reader(service(BOTH)), address: ACCOUNT }).update(), e => e instanceof PublishedUnavailable && /which of the account's coins/.test(e.message));
  const only = createPublishedAccount({ ...reader(service({ factory: "0x1", factories: ["0x1"], chainId: CHAIN })), address: ACCOUNT });
  await only.update();
  assert.equal(only.holdings.length, 2, "nothing else can be in it");
  assert.equal(only.tradeCount, 12);
});
