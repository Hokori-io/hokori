// The BTC launchpad (8 Nov 2026): the agent tools read BTC's dollar price from the market-data service's price.json
// (`btc`, beside `zec`), so strkBTC coins get dollar figures and sort across currencies like the others.
import { test } from "node:test";
import assert from "node:assert/strict";
import { usdFromService } from "../tools.ts";

test("usdFromService reads STRK's, ZEC's and BTC's prices, each only while fresh", async () => {
  const now = 1_700_000_000_000;
  const file = { usd: 0.0395, at: now - 5_000, zec: { usd: 1_260, at: now - 5_000 }, btc: { usd: 75_726, at: now - 5_000 } };
  const fetcher = (async () => new Response(JSON.stringify(file), { status: 200 })) as unknown as typeof fetch;
  assert.deepEqual(await usdFromService("https://data.test", fetcher, () => now)(), { STRK: 0.0395, ZEC: 1_260, BTC: 75_726 });
  const stale = { ...file, btc: { usd: 75_726, at: now - 11 * 60_000 } };
  const old = (async () => new Response(JSON.stringify(stale), { status: 200 })) as unknown as typeof fetch;
  assert.deepEqual(await usdFromService("https://data.test", old, () => now)(), { STRK: 0.0395, ZEC: 1_260 }, "an old BTC price is left out");
  const without = (async () => new Response(JSON.stringify({ usd: 0.04, at: now }), { status: 200 })) as unknown as typeof fetch;
  assert.deepEqual(await usdFromService("https://data.test", without, () => now)(), { STRK: 0.04 }, "a service without btc: STRK alone");
});
