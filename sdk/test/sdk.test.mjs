// @hokoridotio/sdk against (1) vectors.json, from the curve's reference model, (2) devnet-recorded.json, figures the
// contracts produced on a devnet, and (3) properties over random inputs. Both files sit beside this test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BPS, ONE, applyBuy, applySell, buyFeeBps, costForTokens, costToClose, curveParams, devBuy, devBuyCostForShare, factoryFigures,
  formatUnits, graduationSeed, initialState, parseUnits, payeeProblems, quoteBuy, quoteSell, splitDeposit, splitDeposits, QuoteError,
} from "../src/index.ts";

const json = path => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const V = json("./vectors.json");
const SHAPE = { t0: 1_073_000_000n * ONE, curve_tokens: 793_100_000n * ONE, min_trade: 10n ** 12n, fee_bps: 100n, grad_fee_bps: 100n };
const PUMP = curveParams({ ...SHAPE, v0: 30n * ONE });
const CHOSEN = curveParams({ ...SHAPE, v0: 24351405875677720337915n });   // the 69K curve the recorded devnet run used
const LAUNCH = curveParams({ ...SHAPE, v0: 35291892573445971504224n });   // the launch factory's

test("curve steps match the reference vectors exactly", () => {
  const p = curveParams({ ...V.curve.params, grad_fee_bps: 100 });
  let s = initialState(p);
  for (const step of V.curve.steps) {
    if (step.op === "buy") {
      const r = quoteBuy(s, p, step.gross);
      assert.equal(r.out, BigInt(step.out)); assert.equal(r.fee, BigInt(step.fee)); assert.equal(r.refund, BigInt(step.refund));
      s = applyBuy(s, p, r);
    } else {
      const r = quoteSell(s, p, step.tokens);
      assert.equal(r.gross, BigInt(step.gross)); assert.equal(r.fee, BigInt(step.fee)); assert.equal(r.paid, BigInt(step.paid));
      s = applySell(s, r, step.tokens);
    }
    assert.equal(s.q, BigInt(step.q)); assert.equal(s.t, BigInt(step.t)); assert.equal(s.real, BigInt(step.real)); assert.equal(s.fees, BigInt(step.fees));
  }
});

test("graduation matches the reference vectors exactly", () => {
  const g = graduationSeed(curveParams({ ...V.curve.params, grad_fee_bps: V.graduation.grad_fee_bps }));
  assert.equal(g.q_end, BigInt(V.graduation.final_q)); assert.equal(g.t_end, BigInt(V.graduation.final_t));
  assert.equal(g.real, BigInt(V.graduation.real)); assert.equal(g.grad_fee, BigInt(V.graduation.grad_fee));
  assert.equal(g.y, BigInt(V.graduation.y)); assert.equal(g.x, BigInt(V.graduation.x));
});

// Figures the contracts produced on the devnet (two recorded runs, 13 Oct 2026; devnet-recorded.json).
const RECORDED = json("./devnet-recorded.json");
function recorded(file) {
  const r = RECORDED[file];
  return { supply: BigInt(r.supply), devTokens: BigInt(r.devTokens), closeCost: BigInt(r.closeCost), seed: r.seed };
}

for (const [file, params, dev] of [["devnet-2026-10-13.json", PUMP, ONE], ["devnet-69k-2026-10-13.json", CHOSEN, 1_000n * ONE]]) {
  test(`launch figures equal what the factory did on chain (${file})`, () => {
    const got = recorded(file);
    const f = factoryFigures(params);
    assert.equal(f.supply, got.supply, "supply = curve tokens + pool reserve");
    assert.equal(devBuy(f.params, dev).out, got.devTokens, "the dev buy's tokens");
    assert.equal(costToClose(initialState(f.params), f.params).gross, got.closeCost, "cost of buying the whole curve at launch");
    assert.equal(f.seed.x, BigInt(got.seed.x)); assert.equal(f.seed.y, BigInt(got.seed.y));
  });
}

test("the 69K curve raises exactly 69,000 STRK", () => {
  assert.equal(factoryFigures(CHOSEN).seed.real / ONE, 69_000n);
});

test("the launch size raises 100,000 STRK and one base unit; one base unit less of v0 falls short", () => {
  // To the base unit: the ceiling of v0 raises 1 base unit over 100,000, as the 69K curve's raised 2
  // over 69,000; the floor would fall short of the even figure.
  assert.equal(factoryFigures(LAUNCH).seed.real, 100_000n * ONE + 1n);
  assert.equal(factoryFigures(CHOSEN).seed.real, 69_000n * ONE + 2n);
  assert.equal(factoryFigures(curveParams({ ...SHAPE, v0: 35291892573445971504224n - 1n })).seed.real / ONE, 99_999n);
});

