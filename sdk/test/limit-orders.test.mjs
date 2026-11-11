// Limit orders' prices (sdk/src/limit-orders.ts; plan B2, review spec 1): exact fractions for 18- and 8-decimal
// currencies, minimums that achieve the price and are the smallest that do, and the fill fee's place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { averagePrice, limitBuyMinOut, limitSellMinPaid, priceAtMost, priceFromText, priceText, sellNetAfterFillFee, stopLossMinPaid } from "../src/limit-orders.ts";

const E = n => 10n ** BigInt(n);

test("a typed price becomes an exact fraction of base units, for 18- and 8-decimal currencies", () => {
  assert.deepEqual(priceFromText("0.000002", 18), { num: 1n, den: 500_000n }, "2e-6 STRK per token: 1 base unit per 500,000");
  assert.deepEqual(priceFromText("0.00000001", 8), { num: 1n, den: E(18) }, "a satoshi per whole token");
  assert.deepEqual(priceFromText("4", 8), { num: 1n, den: 2_500_000_000n }, "4 ZEC per token: 4e8 per 1e18");
  assert.equal(priceText(priceFromText("0.000002", 18), 18), "0.000002");
  assert.equal(priceText(priceFromText("0.000000012345", 8), 8, 15), "0.000000012345");
  for (const bad of ["", "abc", "-1", "0", "0.000", "1e-6", "1,5", " .5", `0.${"1".repeat(37)}`])
    assert.throws(() => priceFromText(bad, 18), RangeError, JSON.stringify(bad));
});

test("a limit buy's minimum: 100 STRK at 0.000002 is 50 million tokens; it rounds up, never letting the price slip", () => {
  assert.equal(limitBuyMinOut(100n * E(18), priceFromText("0.000002", 18)), 50_000_000n * E(18));
  assert.equal(limitBuyMinOut(1n, priceFromText("1000", 18)), 1n, "a sliver still demands a whole base unit");
  assert.equal(limitBuyMinOut(12_000_000n, priceFromText("0.0000001", 8)), 1_200_000n * E(18), "0.12 BTC at 1e-7 BTC each");
  assert.throws(() => limitBuyMinOut(0n, priceFromText("1", 18)), RangeError);
});

test("a sell's minimum: tokens times the price, rounded up; the fill fee comes out of it and can't take it all", () => {
  const p = priceFromText("0.000003", 18);
  assert.equal(limitSellMinPaid(1_000_000n * E(18), p), 3n * E(18));
  assert.equal(sellNetAfterFillFee(3n * E(18), 2n * E(17)), 28n * E(17));
  assert.throws(() => sellNetAfterFillFee(3n * E(18), 3n * E(18)), /fill fee would take all/);
  assert.equal(limitSellMinPaid(1n, priceFromText("0.000000001", 8)), 1n, "a dust sell still demands a base unit");
});

test("a stop's floor may not sit above its trigger; its minimum comes from the floor", () => {
  const trigger = priceFromText("0.000002", 18), floor = priceFromText("0.0000018", 18);
  assert.equal(stopLossMinPaid(10n ** 24n, trigger, floor), limitSellMinPaid(10n ** 24n, floor));
  assert.throws(() => stopLossMinPaid(10n ** 24n, floor, trigger), /floor must be at or below/);
  assert.ok(priceAtMost(floor, trigger) && !priceAtMost(trigger, floor) && priceAtMost(trigger, trigger));
});

test("the minimums are exact: each achieves the price, and one base unit less wouldn't (random amounts, both currency sizes)", () => {
  let s = 0x9e3779b97f4a7c15n;
  const rand = (bits) => { s ^= s << 13n; s &= (1n << 64n) - 1n; s ^= s >> 7n; s ^= s << 17n; s &= (1n << 64n) - 1n; return (s % (1n << BigInt(bits))) + 1n; };
  for (let i = 0; i < 2000; i++) {
    const decimals = i % 2 ? 8 : 18;
    const price = priceFromText(`0.${String(rand(40)).padStart(20, "0")}`, decimals);
    const spend = rand(96), tokens = rand(110);
    const out = limitBuyMinOut(spend, price);
    assert.ok(priceAtMost(averagePrice(spend, out), price), "the buy's average price is at most the limit");
    assert.ok(out === 1n || !priceAtMost(averagePrice(spend, out - 1n), price), "one token less would break the limit");
    const paid = limitSellMinPaid(tokens, price);
    assert.ok(priceAtMost(price, averagePrice(paid, tokens)), "the sell's average price is at least the limit");
    assert.ok(paid === 1n || !priceAtMost(price, averagePrice(paid - 1n, tokens)), "one base unit less would break it");
  }
});
