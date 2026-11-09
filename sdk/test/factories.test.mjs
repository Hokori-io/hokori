// Several launch factories: a client follows a list, oldest first; new launches go to the newest; a
// coin is read through the factory that launched it; published data is accepted only for exactly the followed set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHokori } from "../src/client.ts";
import { acceptsFactories, followsCoin } from "../src/data-feed.ts";
import { NETWORKS, historyStart, launchFactory, launchpadsOf, networkFactories } from "../src/networks.ts";
import { readCoin, resolveFactory } from "../src/reads.ts";
import { FACTORY, OTHER_FACTORY, TOKEN, provider } from "./fake-chain.mjs";

const two = { ...NETWORKS.sepolia, factories: [{ address: OTHER_FACTORY, block: 10 }, { address: FACTORY, block: 50 }] };

test("the newest factory takes launches; history starts at the oldest", () => {
  assert.equal(launchFactory(two)?.address, FACTORY);
  assert.equal(historyStart(two.factories), 10);
  assert.equal(launchFactory({ factories: [] }), null);
});

test("a coin is read through the factory that launched it, found after the head read; an unknown coin is refused", async () => {
  const chain = provider({ head: 200 });
  assert.equal(BigInt(await resolveFactory(chain, [OTHER_FACTORY, FACTORY], TOKEN)), BigInt(FACTORY));
  assert.equal(await resolveFactory(chain, [OTHER_FACTORY], TOKEN), null);
  const h = createHokori({ network: two, provider: chain });
  assert.equal(h.factory.address, FACTORY, "launches go to the newest");
  assert.equal(h.factories.length, 2);
  const before = chain.calls.length;
  const coin = await h.coin(TOKEN);
  assert.equal(BigInt(coin.factory), BigInt(FACTORY));
  // The watermark precedes every state read, the factory lookups included.
  const lookups = chain.calls.slice(before).filter(c => c.entrypoint === "curve_of");
  assert.equal(lookups.length, 2, "each followed factory was asked, once");
  assert.ok(lookups.every(c => c.headRead), "the head was read before any factory was asked");
  assert.equal(BigInt(await h.factoryOf(TOKEN)), BigInt(FACTORY));
  await assert.rejects(h.coin("0x999"), /unknown token/);
  await assert.rejects(readCoin(chain, { factories: [OTHER_FACTORY], token: TOKEN, currency: NETWORKS.sepolia.strk, ekubo: NETWORKS.sepolia.ekubo }), /unknown token/);
  // Once known, the coin's factory isn't asked again.
  const asked = chain.calls.filter(c => c.entrypoint === "curve_of").length;
  await h.coin(TOKEN);
  assert.equal(chain.calls.filter(c => c.entrypoint === "curve_of").length, asked);
});

test("by default every launchpad is followed, as the market-data service follows them; launches stay on the STRK factory", () => {
  const main = NETWORKS.mainnet, STRK_LAUNCH = BigInt("0x3887d1565b079265b5886a33243920515a966e50c8f38f0812552b4b44ad8c7");
  const ZEC = BigInt("0x0447640e0c2e0f20d4c4215c85e3be73bfc4e1c2abd574e0ac081fbaa7bf74ad");
  const BTC = BigInt("0x04511f2c14c3e074f2003cb90d6390e1fd30e8b5f42ddbacf49b02edb4415c69");
  assert.deepEqual(networkFactories(main).map(f => BigInt(f.address)), [STRK_LAUNCH, ZEC, BTC], "oldest first");
  assert.equal(BigInt(launchFactory(main).address), STRK_LAUNCH);
  assert.equal(BigInt(launchFactory(main, "ZEC").address), ZEC);
  assert.equal(BigInt(launchFactory(main, "BTC").address), BTC);
  assert.equal(launchFactory(main, "ETH"), null);
  // What data.hokori.io published on 9 Nov 2026 (market.json, format 6): its launch factory, and the three launchpads'.
  const published = { factory: "0x03887d1565b079265b5886a33243920515a966e50c8f38f0812552b4b44ad8c7",
    factories: ["0x447640e0c2e0f20d4c4215c85e3be73bfc4e1c2abd574e0ac081fbaa7bf74ad", "0x4511f2c14c3e074f2003cb90d6390e1fd30e8b5f42ddbacf49b02edb4415c69", "0x3887d1565b079265b5886a33243920515a966e50c8f38f0812552b4b44ad8c7"] };
  assert.ok(acceptsFactories(published, { factories: networkFactories(main).map(f => f.address) }));
  assert.ok(acceptsFactories(published, { factories: networkFactories(main).map(f => f.address), match: "exact" }), "exactly: the same three");
  assert.equal(acceptsFactories(published, { factories: main.factories.map(f => f.address), match: "exact" }), false, "exactly: the STRK launchpad alone is refused");
  assert.ok(acceptsFactories(published, { factories: main.factories.map(f => f.address) }), "by default it is read, its STRK coins only");
  // An SDK from before the BTC launchpad (STRK and ZEC) still reads the service that follows it too: the default.
  assert.ok(acceptsFactories(published, { factories: networkFactories(main).map(f => f.address).filter(a => BigInt(a) !== BTC) }));
  const h = createHokori({ network: "mainnet", provider: provider({ head: 1 }) });
  assert.equal(BigInt(h.factory.address), STRK_LAUNCH, "new launches go to the STRK launch factory");
  assert.equal(h.factories.length, 3);
  assert.equal(historyStart(h.factories), 17045147);
  // Sepolia: the two STRK test factories and the test ZEC launchpad; test launches on v4.
  const s = createHokori({ network: "sepolia", provider: provider({ head: 1 }) });
  assert.equal(s.factories.length, 3);
  assert.equal(BigInt(s.factory.address), BigInt(NETWORKS.sepolia.factories[1].address));
});

