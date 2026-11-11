// The public trading-bot example (examples/trade-bot.ts): its amounts, balance and fee check are
// STRK's, so a coin of the ZEC or BTC launchpad is refused before anything is quoted, a key is read or anything is
// signed (the key file named here doesn't exist: reading it would fail the test). A STRK coin is quoted as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NETWORKS, STRKBTC_MAINNET, ZEC_MAINNET } from "../src/index.ts";
import { main } from "../examples/trade-bot.ts";
import { FACTORY, TOKEN, provider } from "./fake-chain.mjs";

const network = { ...NETWORKS.sepolia, factories: [{ address: FACTORY, block: 0 }] };
const run = async (argv, chain) => {
  const logs = [], errors = [];
  const code = await main(argv, { provider: chain, network, log: s => logs.push(s), error: s => errors.push(s) });
  return { code, logs, errors };
};
const TRADE = ["--token", TOKEN, "--strk", "5", "--account", "0x1", "--key-file", "/no/such/key-file"];

test("a coin paid in ZEC or strkBTC is refused before anything is quoted, a key is read or anything is signed", async () => {
  for (const currency of [ZEC_MAINNET, STRKBTC_MAINNET]) {
    const r = await run(TRADE, provider({ head: 200, currency: currency.address }));
    assert.equal(r.code, 1, currency.symbol);
    assert.match(r.errors.join("\n"), /only coins paid in STRK/);
    assert.match(r.errors.join("\n"), /Nothing was quoted or signed/);
    assert.deepEqual(r.logs, [], `${currency.symbol}: nothing quoted`);
  }
});

test("a STRK coin is quoted as before (dry run)", async () => {
  const r = await run(["--token", TOKEN, "--strk", "5", "--dry-run"], provider({ head: 200 }));
  assert.equal(r.code, 0, r.errors.join("\n"));
  assert.match(r.logs[0], /^5 STRK buys .* tokens \(at least .*\), fee .* STRK, curve$/);
});
