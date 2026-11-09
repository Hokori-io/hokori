// Launch-time numbers a factory determines from its parameters (contracts/src/factory.cairo, math.cairo): the
// pool reserve, the supply, the graduation seed, and the creator's first-in-line dev buy.
import { BPS, ceilDiv, mulDiv, uint, type IntLike } from "./math.ts";
import { QuoteError, costForTokens, initialState, quoteBuy, type CurveBuy, type CurveParams } from "./curve.ts";

export type GraduationSeed = { q_end: bigint; t_end: bigint; real: bigint; grad_fee: bigint; y: bigint; x: bigint };

/** math::graduation_seed: how every curve ends (path-independent) and what graduation puts in the pool. */
export function graduationSeed(params: CurveParams): GraduationSeed {
  const t_end = params.t0 - params.curve_tokens;
  const q_end = ceilDiv(params.v0 * params.t0, t_end);
  const real = q_end - params.v0;
  const grad_fee = mulDiv(real, params.grad_fee_bps, BPS);
  const y = real - grad_fee;
  const x = mulDiv(y, t_end, q_end);
  return { q_end, t_end, real, grad_fee, y, x };
}

/** factory::pool_reserve: tokens set aside for the pool (continuity before the graduation fee, + 1 ppm + 1). */
export function poolReserve(params: CurveParams): bigint {
  const g = graduationSeed(params);
  const x = mulDiv(g.real, g.t_end, g.q_end);
  return x + x / 1_000_000n + 1n;
}

/** The factory's params with x_reserve filled in, the coin's total supply, and graduation's figures. */
export function factoryFigures(params: CurveParams): { params: CurveParams; supply: bigint; seed: GraduationSeed; burnedAtGraduation: bigint } {
  const x_reserve = poolReserve(params);
  const full = { ...params, x_reserve };
  const seed = graduationSeed(full);
  if (seed.x === 0n || seed.y === 0n) throw new QuoteError("curve: pool would be empty");
  if (seed.x > x_reserve) throw new QuoteError("curve: reserve too small");
  return { params: full, supply: params.curve_tokens + x_reserve, seed, burnedAtGraduation: x_reserve - seed.x };
}

/** The creator's dev buy in the launch transaction: the first buy on a fresh curve (or nothing). */
export function devBuy(params: CurveParams, grossIn: IntLike): CurveBuy | { out: bigint; spent: bigint; refund: bigint; fee: bigint; net: bigint } {
  const gross = uint(grossIn, "dev_buy");
  if (gross === 0n) return { out: 0n, spent: 0n, refund: 0n, fee: 0n, net: 0n };
  return quoteBuy(initialState(params), params, gross);
}

/** What a dev buy of `bpsOfSupply` (e.g. 500 = 5%) costs on a fresh curve, the smallest offer that gets it. */
export function devBuyCostForShare(params: CurveParams, supply: IntLike, bpsOfSupply: IntLike): { gross: bigint; quote: CurveBuy } {
  const tokens = (uint(supply) * uint(bpsOfSupply)) / BPS;
  return costForTokens(initialState(params), params, tokens);
}
