// Protected trades (src/protected.ts): trades made through Hokori's privacy adapters from Starknet's privacy pool carry
// no trader. The adapters as deployed, the privacy pool among a coin's holders, and trades published without an
// attribution. protected-p1b.test.mjs (private) checks provenance on recorded mainnet trades.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NETWORKS, NO_TRADER, ONE, adapterFor, attributionOf, hasTrader, holdersFromJson, legacyAttribution, protocolHolders, shieldedSupply, summarizeHolders } from "../src/index.ts";

const MAIN = NETWORKS.mainnet, ADAPTERS = MAIN.privacy.adapters;
const LAUNCH = "0x3887d1565b079265b5886a33243920515a966e50c8f38f0812552b4b44ad8c7", ZEC_LAUNCHPAD = "0x0447640e0c2e0f20d4c4215c85e3be73bfc4e1c2abd574e0ac081fbaa7bf74ad";

test("the adapters and the pool: full addresses, each adapter pinned to its own factory", () => {
  for (const n of [NETWORKS.mainnet, NETWORKS.sepolia]) {
    assert.match(n.privacy.pool, /^0x[0-9a-f]{64}$/);
    for (const a of n.privacy.adapters) { assert.match(a.address, /^0x[0-9a-f]{64}$/); assert.match(a.factory, /^0x[0-9a-f]{64}$/); assert.ok(a.block > 0); }
  }
  assert.equal(adapterFor(ADAPTERS, LAUNCH), "0x06fa392236b7e0439f89b1cbd1f2e959cf767e6b86bdeb72e2ca503d18513015");
  assert.equal(adapterFor(ADAPTERS, ZEC_LAUNCHPAD), "0x043596a87ecd0c96299064d2c30d56c76db1bb0d32537dba9c80f8c0cade1b75");
  assert.equal(adapterFor(ADAPTERS, "0x123"), null, "a factory with no adapter: no protected trading for its coins");
  assert.equal(adapterFor(undefined, LAUNCH), null);
});

const hex = v => "0x" + BigInt(v).toString(16).padStart(64, "0");
const ALICE = hex(0xa1);

test("holders: the privacy pool is labelled, not a holder, not one whale, and its balance is the shielded supply", () => {
  const POOL = MAIN.privacy.pool;
  const balances = new Map([[hex(POOL), 600n * ONE], [ALICE, 100n * ONE], [hex(0xb0b), 50n * ONE]]);
  const protocol = protocolHolders({ curve: hex(0xcc), privacy: POOL });
  const h = summarizeHolders(balances, protocol);
  assert.equal(h.count, 2, "the pool isn't counted as a holder");
  assert.equal(h.top[0].label, "privacy");
  assert.equal(shieldedSupply(h.top), 600n * ONE);
  const parsed = holdersFromJson({ count: 2, atBlock: 1, burned: "0", top: h.top.map(x => ({ ...x, balance: String(x.balance) })) });
  assert.equal(parsed.top[0].label, "privacy", "the published label is accepted");
});

// A data service on older code publishes no attribution, and names the adapter as a protected trade's trader. A reader
// with the adapters shows such a trade as protected; every other trade is left as it was.
test("a trade published without attribution, by a pinned adapter, reads as protected", () => {
  const launchAdapter = adapterFor(ADAPTERS, LAUNCH);
  const trade = { block: 1, tx: "0x1", venue: "curve", side: "buy", trader: launchAdapter, tokens: ONE, currency: 1n, priceAfter: 1, time: 1 };
  const shown = legacyAttribution(trade, ADAPTERS);
  assert.equal(attributionOf(shown), "protected"); assert.equal(hasTrader(shown), false); assert.equal(shown.trader, NO_TRADER);
  const person = { ...trade, trader: "0xa11ce" };
  assert.equal(legacyAttribution(person, ADAPTERS), person, "an account's trade is untouched");
  const published = { ...trade, attribution: "account" };
  assert.equal(legacyAttribution(published, ADAPTERS), published, "an attribution the service published is kept");
  assert.equal(legacyAttribution(trade, undefined), trade, "without the adapters, nothing changes");
  assert.equal(attributionOf(legacyAttribution({ ...trade, trader: "0x" + "0".repeat(2) + launchAdapter.slice(2) }, ADAPTERS)), "protected", "leading zeros don't matter");
});
