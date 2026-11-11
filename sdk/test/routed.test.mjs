// Trades routed through the TradeAdapter (src/routed.ts; plan B10): each adapter record credits the account it names
// with the trade events it matches by amounts in the same transaction: a curve buy or sell (the curve names the adapter),
// a pool trade (whoever sent it: the account or the order keeper), and a buy that crossed graduation (its curve buy and
// pool swap together), allowing for the Router's leftovers; several fills in one keeper transaction each to its own
// account. A curve trade by the adapter that no record matches is nobody's; a trade the adapter didn't route is left as
// it is; another contract's events are never records.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT, SELECTOR, parseRouted, routedAccounts } from "../src/index.ts";

const hex = v => "0x" + BigInt(v).toString(16).padStart(64, "0");
const ADAPTER = { address: hex(0xada), block: 100 }, COIN = hex(0xc0), MONEY = hex(0x5);   // MONEY < COIN: the coin is token1
const ALICE = hex(0xa11ce), BOB = hex(0xb0b), KEEPER = hex(0x4ee), TX = hex(0x7a1), TX2 = hex(0x7a2);
const u = v => [hex(BigInt(v) & ((1n << 128n) - 1n)), hex(BigInt(v) >> 128n)];
const VENUE = { curve: hex(0x6375727665n), pool: hex(0x706f6f6cn), both: hex(0x63757276652b706f6f6cn) };

/** A curve Buy { #[key] buyer, spent, fee, tokens, q, t } or Sell { #[key] seller, tokens, gross, fee, q, t }. */
const curveBuy = (tx, buyer, spent, tokens) => ({ e: { transaction_hash: tx, keys: [EVENT.BUY, buyer], data: [...u(spent), ...u(spent / 100n), ...u(tokens), ...u(1), ...u(1)] }, venue: "curve", coin: COIN });
const curveSell = (tx, seller, tokens, paid) => ({ e: { transaction_hash: tx, keys: [EVENT.SELL, seller], data: [...u(tokens), ...u(paid + 10n), ...u(10n), ...u(1), ...u(1)] }, venue: "curve", coin: COIN });
/** Core's Swapped for the pool (token0 MONEY, token1 COIN): a buy takes the coin out (negative), money in. */
const swap = (tx, buy, moneyIn, coinOut) => {
  const d = Array(16).fill(hex(0));
  d[1] = MONEY; d[2] = COIN;
  if (buy) { d[12] = hex(moneyIn); d[13] = hex(0); d[14] = hex(coinOut); d[15] = hex(1); }
  else { d[12] = hex(coinOut); d[13] = hex(1); d[14] = hex(moneyIn); d[15] = hex(0); }   // a sell: money out, coin in
  return { e: { transaction_hash: tx, keys: [EVENT.SWAPPED], data: d }, venue: "pool", coin: COIN };
};
/** The adapter's Bought { #[key] account, #[key] coin, spent, tokens, venue, budgeted } / Sold { … tokens, paid … }. */
const record = (tx, account, sell, amountIn, amountOut, venue, from = ADAPTER.address) => parseRouted({ from_address: from, transaction_hash: tx,
  keys: [sell ? SELECTOR.Sold : SELECTOR.Bought, account, COIN], data: [...u(amountIn), ...u(amountOut), VENUE[venue], hex(1)] });

test("a curve buy or sell by the adapter is the account's its record names", () => {
  const trades = [curveBuy(TX, ADAPTER.address, 10n ** 18n, 5_000n), curveSell(TX2, ADAPTER.address, 2_000n, 3n * 10n ** 17n)];
  const records = [record(TX, ALICE, false, 10n ** 18n, 5_000n, "curve"), record(TX2, BOB, true, 2_000n, 3n * 10n ** 17n, "curve")];
  assert.deepEqual(routedAccounts(trades, records, ADAPTER), [ALICE, BOB]);
});

