// The bonding curve's arithmetic, exactly as contracts/src/curve.cairo computes it (and the reference
// model specifies it). Pure functions over a state object; nothing here talks to the chain.
// Amounts are BigInt base units (18 decimals). Functions throw QuoteError where the contract would revert.
import { BPS, ceilDiv, feeUp, mulDivUp, uint, type IntLike } from "./math.ts";

export class QuoteError extends Error {
  readonly reason: string;
  constructor(reason: string) { super(reason); this.name = "QuoteError"; this.reason = reason; }
}

/** A curve's settings, as the factory's curve_params() and the curve's params() return them (contracts'
 *  CurveParams). */
export type CurveParams = {
  v0: bigint; t0: bigint; curve_tokens: bigint; x_reserve: bigint; min_trade: bigint;
  fee_bps: bigint; grad_fee_bps: bigint;
  /** The launch window: buys in the launch block and the next sniper_blocks - 1 pay sniper_fee_bps (0 blocks: none). */
  sniper_fee_bps: bigint; sniper_blocks: bigint;
};
export type CurveParamsInput = { [K in keyof CurveParams]?: IntLike } & { v0: IntLike; t0: IntLike; curve_tokens: IntLike; min_trade: IntLike; fee_bps: IntLike };
/** A curve's state, as BondingCurve.state() returns it (without the locker and graduated flag). */
export type CurveState = { q: bigint; t: bigint; sold: bigint; real: bigint; fees: bigint; open: boolean };
export type CurveBuy = { out: bigint; spent: bigint; refund: bigint; fee: bigint; net: bigint; new_q: bigint; new_t: bigint };
export type CurveSell = { gross: bigint; fee: bigint; paid: bigint; new_q: bigint; new_t: bigint };

/** Normalizes params (accepts the contract's field names; strings/numbers become BigInt). */
export function curveParams(p: CurveParamsInput): CurveParams {
  const n: CurveParams = {
    v0: uint(p.v0, "v0"), t0: uint(p.t0, "t0"), curve_tokens: uint(p.curve_tokens, "curve_tokens"),
    x_reserve: uint(p.x_reserve ?? 0n, "x_reserve"), min_trade: uint(p.min_trade, "min_trade"),
    fee_bps: uint(p.fee_bps, "fee_bps"), grad_fee_bps: uint(p.grad_fee_bps ?? 0n, "grad_fee_bps"),
    sniper_fee_bps: uint(p.sniper_fee_bps ?? 0n, "sniper_fee_bps"), sniper_blocks: uint(p.sniper_blocks ?? 0n, "sniper_blocks"),
  };
  if (!(n.curve_tokens > 0n && n.curve_tokens < n.t0) || n.v0 === 0n) throw new QuoteError("curve: bad parameters");
  if (n.fee_bps >= BPS || n.sniper_fee_bps >= BPS) throw new QuoteError("curve: fee too high");
  return n;
}

/**
 * The fee a buy landing in block `block` pays (anyone's but the factory's dev buy, which pays fee_bps): the launch
 * window's sniper_fee_bps in the launch block and the next sniper_blocks - 1, then fee_bps (BondingCurve._buy_fee_bps).
 * Quote a buy at it with quoteBuy(state, { ...params, fee_bps: buyFeeBps(...) }, gross).
 */
export function buyFeeBps(params: CurveParams, launchBlock: IntLike, block: IntLike): bigint {
  return uint(block, "block") < uint(launchBlock, "launchBlock") + params.sniper_blocks ? params.sniper_fee_bps : params.fee_bps;
}

/** The state of a freshly created curve. */
export const initialState = (params: CurveParams): CurveState => ({ q: params.v0, t: params.t0, sold: 0n, real: 0n, fees: 0n, open: true });

/** Normalizes a state read from the chain (strings/numbers to BigInt). */
export const curveState = (s: { q: IntLike; t: IntLike; sold: IntLike; real: IntLike; fees: IntLike; open: boolean }): CurveState =>
  ({ q: uint(s.q), t: uint(s.t), sold: uint(s.sold), real: uint(s.real), fees: uint(s.fees), open: !!s.open });

