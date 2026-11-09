// Unsigned, atomic call lists for Hokori v2. No wallet, RPC, secrets or network access.
// Addresses must come from a trusted deployment and verified factory reads, not coin metadata.
import { uint, type IntLike } from "./math.ts";
import { EKUBO_TICK_SPACING, MIN_SQRT_RATIO, MAX_SQRT_RATIO } from "./ekubo.ts";

/** An unsigned Starknet call (starknet.js's Call shape). Submit a builder's whole result as ONE atomic multicall. */
export type HokoriCall = { contractAddress: string; entrypoint: string; calldata: string[] };
export type TradeCallInput = {
  side: "buy" | "sell"; amount: IntLike; minReceive: IntLike; deadline: IntLike;
  coin: IntLike; currency: IntLike;
};
export type EkuboKeyInput = {
  coin: IntLike; currency: IntLike; extension: IntLike;
  /** Binary fraction of 2^128, as in the locker's pool_key(token); NOT basis points. */
  fee: IntLike;
};

const U128 = 1n << 128n;
const ADDRESS_BOUND = (1n << 251n) - 256n;
const hex = (n: bigint) => `0x${n.toString(16)}`;
function bounded(value: IntLike, bound: bigint, name: string, positive = false): bigint {
  const n = uint(value, name);
  if (n >= bound || (positive && n === 0n)) throw new RangeError(`${name}: out of range`);
  return n;
}
const address = (v: IntLike, name: string) => bounded(v, ADDRESS_BOUND, name, true);
const u256 = (n: bigint) => [hex(n % U128), hex(n / U128)];
const call = (target: bigint, entrypoint: string, calldata: string[]): HokoriCall => ({ contractAddress: hex(target), entrypoint, calldata });
function trade(o: Pick<TradeCallInput, "side" | "amount" | "minReceive" | "deadline">, amountBound: bigint) {
  if (o.side !== "buy" && o.side !== "sell") throw new TypeError("side: expected buy or sell");
  return {
    amount: bounded(o.amount, amountBound, "amount", true),
    minReceive: bounded(o.minReceive, 1n << 256n, "minReceive", true),
    deadline: seconds(bounded(o.deadline, 1n << 64n, "deadline", true)),
  };
}
/** A deadline is unix seconds: a millisecond value (about 1.7e12 today) would never expire. */
function seconds(deadline: bigint): bigint {
  if (deadline >= 100_000_000_000n) throw new RangeError("deadline: expected unix seconds, not milliseconds");
  return deadline;
}
function pair(o: { coin: IntLike; currency: IntLike }) {
  const coin = address(o.coin, "coin"), currency = address(o.currency, "currency");
  if (coin === currency) throw new RangeError("coin and currency must differ");
  return { coin, currency };
}
function pool(o: EkuboKeyInput) {
  const { coin, currency } = pair(o), extension = address(o.extension, "extension");
  const fee = bounded(o.fee, U128, "fee");
  const [token0, token1] = coin < currency ? [coin, currency] : [currency, coin];
  return { coin, currency, extension, key: [token0, token1, fee, EKUBO_TICK_SPACING, extension].map(hex) };
}

/** Canonical Starknet Ekubo pool key. The extension is Hokori's GradLocker, not a pool contract. */
export function ekuboPoolKey(o: EkuboKeyInput): string[] { return pool(o).key; }

/** A curve trade's calls, given the token paid (STRK for a buy, the coin for a sell): an exact approval of `amount`
 * to the curve, then buy(gross, min_out, deadline) or sell(tokens, min_paid, deadline). With `graduate`, a buy known to
 * take the curve's last tokens calls buy_and_graduate instead: the same buy, which also graduates the coin (it
 * reverts "curve: not the last buy" otherwise). A plain buy never graduates. Submit both calls in ONE multicall. */
export function curveTradeCalls(o: { curve: IntLike; payToken: IntLike; side: "buy" | "sell"; amount: IntLike; minReceive: IntLike; deadline: IntLike; graduate?: boolean }): HokoriCall[] {
  const { amount, minReceive, deadline } = trade(o, 1n << 256n);
  const curve = address(o.curve, "curve"), payToken = address(o.payToken, "payToken");
  if (o.graduate && o.side !== "buy") throw new TypeError("graduate: only a buy can graduate the coin");
  return [
    call(payToken, "approve", [hex(curve), ...u256(amount)]),
    call(curve, o.graduate ? "buy_and_graduate" : o.side, [...u256(amount), ...u256(minReceive), hex(deadline)]),
  ];
}

/** Exact input approval followed by a curve trade. Submit the entire list in ONE account.execute call.
 * On a graduating buy the curve can take less than amount; use the accepted quote's capped spend.
 * The caller verifies venue, launch window, quote, chain, addresses, balance and network fee before signing. */
export function buildCurveTradeCalls(o: TradeCallInput & { curve: IntLike; graduate?: boolean }): HokoriCall[] {
  const { coin, currency } = pair(o);
  return curveTradeCalls({ ...o, payToken: o.side === "buy" ? currency : coin });
}

/** Exact-input route through Ekubo's Starknet Router v3, for Hokori v2 only. Submit ALL calls atomically.
 * The deadline and minimum protect the whole swap; leftover input is returned. Never send the transfer alone.
 * Does not fetch a quote, verify the route's deployment, estimate fees, sign, send or retry a transaction. */
export function buildEkuboTradeCalls(o: TradeCallInput & EkuboKeyInput & { router: IntLike }): HokoriCall[] {
  const { amount, minReceive, deadline } = trade(o, U128);
  const { coin, currency, extension, key } = pool(o), router = address(o.router, "router");
  const input = o.side === "buy" ? currency : coin, output = o.side === "buy" ? coin : currency;
  const limit = input > output ? MAX_SQRT_RATIO : MIN_SQRT_RATIO;
  return [
    call(extension, "check_deadline", [hex(deadline)]),
    call(input, "transfer", [hex(router), ...u256(amount)]),
    call(router, "swap", [...key, ...u256(limit), "0x0", hex(input), hex(amount), "0x0"]),
    call(router, "clear_minimum", [hex(output), ...u256(minReceive)]),
    call(router, "clear", [hex(input)]),
  ];
}