// Small deterministic PRNG for repeatable property tests.
function rng(seed) {
  let s = BigInt(seed);
  return max => { s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return (s >> 16n) % max; };
}

test("costForTokens is the smallest offer that buys the tokens (random states)", () => {
  const r = rng(7);
  for (const p of [PUMP, CHOSEN]) {
    const f = factoryFigures(p).params;
    let s = initialState(f);
    for (let i = 0; i < 60; i++) {
      const left = f.curve_tokens - s.sold;
      const want = 1n + r(left / 50n + 1n);
      const { gross, quote } = costForTokens(s, f, want);
      assert.ok(quote.out >= want);
      if (gross > f.min_trade) assert.ok(quoteBuy(s, f, gross - 1n).out < want, "one unit less must buy fewer");
      if (r(3n) === 0n && s.sold > 0n) s = applySell(s, quoteSell(s, f, s.sold / 3n + 1n), s.sold / 3n + 1n);
      else s = applyBuy(s, f, quote);
    }
  }
});

test("a round trip never profits, and the curve stays solvent (random)", () => {
  const r = rng(11);
  const f = factoryFigures(PUMP).params;
  let s = initialState(f);
  for (let i = 0; i < 200; i++) {
    const gross = f.min_trade + r(5n * ONE);
    let b;
    try { b = quoteBuy(s, f, gross); } catch (e) { assert.ok(e instanceof QuoteError); break; }
    const after = applyBuy(s, f, b);
    if (after.open) {
      const back = quoteSell(after, f, b.out);
      assert.ok(back.paid <= b.spent, "selling what you just bought returns no more than you paid");
    }
    s = after;
    assert.equal(s.real, s.q - f.v0, "real reserve = q - v0");
    if (!s.open) break;
  }
});

test("the last buy fills exactly what is left and refunds the rest", () => {
  const f = factoryFigures(PUMP).params;
  const r = quoteBuy(initialState(f), f, 1_000n * ONE);
  assert.equal(r.out, f.curve_tokens);
  assert.equal(r.spent + r.refund, 1_000n * ONE);
  assert.equal(applyBuy(initialState(f), f, r).open, false);
  assert.throws(() => quoteBuy(applyBuy(initialState(f), f, r), f, ONE), /closed/);
});

test("dev buy for a share of supply", () => {
  const { params, supply } = factoryFigures(CHOSEN);
  const { gross, quote } = devBuyCostForShare(params, supply, 500n);
  assert.ok(quote.out >= supply * 500n / BPS);
  // DECISIONS.md: "buying 5% at launch costs about $114" at $0.0945 per STRK.
  assert.equal(Math.round((Number(gross / 10n ** 15n) / 1000) * 0.0945), 114);
});

test("fee splits: protocol first, payees by share, the last takes the remainder; deposits split one at a time", () => {
  const s = splitDeposit(1_000_003n, 499n, [7000n, 3000n]);
  assert.equal(s.protocol, 49_900n);                        // floor(1_000_003 * 499 / 10_000)
  assert.equal(s.payees[0], 665_072n);                      // floor(950_103 * 0.7)
  assert.equal(s.payees[1], 950_103n - 665_072n);
  assert.equal(s.protocol + s.payees[0] + s.payees[1], 1_000_003n);
  // The reviewer's 11 + 11 case (REVIEW-RESPONSE-2026-10-12, F2): split separately, not as 22.
  const two = splitDeposits([11n, 11n], 0n, [7000n, 3000n]);
  assert.deepEqual(two.payees, [14n, 8n]);
  const r = rng(3);
  for (let i = 0; i < 200; i++) {
    const n = Number(1n + r(5n)), shares = Array(n).fill(0n);
    let left = BPS;
    for (let j = 0; j < n - 1; j++) { shares[j] = 1n + r(left - BigInt(n - j)); left -= shares[j]; }
    shares[n - 1] = left;
    const amount = r(10n ** 24n), out = splitDeposit(amount, r(5001n), shares);
    assert.equal(out.protocol + out.payees.reduce((a, b) => a + b, 0n), amount);
  }
});

test("payee checks match the vault's rules, with the site's 5-payee limit", () => {
  const a = "0x2939f2dc3f80cc7d620e8a86f2e69c1e187b7ff44b74056647368b5c49dc370", b = "0x25a6c9f0c15ef30c139065096b4b8e563e6b86191fd600a4f0616df8f22fb77";
  assert.deepEqual(payeeProblems([{ address: a, shareBps: 7000 }, { address: b, shareBps: 3000 }]), []);
  assert.match(payeeProblems([{ address: a, shareBps: 7000 }, { address: b, shareBps: 2999 }]).join(), /9999 bps/);
  assert.match(payeeProblems([{ address: a, shareBps: 5000 }, { address: a, shareBps: 5000 }]).join(), /twice/);
  assert.match(payeeProblems([{ address: "0x0", shareBps: 10000 }]).join(), /zero address/);
  const six = Array.from({ length: 6 }, (_, i) => ({ address: "0x" + (i + 1).toString(16), shareBps: i < 5 ? 1666 : 1670 }));
  assert.match(payeeProblems(six).join(), /at most 5/);
  assert.deepEqual(payeeProblems(six, { max: 10 }), []);
});