test("a pool trade sent by the keeper is the account's, allowing for the Router's leftovers", () => {
  // The Swapped event: the pool's side. The coin is token1 here, so a buy takes token1 out.
  const sw = swap(TX, true, 7n * 10n ** 17n, 9_000n);
  sw.e.data[12] = hex(7n * 10n ** 17n); sw.e.data[13] = hex(0); sw.e.data[14] = hex(9_000n); sw.e.data[15] = hex(1);
  assert.deepEqual(routedAccounts([sw], [record(TX, ALICE, false, 7n * 10n ** 17n, 9_000n, "pool")], ADAPTER), [ALICE], "exact");
  assert.deepEqual(routedAccounts([sw], [record(TX, ALICE, false, 7n * 10n ** 17n - 3n, 9_005n, "pool")], ADAPTER), [ALICE], "leftovers: less in, more out");
  assert.deepEqual(routedAccounts([sw], [record(TX, ALICE, false, 7n * 10n ** 17n + 1n, 9_000n, "pool")], ADAPTER), [undefined], "more in than the pool took: not this trade");
});

test("a buy that crossed graduation: its curve buy and pool swap, together, are the account's", () => {
  const cb = curveBuy(TX, ADAPTER.address, 4n * 10n ** 18n, 100_000n), sw = swap(TX, true, 6n * 10n ** 18n, 20_000n);
  sw.e.data[12] = hex(6n * 10n ** 18n); sw.e.data[13] = hex(0); sw.e.data[14] = hex(20_000n); sw.e.data[15] = hex(1);
  assert.deepEqual(routedAccounts([cb, sw], [record(TX, BOB, false, 10n ** 19n, 120_000n, "both")], ADAPTER), [BOB, BOB]);
});

test("several fills in one keeper transaction: each to its own account", () => {
  const trades = [curveBuy(TX, ADAPTER.address, 10n ** 18n, 5_000n), curveBuy(TX, ADAPTER.address, 2n * 10n ** 18n, 9_000n)];
  const records = [record(TX, BOB, false, 2n * 10n ** 18n, 9_000n, "curve"), record(TX, ALICE, false, 10n ** 18n, 5_000n, "curve")];
  assert.deepEqual(routedAccounts(trades, records, ADAPTER), [ALICE, BOB]);
});

test("a curve trade by the adapter with no matching record is nobody's; a direct trade is left as it is", () => {
  const byAdapter = curveBuy(TX, ADAPTER.address, 10n ** 18n, 5_000n), direct = curveBuy(TX2, ALICE, 10n ** 18n, 5_000n);
  assert.deepEqual(routedAccounts([byAdapter, direct], [], ADAPTER), [null, undefined]);
  assert.deepEqual(routedAccounts([byAdapter], [record(TX, ALICE, false, 10n ** 18n, 4_999n, "curve")], ADAPTER), [null], "amounts that don't match");
  assert.deepEqual(routedAccounts([byAdapter], [record(TX2, ALICE, false, 10n ** 18n, 5_000n, "curve")], ADAPTER), [null], "another transaction");
  assert.deepEqual(routedAccounts([byAdapter], [record(TX, ALICE, false, 10n ** 18n, 5_000n, "curve", hex(0xbad))], ADAPTER), [null], "another contract's record");
  assert.deepEqual(routedAccounts([byAdapter], [record(TX, ALICE, false, 10n ** 18n, 5_000n, "curve")], undefined), [undefined], "no adapter deployed: nothing routed");
});

test("only the adapter's Bought and Sold with a known venue are records", () => {
  const ok = record(TX, ALICE, false, 1n, 2n, "curve");
  assert.equal(ok.account, ALICE); assert.equal(ok.coin, COIN); assert.equal(ok.venue, "curve"); assert.equal(ok.amountIn, 1n); assert.equal(ok.amountOut, 2n);
  assert.equal(parseRouted({ from_address: ADAPTER.address, transaction_hash: TX, keys: [EVENT.BUY, ALICE, COIN], data: [...u(1), ...u(2), VENUE.curve, hex(1)] }), null, "another event");
  assert.equal(parseRouted({ from_address: ADAPTER.address, transaction_hash: TX, keys: [SELECTOR.Bought, ALICE, COIN], data: [...u(1), ...u(2), hex(0x123), hex(1)] }), null, "an unknown venue");
  assert.equal(parseRouted({ from_address: ADAPTER.address, transaction_hash: TX, keys: [SELECTOR.Bought, ALICE], data: [...u(1), ...u(2), VENUE.curve, hex(1)] }), null, "short keys");
  assert.equal(parseRouted({ transaction_hash: TX, keys: [SELECTOR.Bought, ALICE, COIN], data: [...u(1), ...u(2), VENUE.curve, hex(1)] }), null, "no emitter");
});
