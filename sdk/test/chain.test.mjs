// The SDK's chain-facing pieces with no chain: reads decoded from the contracts' layouts (against a scripted provider),
// launch calls, metadata built and checked by SHA-256, and the network list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ONE, byteArrayFromFelts, ekuboFeeFor } from "../src/index.ts";
import { decodeCurveParams, decodeCurveState, isUnknownToken, readCoin, readFactory, readPayees, claimFeeCalls } from "../src/reads.ts";
import { NETWORKS, networkOf } from "../src/networks.ts";
import { launchCalls } from "../src/launch-calls.ts";
import { coinMetadata, fetchMetadata, sha256Of, MAX_METADATA_BYTES } from "../src/metadata.ts";
import { CORE, CURVE, FACTORY, LOCKER, P, STRK, TOKEN, VAULT, hex, paramsFelts, provider, u } from "./fake-chain.mjs";

test("struct decoding follows the contracts' layouts", () => {
  assert.deepEqual(decodeCurveParams(paramsFelts(P)), P);
  const s = decodeCurveState([...u(7n), ...u(8n), ...u(9n), ...u(10n), ...u(11n), "0x1", "0x0", "0x4000"]);
  assert.deepEqual(s, { q: 7n, t: 8n, sold: 9n, real: 10n, fees: 11n, open: true, graduated: false, locker: hex(0x4000) });
  assert.throws(() => decodeCurveState(["0x1"]), /CurveState/);
});

test("readCoin reads the watermark first, then the coin from the factory you trust; a graduated coin with its pool", async () => {
  const net = { router: NETWORKS.sepolia.ekubo.router, coreVersion: "v4" };
  const curve = provider();
  const c = await readCoin(curve, { factory: FACTORY, token: TOKEN, currency: STRK, ekubo: net });
  assert.ok(curve.calls.every(x => x.headRead), "the head is read before any state");
  assert.equal(c.curve, hex(CURVE)); assert.equal(c.creator, hex(0xc0)); assert.equal(c.devTokens, 5n * ONE); assert.equal(c.metadataUri, "ar://meta");
  assert.deepEqual(c.params, P); assert.equal(c.state.sold, 73_000_000n * ONE); assert.equal(c.pool, null);
  assert.equal(c.buyFeeBps, 9900n, "a buy sent now lands in block 101 at the earliest: still in the window (blocks 100 and 101)");
  assert.equal(c.route.locker, hex(LOCKER)); assert.equal(BigInt(c.route.fee), ekuboFeeFor(90n)); assert.equal(c.route.coinIsToken0, true);
  const g = await readCoin(provider({ graduated: true, head: 500 }), { factory: FACTORY, token: TOKEN, currency: STRK, ekubo: net });
  assert.equal(g.pool.sqrtRatio, 1n << 127n); assert.equal(g.pool.liquidity, 0x1234n); assert.equal(g.pool.core, "v4"); assert.equal(g.buyFeeBps, 90n);
  await assert.rejects(readCoin(provider(), { factory: FACTORY, token: "0xbad", currency: STRK, ekubo: net }), e => isUnknownToken(e));
});

test("readFactory: the settings, the vault's protocol share, Core through the locker; no cap on an older factory", async () => {
  const f = await readFactory(provider(), FACTORY);
  assert.deepEqual(f.params, P); assert.equal(f.protocolBps, 1500); assert.equal(f.core, hex(CORE)); assert.equal(f.poolFee, ekuboFeeFor(90n));
  assert.deepEqual(f.addressRule, { suffix: 0xdabn, digits: 3 }); assert.equal(f.maxDevTokens, 99_900_000n * ONE); assert.equal(f.protocol, hex(0x7ea));
  assert.equal((await readFactory(provider({ maxDev: false }), FACTORY)).maxDevTokens, null);
});

test("payees and the claim's calls", async () => {
  const r = await readPayees(provider(), VAULT, TOKEN);
  assert.equal(r.protocolBps, 1500n);
  assert.deepEqual(r.payees, [{ address: hex(0xa1), bps: 6000n }, { address: hex(0xa2), bps: 4000n }]);
  const coin = { token: TOKEN, curve: CURVE, vault: VAULT, state: { fees: 5n }, route: { locker: LOCKER } };
  assert.deepEqual(claimFeeCalls(coin, 3n).map(c => c.entrypoint), ["flush_fees", "collect_fees", "claim"]);
  assert.deepEqual(claimFeeCalls({ ...coin, state: { fees: 0n } }, 0n).map(c => c.entrypoint), ["claim"]);
});