test("the launch window: buys in the launch block and the next pay the window fee, then the normal fee", () => {
  const p = curveParams({ ...SHAPE, v0: 30n * ONE, sniper_fee_bps: 9900n, sniper_blocks: 2n });
  assert.deepEqual([100n, 101n, 102n, 150n].map(b => buyFeeBps(p, 100n, b)), [9900n, 9900n, 100n, 100n]);
  assert.equal(buyFeeBps(curveParams({ ...SHAPE, v0: 30n * ONE }), 100n, 100n), 100n, "no window: the normal fee from the start");
  const gross = 10n * ONE, inWindow = quoteBuy(initialState(p), { ...p, fee_bps: buyFeeBps(p, 100n, 101n) }, gross);
  assert.equal(inWindow.fee, (gross * 9900n + 9999n) / 10000n);
  assert.ok(inWindow.out * 50n < quoteBuy(initialState(p), p, gross).out, "a window buy gets about 1% of the tokens");
});

test("unit parsing and display", () => {
  assert.equal(parseUnits("1.5"), 15n * 10n ** 17n);
  assert.equal(parseUnits("69000"), 69_000n * ONE);
  assert.throws(() => parseUnits("0.0000000000000000001"));
  assert.equal(formatUnits(69_696_969_696_969_696_969_699n, 18, 4), "69696.9696");
});

// ---- Contract v2: a graduated coin's Ekubo pool (one full-range position) ----
import { ekuboApply, ekuboFeeFor, ekuboPool, ekuboPrice, ekuboQuoteBuy, ekuboQuoteSell, ekuboReserves } from "../src/index.ts";
const EKUBO_FEE_1_PERCENT = ekuboFeeFor(100n);

/** The chosen curve's pool as the research's fork run opened it (tick ±8005820, L = 3740461083956776933171112). */
const POOL_STATE = {
  token0: { sqrtRatio: 6214391210770290039229374862896340324n, liquidity: 3740461083956776933171112n, coinIsToken0: true },
  token1: { sqrtRatio: 18632893442021243976875359826000772528065n, liquidity: 3740461083956776933171112n, coinIsToken0: false },
};
const FEE = EKUBO_FEE_1_PERCENT;   // the fixtures' pools charge 1%
const HOKORI_POOL = { token0: ekuboPool({ ...POOL_STATE.token0, fee: FEE, core: "v5" }), token1: ekuboPool({ ...POOL_STATE.token1, fee: FEE, core: "v5" }) };

test("pool fees as Ekubo encodes them: 1% and Hokori's 0.7%", () => {
  assert.equal(ekuboFeeFor(100n), 3402823669209384634633746074317682114n);
  assert.equal(ekuboFeeFor(70n), 2381976568446569244243622252022377480n);
  const at = fee => ekuboQuoteBuy(ekuboPool({ ...POOL_STATE.token0, fee, core: "v5" }), 1000n * ONE);
  assert.equal(at(ekuboFeeFor(70n)).fee, (1000n * ONE * ekuboFeeFor(70n) + (1n << 128n) - 1n) >> 128n, "the fee taken from the input, rounded up");
  assert.ok(at(ekuboFeeFor(70n)).out > at(EKUBO_FEE_1_PERCENT).out, "a lower fee buys more");
});

test("an Ekubo pool opens at the curve's closing price on either side of the currency", () => {
  for (const pool of Object.values(HOKORI_POOL)) {
    const { num, den } = ekuboPrice(pool.sqrtRatio, pool.coinIsToken0);
    const strkPerToken = Number(num * 10n ** 12n / den) / 1e12;
    assert.ok(Math.abs(strkPerToken / 3.33517e-4 - 1) < 1e-4, `${strkPerToken}`);
    const r = ekuboReserves(pool);   // ~68,310 STRK and ~204.8M tokens
    assert.ok(Math.abs(Number(r.currency / ONE) - 68_310) < 5 && Math.abs(Number(r.tokens / ONE) - 204_817_151) < 500, `${r.currency} ${r.tokens}`);
  }
});