test("a copy of a network with factories of its own follows exactly those", () => {
  assert.deepEqual(networkFactories(two).map(f => f.address), [OTHER_FACTORY, FACTORY]);
  assert.equal(launchFactory(two, "ZEC"), null, "the original's other launchpads aren't carried over");
  assert.equal(launchFactory({ factories: [{ address: FACTORY, block: 1 }] })?.address, FACTORY, "a site's own list");
  assert.deepEqual(launchpadsOf({ factories: [] }), [{ currency: "STRK", factories: [] }]);
});

test("published data: the followed factories must all be the service's, under either rule", () => {
  const A = "0x0a", B = "0x0b";
  for (const match of ["includes", "exact"]) {
    assert.ok(acceptsFactories({ factory: B, factories: [A, B] }, { factories: [A, B], match }), match);
    assert.ok(acceptsFactories({ factory: B, factories: ["0x000b", "0x0a"] }, { factories: [A, B], match }), `${match}: any order, any padding`);
    assert.ok(acceptsFactories({ factory: A }, { factory: A, match }), `${match}: a service from before format 6 names one factory`);
    assert.ok(acceptsFactories({ factory: A }, { factories: [A], match }));
    assert.equal(acceptsFactories({ factory: A }, { factories: [A, B], match }), false, `${match}: a reader following more than the service does`);
    assert.equal(acceptsFactories({ factory: "0xbad", factories: [A, B] }, { factories: [A, B], match }), false, `${match}: a forged launch factory`);
    assert.equal(acceptsFactories({ factory: B, factories: [A, "0xbad"] }, { factories: [A, B], match }), false, match);
    assert.ok(acceptsFactories({ factory: "0xbad" }, { match }), `${match}: a reader following nothing in particular accepts anything`);
  }
});

test("a service following more launchpads: accepted by default (its other coins are left out), refused by the site's exact rule", () => {
  const A = "0x0a", B = "0x0b", C = "0x0c";
  // The day the service follows a third launchpad, a reader of the two before keeps reading.
  assert.ok(acceptsFactories({ factory: A, factories: [A, B, C] }, { factories: [A, B] }), "the default is includes");
  assert.ok(acceptsFactories({ factory: C, factories: [A, B, C] }, { factories: [A, B], match: "includes" }), "the service's launch factory may be one the reader doesn't follow");
  assert.equal(acceptsFactories({ factory: A, factories: [A, B, C] }, { factories: [A, B], match: "exact" }), false, "the site's rule");
  assert.equal(acceptsFactories({ factory: B, factories: [A, B] }, { factories: [B], match: "exact" }), false, "exact: or fewer");
  assert.equal(acceptsFactories({ factory: C, factories: [A, "0xbad"] }, { factories: [A] }), false, "includes: a launch factory the service doesn't name is forged");
  // Which coins a reader keeps.
  assert.ok(followsCoin({ factory: "0x000a" }, { factories: [A, B] }));
  assert.equal(followsCoin({ factory: C }, { factories: [A, B] }), false, "a coin of a launchpad the reader doesn't follow");
  assert.ok(followsCoin({}, { factories: [A] }), "a coin published without its factory (before format 6)");
  assert.ok(followsCoin({ factory: C }, {}), "a reader following nothing in particular keeps every coin");
});
