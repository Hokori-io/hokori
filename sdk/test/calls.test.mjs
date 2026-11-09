import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCurveTradeCalls, buildEkuboTradeCalls, callFingerprint, ekuboPoolKey, ekuboFeeFor, orderCalls, MIN_SQRT_RATIO, MAX_SQRT_RATIO } from "../src/index.ts";

const U128 = 1n << 128n;
const base = { coin: "0x10", currency: "0x20", extension: "0x30", router: "0x40", curve: "0x50",
  fee: ekuboFeeFor(70), amount: 123n, minReceive: 99n, deadline: 1_000n, side: "buy" };
const val = (a, i) => BigInt(a[i]) + (BigInt(a[i + 1]) << 128n);

test("curve builders keep exact approval, amount, minimum and deadline, including u256 high words", () => {
  for (const side of ["buy", "sell"]) {
    const amount = U128 + 17n, minimum = U128 * 2n + 9n;
    const calls = buildCurveTradeCalls({ ...base, side, amount, minReceive: minimum });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].contractAddress, side === "buy" ? "0x20" : "0x10");
    assert.equal(calls[0].entrypoint, "approve");
    assert.equal(calls[0].calldata[0], "0x50");
    assert.equal(val(calls[0].calldata, 1), amount);
    assert.equal(calls[1].contractAddress, "0x50");
    assert.equal(calls[1].entrypoint, side);
    assert.deepEqual(calls[1].calldata, ["0x11", "0x1", "0x9", "0x2", "0x3e8"]);
  }
});

test("pool builders protect and settle both directions with either address ordering", () => {
  for (const [coin, currency] of [["0x10", "0x20"], ["0x20", "0x10"]]) for (const side of ["buy", "sell"]) {
    const calls = buildEkuboTradeCalls({ ...base, coin, currency, side });
    const input = side === "buy" ? currency : coin, output = side === "buy" ? coin : currency;
    assert.deepEqual(calls.map(c => c.entrypoint), ["check_deadline", "transfer", "swap", "clear_minimum", "clear"]);
    assert.deepEqual(calls[0], { contractAddress: "0x30", entrypoint: "check_deadline", calldata: ["0x3e8"] });
    assert.deepEqual(calls[1], { contractAddress: input, entrypoint: "transfer", calldata: ["0x40", "0x7b", "0x0"] });
    assert.deepEqual(calls[2].calldata.slice(0, 5), ["0x10", "0x20", `0x${base.fee.toString(16)}`, "0x4e20", "0x30"]);
    assert.equal(val(calls[2].calldata, 5), BigInt(input) > BigInt(output) ? MAX_SQRT_RATIO : MIN_SQRT_RATIO);
    assert.deepEqual(calls[2].calldata.slice(7), ["0x0", input, "0x7b", "0x0"]);
    assert.deepEqual(calls[3], { contractAddress: "0x40", entrypoint: "clear_minimum", calldata: [output, "0x63", "0x0"] });
    assert.deepEqual(calls[4], { contractAddress: "0x40", entrypoint: "clear", calldata: [input] });
  }
});

test("address spelling never changes the pool key or swap direction", () => {
  const variant = { ...base, coin: "0X0010".toLowerCase(), currency: 32n, extension: 48 };
  assert.deepEqual(ekuboPoolKey(variant), ekuboPoolKey(base));
  assert.deepEqual(buildEkuboTradeCalls(variant), buildEkuboTradeCalls(base));
});

test("builders refuse missing route fields, zero protection, overflow and imprecise numbers", () => {
  for (const build of [buildCurveTradeCalls, buildEkuboTradeCalls]) {
    for (const patch of [{ side: "swap" }, { coin: 0 }, { currency: 0 }, { currency: base.coin },
      { amount: 0 }, { amount: -1 }, { amount: 2 ** 60 }, { amount: 1n << 256n },
      { minReceive: 0 }, { minReceive: 1n << 256n }, { deadline: 0 }, { deadline: 1n << 64n },
      { coin: 1n << 251n }, { amount: "1.5" }]) assert.throws(() => build({ ...base, ...patch }));
  }
  for (const patch of [{ amount: U128 }, { fee: U128 }, { fee: -1 }, { extension: undefined }, { router: undefined }])
    assert.throws(() => buildEkuboTradeCalls({ ...base, ...patch }));
  assert.throws(() => buildCurveTradeCalls({ ...base, curve: undefined }));
  assert.doesNotThrow(() => buildEkuboTradeCalls({ ...base, amount: U128 - 1n }));
});

test("a last buy can call buy_and_graduate; only a buy can, and nothing else changes", () => {
  const plain = buildCurveTradeCalls({ ...base, side: "buy" }), grad = buildCurveTradeCalls({ ...base, side: "buy", graduate: true });
  assert.equal(grad[1].entrypoint, "buy_and_graduate");
  assert.deepEqual(grad.map(c => [c.contractAddress, c.calldata]), plain.map(c => [c.contractAddress, c.calldata]));
  assert.throws(() => buildCurveTradeCalls({ ...base, side: "sell", graduate: true }), /only a buy/);
});

test("orderCalls (the site's and bots' order path) builds exactly these calls, both venues, sides and token orders", () => {
  for (const [coin, currency] of [["0x10", "0x20"], ["0x20", "0x10"]]) {
    const route = { coin, currency, coinIsToken0: BigInt(coin) < BigInt(currency), router: "0x40", locker: "0x30", fee: `0x${ekuboFeeFor(70).toString(16)}` };
    for (const venue of ["curve", "pool"]) for (const side of ["buy", "sell"]) {
      const order = { venue, side, amount: 123n, minReceive: 99n };
      const payToken = side === "buy" ? currency : coin;
      const got = orderCalls(order, { target: venue === "curve" ? "0x50" : route.locker, payToken, deadline: 1_000, route: venue === "pool" ? route : undefined });
      const want = venue === "curve" ? buildCurveTradeCalls({ ...order, coin, currency, deadline: 1_000, curve: "0x50" })
        : buildEkuboTradeCalls({ ...order, coin, currency, deadline: 1_000, extension: route.locker, router: route.router, fee: route.fee });
      assert.deepEqual(got, want, `${venue} ${side} coin=${coin}`);
      assert.deepEqual(callFingerprint(got).length, got.length * 2);
    }
  }
  assert.throws(() => orderCalls({ venue: "pool", side: "buy", amount: 1n << 128n, minReceive: 1n },
    { target: "0x30", payToken: "0x20", deadline: 1, route: { coin: "0x10", currency: "0x20", coinIsToken0: true, router: "0x40", locker: "0x30", fee: "0x1" } }), /pool: amount too large/);
});

test("a pool order without its route throws (never curve calls); millisecond deadlines are refused", () => {
  assert.throws(() => orderCalls({ venue: "pool", side: "buy", amount: 1n, minReceive: 1n }, { target: "0x30", payToken: "0x20", deadline: 1_000 }), /pool route is missing/);
  assert.throws(() => buildCurveTradeCalls({ ...base, deadline: 1_760_000_000_000 }), /unix seconds, not milliseconds/);
  assert.doesNotThrow(() => buildCurveTradeCalls({ ...base, deadline: 1_760_000_000 }));
});