test("Ekubo pool trades: the same on either side, fee rounded up, and a round trip never profits", () => {
  for (const spend of [10n ** 12n, ONE, 1_000n * ONE, 50_000n * ONE]) {
    const [b0, b1] = [ekuboQuoteBuy(HOKORI_POOL.token0, spend), ekuboQuoteBuy(HOKORI_POOL.token1, spend)];
    assert.equal(b0.fee, (spend * EKUBO_FEE_1_PERCENT + (1n << 128n) - 1n) >> 128n);
    assert.ok(Math.abs(Number(b0.out - b1.out)) / Number(b0.out) < 1e-6, "symmetric to within a tick's rounding");
    for (const [pool, b] of [[HOKORI_POOL.token0, b0], [HOKORI_POOL.token1, b1]]) {
      const s = ekuboQuoteSell(ekuboApply(pool, b), b.out);
      assert.ok(s.paid < spend, `round trip ${s.paid} >= ${spend}`);
      assert.ok(s.paid > spend * 97n / 100n || spend > 1_000n * ONE, "two 1% fees plus rounding, for small trades");
    }
  }
  assert.throws(() => ekuboQuoteBuy(HOKORI_POOL.token0, 0n), QuoteError);
});

test("17f1a14 V5: token0 input rounds as the deployed Core does: v4.0.1 floors first, v5.0.2 is exact", () => {
  // v4 (Sepolia): captured from the independent review's translation of v4.0.1's next_sqrt_ratio_from_amount0.
  const v4 = ekuboPool({ ...POOL_STATE.token1, fee: FEE, core: "v4" });
  for (const [amount, expected] of [[ONE, 2968319268022783587168n], [1000n * ONE, 2925957111612001291236965n],
    [50000n * ONE, 86057562106235332199437915n]]) {
    assert.equal(ekuboQuoteBuy(v4, amount).out, expected);
  }
  // v5 (mainnet): v5.0.2 keeps the inner remainder, so the same trade gets 1,156 base units more.
  assert.equal(ekuboQuoteBuy(HOKORI_POOL.token1, ONE).out, 2968319268022783588324n);
  // Token1 input rounds the same on both versions.
  assert.equal(ekuboQuoteBuy(ekuboPool({ ...POOL_STATE.token0, fee: FEE, core: "v4" }), 1000n * ONE).out, ekuboQuoteBuy(HOKORI_POOL.token0, 1000n * ONE).out);
  assert.throws(() => ekuboPool({ ...POOL_STATE.token0, fee: FEE }), /Core version/, "the version must be named");
  assert.throws(() => ekuboPool({ ...POOL_STATE.token0, core: "v5" }), /fee/, "and the fee");
});

test("17f1a14 V5: quotes equal the deployed Cores' trades through Ekubo's Router (fork-recorded, both token orders)", () => {
  // Recorded by contracts/tests/test_graduation.cairo (parity_*): a fresh graduated pool, a buy of 7.000000000123456789
  // STRK, then a sell of a third of what it bought. [network Core, coin is token0, sqrt before, buy out, sqrt after, sell in, sell out]
  const L = 131287622912096436194081n, spend = 7000000000123456789n;
  const recorded = [
    ["v4", false, 530862110528192432994208694338328832365857n, 15582996923445228699426981n, 490472780908126034584207321626392170875463n, 5194332307815076233142327n, 2409737048598943046n],
    ["v4", true, 218120839556822803743354957095464285n, 15582996923445228700225242n, 236082599778367803108257760651485652n, 5194332307815076233408414n, 2409737048598943046n],
    ["v5", true, 218120839556822803743354957095464285n, 15582996923445228700225242n, 236082599778367803108257760651485652n, 5194332307815076233408414n, 2409737048598943046n],
    ["v5", false, 530862110528192432994208694338328832365857n, 15582996923445228700225242n, 490472780908126034582138320589508633776766n, 5194332307815076233408414n, 2409737048598943046n],
  ];
  for (const [core, coinIsToken0, s0, buyOut, s1, sellIn, sellOut] of recorded) {
    const buy = ekuboQuoteBuy(ekuboPool({ sqrtRatio: s0, liquidity: L, coinIsToken0, fee: FEE, core }), spend);
    assert.deepEqual([buy.out, buy.sqrtRatioAfter], [buyOut, s1], `${core} buy, coin is token${coinIsToken0 ? 0 : 1}`);
    assert.equal(ekuboQuoteSell(ekuboPool({ sqrtRatio: s1, liquidity: L, coinIsToken0, fee: FEE, core }), sellIn).paid, sellOut, `${core} sell`);
  }
  // Fee consumes the whole one-unit input: Core leaves its price unchanged, so no output is possible.
  for (const pool of Object.values(HOKORI_POOL)) {
    assert.throws(() => ekuboQuoteBuy(pool, 1n), /pays zero/);
    assert.throws(() => ekuboQuoteSell(pool, 1n), /pays zero/);
  }
});