test("launch calls: one exact approval only when something is paid, then launch with the factory's argument order", () => {
  const base = { factory: FACTORY, currency: STRK, name: "Blip ☀", symbol: "BLIP", metadataUri: "ar://x", metadataSha256: (1n << 200n) + 5n,
    payees: [{ address: "0xa1", bps: 10_000 }], devBuy: 0n, minDevTokens: 0n, launchFee: 0n, salt: 77n, deadline: 1_900_000_000 };
  const free = launchCalls(base);
  assert.deepEqual(free.map(c => c.entrypoint), ["launch"], "no fee and no dev buy: nothing to approve");
  const felts = free[0].calldata.map(BigInt);
  const name = byteArrayFromFelts(free[0].calldata, 0), symbol = byteArrayFromFelts(free[0].calldata, name.next), uri = byteArrayFromFelts(free[0].calldata, symbol.next);
  assert.deepEqual([name.text, symbol.text, uri.text], ["Blip ☀", "BLIP", "ar://x"], "any UTF-8 name");
  const at = uri.next;
  assert.equal(felts[at] + (felts[at + 1] << 128n), base.metadataSha256);
  assert.deepEqual(felts.slice(at + 2), [1n, 0xa1n, 1n, 10_000n, 0n, 0n, 0n, 0n, 77n, 1_900_000_000n]);
  const paid = launchCalls({ ...base, devBuy: 3n * ONE, minDevTokens: 1n, launchFee: 2n * ONE });
  assert.deepEqual(paid[0], { contractAddress: STRK, entrypoint: "approve", calldata: ["0xfac", "0x" + (5n * ONE).toString(16), "0x0"] });
  assert.throws(() => launchCalls({ ...base, payees: [] }), /payee/);
});

test("metadata: deterministic bytes and SHA-256; fetched copies are checked, capped and never trusted", async () => {
  assert.equal(await sha256Of(new TextEncoder().encode("abc")), 0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015adn);
  const o = { name: " Blip ", symbol: "BLIP", description: "a coin", imageId: "img", imageType: "image/png", links: { x: "https://x.com/blip" },
    payees: [{ address: "0xa1", bps: 10_000, name: "Dev" }], chainId: "0x534e5f5345504f4c4941" };
  const a = await coinMetadata(o), b = await coinMetadata(o);
  assert.equal(a.json, b.json); assert.equal(a.sha256, b.sha256);
  assert.deepEqual(Object.keys(JSON.parse(a.json)), ["schema", "chain", "name", "symbol", "description", "image", "image_type", "links", "payees"]);
  const served = body => async () => new Response(body);
  const ok = await fetchMetadata("ar://meta", a.sha256, { gateway: "https://gw.test", fetcher: served(a.bytes) });
  assert.equal(ok.problem, null); assert.equal(ok.meta.name, "Blip"); assert.equal(ok.meta.image, "https://gw.test/img"); assert.equal(ok.meta.payeeLabels[hex(0xa1)], "Dev");
  assert.match((await fetchMetadata("ar://meta", a.sha256 + 1n, { gateway: "https://gw.test", fetcher: served(a.bytes) })).problem, /doesn't match/);
  assert.match((await fetchMetadata("ar://meta", a.sha256, { gateway: "https://gw.test", fetcher: served(new Uint8Array(MAX_METADATA_BYTES + 1)) })).problem, /too large/);
  assert.match((await fetchMetadata("https://evil.test/x", a.sha256, { gateway: "https://gw.test", fetcher: served(a.bytes) })).problem, /Unknown metadata link/);
});

test("networks: chain IDs map back; mainnet lists the launch factory (28 Oct 2026)", () => {
  assert.equal(networkOf("0x534e5f5345504f4c4941")?.name, "sepolia");
  assert.equal(networkOf(NETWORKS.mainnet.chainId)?.name, "mainnet");
  assert.equal(networkOf("0x1"), null);
  assert.deepEqual(NETWORKS.mainnet.factories, [{ address: "0x3887d1565b079265b5886a33243920515a966e50c8f38f0812552b4b44ad8c7", block: 17045147 }]);
  assert.equal(NETWORKS.sepolia.ekubo.coreVersion, "v4"); assert.equal(NETWORKS.mainnet.ekubo.coreVersion, "v5");
});
