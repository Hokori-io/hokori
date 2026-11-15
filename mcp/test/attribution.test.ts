// recent_trades through a real SDK client on a scripted chain, as the server runs with no market-data service (it once
// named the TradeAdapter as the trader of a routed trade, and called a
// protected trade an account's). A routed trade names the account its record names; one without its record names no
// one and is "unknown"; a protected trade names no one; a direct trade names its trader. The SDK's scripted chain
// (sdk/test/fake-chain.mjs) is shared with the SDK's own tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT, NETWORKS, SELECTOR, byteArrayFelts, createHokori } from "@hokoridotio/sdk";
import { hokoriTools } from "../tools.ts";

const FAKE_CHAIN = "../../sdk/test/fake-chain.mjs";
const { CURVE, FACTORY, P, TOKEN, hex, provider, u } = await import(FAKE_CHAIN);

const E = 10n ** 18n, TX = "0x123", ALICE = hex(0xa11ce), BOB = hex(0xb0b);
const ADAPTER = { ...NETWORKS.mainnet.tradeAdapter!, block: 0 };
const PRIVACY = { address: hex(0xabcd), factory: FACTORY, block: 0 };
const NETWORK = { ...NETWORKS.mainnet, tradeAdapter: ADAPTER, privacy: { ...NETWORKS.mainnet.privacy!, adapters: [PRIVACY] } };
type Event = { from_address: string; transaction_hash: string; block_number: number; keys: string[]; data: string[] };
const felts = (s: string) => byteArrayFelts(s).map(hex) as string[];
const LAUNCH: Event = { from_address: FACTORY, transaction_hash: "0x122", block_number: 90, keys: [EVENT.LAUNCH, TOKEN, "0xc0"],
  data: [CURVE, "0x0", ...felts("Test"), ...felts("TST"), ...felts("ar://fixture"), ...u(0n), ...u(0n), ...u(0n), ...u(0n)] };
const buy = (buyer: string, tx = TX): Event => ({ from_address: CURVE, transaction_hash: tx, block_number: 100, keys: [EVENT.BUY, buyer],
  data: [...u(E), ...u(E / 100n), ...u(1000n * E), ...u(31n * E), ...u(P.t0 - 1000n * E)] });
const bought = (account: string): Event => ({ from_address: ADAPTER.address, transaction_hash: TX, block_number: 100, keys: [SELECTOR.Bought, account, TOKEN],
  data: [...u(E), ...u(1000n * E), "0x6375727665", "0x1"] });
const shielded: Event = { from_address: PRIVACY.address, transaction_hash: "0x124", block_number: 100, keys: [SELECTOR.ProtectedTrade, TOKEN], data: ["0x0", "0x0", hex(E), hex(1000n * E)] };

async function recentTrades(events: Event[]) {
  const p = provider({ head: 100, launchBlock: 90, chainId: NETWORKS.mainnet.chainId });
  const chain = { ...p, async getEvents(q: { address: string }) { return { events: [LAUNCH, ...events].filter(e => BigInt(e.from_address) === BigInt(q.address)) }; } };
  const h = createHokori({ network: NETWORK, factories: [{ address: FACTORY, block: 90 }], provider: chain, fetcher: async () => new Response("{}") });
  const r = await hokoriTools(h).find(t => t.name === "recent_trades")!.run({}) as { trades: { trader: string | null; attribution: string; tx: string }[] };
  return Object.fromEntries(r.trades.map(t => [t.tx, { trader: t.trader === null ? null : BigInt(t.trader), attribution: t.attribution }]));
}

test("recent_trades from the chain: routed, unproven, protected and direct trades", async () => {
  const routed = await recentTrades([buy(ADAPTER.address), bought(ALICE)]);
  assert.deepEqual(routed[TX], { trader: BigInt(ALICE), attribution: "account" }, "the account the adapter's record names");
  const unproven = await recentTrades([buy(ADAPTER.address)]);
  assert.deepEqual(unproven[TX], { trader: null, attribution: "unknown" }, "no record: nobody's, not the adapter's");
  const mixed = await recentTrades([buy(PRIVACY.address, "0x124"), shielded, buy(BOB, "0x125")]);
  assert.deepEqual(mixed["0x124"], { trader: null, attribution: "protected" });
  assert.deepEqual(mixed["0x125"], { trader: BigInt(BOB), attribution: "account" });
});