/** curve.quote_buy(gross): spend up to `gross`; a last buy fills exactly what is left and refunds the rest. */
export function quoteBuy(state: CurveState, params: CurveParams, grossIn: IntLike): CurveBuy {
  const gross = uint(grossIn, "gross");
  if (!state.open) throw new QuoteError("curve: closed");
  if (gross < params.min_trade) throw new QuoteError("curve: below minimum trade");
  const k = params.v0 * params.t0;
  let fee = feeUp(gross, params.fee_bps), net = gross - fee;
  let newT = ceilDiv(k, state.q + net);
  let out = state.t - newT;
  const left = params.curve_tokens - state.sold;
  let spent = gross;
  if (out >= left) {
    out = left;
    newT = state.t - left;
    const need = ceilDiv(k, newT) - state.q;
    spent = mulDivUp(need, BPS, BPS - params.fee_bps);
    while (spent - feeUp(spent, params.fee_bps) < need) spent += 1n;
    if (spent > gross) throw new QuoteError("curve: spend exceeds offer");
    fee = feeUp(spent, params.fee_bps);
    net = spent - fee;
  }
  if (out <= 0n) throw new QuoteError("curve: buys zero tokens");
  return { out, spent, refund: gross - spent, fee, net, new_q: state.q + net, new_t: newT };
}

/** curve.quote_sell(tokens). Sells are capped at what the curve has sold. */
export function quoteSell(state: CurveState, params: CurveParams, tokensIn: IntLike): CurveSell {
  const tokens = uint(tokensIn, "tokens");
  if (!state.open) throw new QuoteError("curve: closed");
  if (tokens === 0n) throw new QuoteError("curve: zero tokens");
  if (tokens > state.sold) throw new QuoteError("curve: sell exceeds sold");
  const k = params.v0 * params.t0;
  const newT = state.t + tokens, newQ = ceilDiv(k, newT);
  const gross = state.q - newQ, fee = feeUp(gross, params.fee_bps);
  if (gross <= fee) throw new QuoteError("curve: sell pays nothing");
  return { gross, fee, paid: gross - fee, new_q: newQ, new_t: newT };
}

/** The state after a buy or sell quote is executed (what the contract writes). */
export function applyBuy(state: CurveState, params: CurveParams, r: CurveBuy): CurveState {
  const sold = state.sold + r.out;
  return { q: r.new_q, t: r.new_t, sold, real: state.real + r.net, fees: state.fees + r.fee, open: sold !== params.curve_tokens };
}
export const applySell = (state: CurveState, r: CurveSell, tokens: IntLike): CurveState => ({
  q: r.new_q, t: r.new_t, sold: state.sold - uint(tokens), real: state.real - r.gross, fees: state.fees + r.fee, open: state.open,
});

/**
 * The smallest offer that buys at least `tokens` now (the exact-output question: "what does 5% of supply cost?").
 * Returns { gross, quote } where quote = quoteBuy(gross); throws if more than the curve has left is asked for.
 */
export function costForTokens(state: CurveState, params: CurveParams, tokensIn: IntLike): { gross: bigint; quote: CurveBuy } {
  const tokens = uint(tokensIn, "tokens");
  if (!state.open) throw new QuoteError("curve: closed");
  const left = params.curve_tokens - state.sold;
  if (tokens === 0n || tokens > left) throw new QuoteError("curve: asks for more than is left");
  const k = params.v0 * params.t0;
  const need = ceilDiv(k, state.t - tokens) - state.q;         // net currency for exactly `tokens`
  let gross = mulDivUp(need, BPS, BPS - params.fee_bps);
  while (gross - feeUp(gross, params.fee_bps) < need) gross += 1n;
  if (gross < params.min_trade) gross = params.min_trade;
  // Rounding in ceil(k / (q + net)) can make one unit less suffice; walk down while it still buys enough.
  while (gross > params.min_trade && quoteBuy(state, params, gross - 1n).out >= tokens) gross -= 1n;
  const quote = quoteBuy(state, params, gross);
  if (quote.out < tokens) throw new QuoteError("curve: internal: cost does not buy the tokens");
  return { gross, quote };
}

/** What buying out everything the curve has left costs now (spend including the fee). */
export const costToClose = (state: CurveState, params: CurveParams) => costForTokens(state, params, params.curve_tokens - state.sold);

/** Spot price as a ratio (currency base units per token base unit): q / t. */
export const spotPrice = (state: CurveState): { num: bigint; den: bigint } => ({ num: state.q, den: state.t });

/** How far the curve is to graduating, in basis points of curve_tokens sold. */
export const progressBps = (state: CurveState, params: CurveParams): bigint => (state.sold * BPS) / params.curve_tokens;
