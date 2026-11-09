// Reading Hokori's contracts and a coin's Ekubo pool from the chain, through any provider with starknet.js's
// `callContract` (and `getBlockNumber` for a coin's whole state). The returned felts are decoded here, by the
// contracts' own layouts (contracts/src/interfaces.cairo), so this needs no ABI library. Everything that signs starts
// from these reads of a factory you trust (networks.ts), never from published data.
import { readCurrency, type Currency } from "./currency.ts";
import { buyFeeBps, curveParams, type CurveParams, type CurveState } from "./curve.ts";
import { ekuboFeeFor, ekuboPool, type EkuboCore, type EkuboPool } from "./ekubo.ts";
import { byteArrayFromFelts } from "./address.ts";
import { poolKeyFelts, type PoolRoute } from "./orders.ts";

/** What these reads need: starknet.js's RpcProvider and Account both fit. `block` defaults to the provider's. */
export type CallSource = { callContract(call: { contractAddress: string; entrypoint: string; calldata: string[] }, block?: number | "latest" | "pre_confirmed"): Promise<string[]> };
export type HeadSource = { getBlockNumber(): Promise<number> };

const hex = (v: string | bigint) => "0x" + BigInt(v).toString(16).padStart(64, "0");
const u256 = (r: readonly string[], i: number) => BigInt(r[i]) + (BigInt(r[i + 1]) << 128n);
const need = (r: readonly string[], n: number, what: string) => { if (r.length < n) throw new Error(`${what}: expected ${n} values, got ${r.length}`); return r; };
const read = (p: CallSource, contractAddress: string, entrypoint: string, calldata: string[] = []) => p.callContract({ contractAddress, entrypoint, calldata });
/** Whether a failed read was the contract refusing an unknown token (the factory's launch_of). */
export const isUnknownToken = (e: unknown) => /unknown token/i.test(String((e as Error)?.message ?? e));
const missingEntryPoint = (e: unknown) => /not found|ENTRYPOINT_NOT_FOUND|entry point/i.test(String((e as Error)?.message ?? e));

/** A CurveParams struct from 14 felts at `i` (u256 v0, t0, curve_tokens, x_reserve, min_trade; u16 fee_bps,
 *  grad_fee_bps, sniper_fee_bps; u64 sniper_blocks). */
export function decodeCurveParams(r: readonly string[], i = 0): CurveParams {
  need(r, i + 14, "CurveParams");
  return curveParams({ v0: u256(r, i), t0: u256(r, i + 2), curve_tokens: u256(r, i + 4), x_reserve: u256(r, i + 6), min_trade: u256(r, i + 8),
    fee_bps: BigInt(r[i + 10]), grad_fee_bps: BigInt(r[i + 11]), sniper_fee_bps: BigInt(r[i + 12]), sniper_blocks: BigInt(r[i + 13]) });
}
/** A curve's state as BondingCurve.state() returns it: the curve's state, whether it graduated, and its locker. */
export type CurveChainState = CurveState & { graduated: boolean; locker: string };
export function decodeCurveState(r: readonly string[]): CurveChainState {
  need(r, 13, "CurveState");
  return { q: u256(r, 0), t: u256(r, 2), sold: u256(r, 4), real: u256(r, 6), fees: u256(r, 8), open: BigInt(r[10]) !== 0n, graduated: BigInt(r[11]) !== 0n, locker: hex(r[12]) };
}

/** A launch factory's settings, read from it (fixed when it was deployed). */
export type FactorySettings = {
  address: string; params: CurveParams; supply: bigint;
  vault: string; locker: string; currency: string; protocol: string;
  /** The currency's symbol and decimals as well as its address (sdk/src/currency.ts). */
  currencyInfo: Currency;
  /** The protocol's share of every fee deposit, in basis points (the fee vault's). */
  protocolBps: number;
  /** Ekubo Core, as the factory's locker uses it. */
  core: string;
  /** Every coin's pool fee: the curve's trading fee as Ekubo encodes it. */
  poolFee: bigint;
  /** The coin address ending the factory requires (Hokori: "dab", 3 hex digits). */
  addressRule: { suffix: bigint; digits: number };
  tokenClass: string;
  launchFee: bigint;
  /** The most a launch's dev buy may take, in tokens; null for a factory from before the cap (no limit). */
  maxDevTokens: bigint | null;
};

export async function readFactory(p: CallSource, factory: string): Promise<FactorySettings> {
  const f = hex(factory);
  const [params, supply, vault, locker, currency, rule, tokenClass, launchFee, protocol] = await Promise.all([
    read(p, f, "curve_params"), read(p, f, "supply"), read(p, f, "fee_vault"), read(p, f, "locker"), read(p, f, "currency"),
    read(p, f, "address_rule"), read(p, f, "token_class"), read(p, f, "launch_fee"), read(p, f, "protocol"),
  ]);
  const maxDev = await read(p, f, "max_dev_tokens").then(r => u256(need(r, 2, "max_dev_tokens"), 0), e => (missingEntryPoint(e) ? null : Promise.reject(e)));
  const [protocolBps, core, currencyInfo] = await Promise.all([read(p, hex(vault[0]), "protocol_bps"), read(p, hex(locker[0]), "core"), readCurrency(p, hex(currency[0]))]);
  const curve = decodeCurveParams(params);
  return {
    address: f, params: curve, supply: u256(need(supply, 2, "supply"), 0), vault: hex(vault[0]), locker: hex(locker[0]), currency: hex(currency[0]), currencyInfo,
    protocol: hex(protocol[0]), protocolBps: Number(BigInt(protocolBps[0])), core: hex(core[0]), poolFee: ekuboFeeFor(curve.fee_bps),
    addressRule: { suffix: BigInt(need(rule, 2, "address_rule")[0]), digits: Number(BigInt(rule[1])) }, tokenClass: hex(tokenClass[0]),
    launchFee: u256(need(launchFee, 2, "launch_fee"), 0), maxDevTokens: maxDev,
  };
}

/** A coin's launch record, as its factory keeps it. Throws an error isUnknownToken() recognizes for a token the factory
 *  didn't launch. */
export type LaunchRecord = { token: string; curve: string; creator: string; devTokens: bigint; metadataSha256: bigint };
export async function readLaunch(p: CallSource, factory: string, token: string): Promise<LaunchRecord> {
  const r = need(await read(p, hex(factory), "launch_of", [hex(token)]), 7, "Launch");
  const launch = { token: hex(r[0]), curve: hex(r[1]), creator: hex(r[2]), devTokens: u256(r, 3), metadataSha256: u256(r, 5) };
  if (BigInt(launch.token) !== BigInt(token)) throw new Error("the factory returned another coin");
  return launch;
}

/** The coin's metadata URI, as committed at launch (its content's SHA-256 is in the launch record). */
/** The curve `factory` created for `token`, or null if it didn't launch it (its `curve_of` is zero for any other
 *  address: one cheap read, no revert). */
export async function readCurveOf(p: CallSource, factory: string, token: string): Promise<string | null> {
  const r = await read(p, hex(factory), "curve_of", [hex(token)]);
  return BigInt(r[0]) === 0n ? null : hex(r[0]);
}

/** Which of `factories` launched `token` (asked all at once): that factory's address, or null if none did. A site that
 *  follows several factories reads a coin through the one that launched it. */
export async function resolveFactory(p: CallSource, factories: string[], token: string): Promise<string | null> {
  const found = await Promise.all(factories.map(async f => ((await readCurveOf(p, f, token)) ? hex(f) : null)));
  return found.find(f => f !== null) ?? null;
}

export const readMetadataUri = async (p: CallSource, factory: string, token: string) =>
  byteArrayFromFelts(await read(p, hex(factory), "metadata_uri", [hex(token)])).text;

/** A coin's Ekubo pool key, as its locker builds it: token0, token1 (lower address first), fee, tick spacing,
 *  extension (the locker). */
export async function readPoolKey(p: CallSource, locker: string, token: string) {
  const r = need(await read(p, hex(locker), "pool_key", [hex(token)]), 5, "PoolKey");
  return { token0: hex(r[0]), token1: hex(r[1]), fee: BigInt(r[2]), tickSpacing: BigInt(r[3]), extension: hex(r[4]) };
}

/** A graduated coin's pool now: its price and liquidity from Ekubo Core. */
export async function readPool(p: CallSource, core: string, route: PoolRoute, coreVersion: EkuboCore): Promise<EkuboPool> {
  const key = poolKeyFelts(route);
  const [price, liquidity] = await Promise.all([read(p, hex(core), "get_pool_price", key), read(p, hex(core), "get_pool_liquidity", key)]);
  return ekuboPool({ sqrtRatio: u256(need(price, 2, "get_pool_price"), 0), liquidity: BigInt(liquidity[0]), coinIsToken0: route.coinIsToken0, fee: BigInt(route.fee), core: coreVersion });
}

/** One coin as it stands on the chain: its launch record, its curve's settings and state, and its pool once graduated.
 *  `readAt` is the chain's head when the reads began (the state is at least that recent); `buyFeeBps` is what a buy
 *  sent now pays (it lands in the next block at the earliest: the launch window's fee, or the normal one). */
export type CoinOnChain = {
  token: string; curve: string; creator: string; devTokens: bigint; metadataUri: string; metadataSha256: bigint;
  /** The launch factory it was read through: the one that launched it. */
  factory: string;
  state: CurveChainState; params: CurveParams; launchBlock: number; buyFeeBps: bigint;
  supply: bigint; vault: string; readAt: number;
  /** Where the coin trades after graduation: its Ekubo pool through Ekubo's Router (the pool exists once graduated),
   *  and the Ekubo Core it's in, with its version (which decides a quote's rounding). */
  route: PoolRoute; core: string; coreVersion: EkuboCore;
  pool: EkuboPool | null;
  /** What it trades against: its factory's currency (STRK, or ZEC on the ZEC launchpad), read from that factory. */
  currency: Currency;
};

/** Reads a coin from `factory` (one you trust: its launch record names the curve, and its locker the pool), or, with
 *  `factories` (the ones followed, oldest first), from whichever of them launched it (resolveFactory; an error
 *  isUnknownToken recognizes when none did). Its currency is its factory's, read from it (the ZEC launchpad, 1 Nov);
 *  `currency`, when given, is what the caller expects, and a coin trading against anything else is refused. */
export async function readCoin(p: CallSource & HeadSource, o: { factory?: string; factories?: string[]; token: string; currency?: string; ekubo: { router: string; coreVersion: EkuboCore } }): Promise<CoinOnChain> {
  // The watermark before the state, never alongside it: otherwise a newer head could label an older state.
  const head = await p.getBlockNumber();
  const factory = o.factory ?? (o.factories?.length ? await resolveFactory(p, o.factories, o.token) : null);
  if (!factory) throw new Error(`unknown token: no followed launch factory created ${o.token}`);
  const f = hex(factory);
  const launch = await readLaunch(p, f, o.token);
  const [uri, st, params, supply, vault, launchBlock, locker, currencyOf] = await Promise.all([
    readMetadataUri(p, f, o.token), read(p, launch.curve, "state"), read(p, launch.curve, "params"), read(p, f, "supply"),
    read(p, f, "fee_vault"), read(p, launch.curve, "launch_block"), read(p, f, "locker"), read(p, f, "currency"),
  ]);
  const currency = await readCurrency(p, hex(currencyOf[0]));
  if (o.currency !== undefined && BigInt(o.currency) !== BigInt(currency.address)) throw new Error(`${o.token} trades against ${currency.symbol} (${currency.address}), not ${o.currency}`);
  const curve = decodeCurveParams(params), state = decodeCurveState(st), lockerAddress = hex(locker[0]);
  const [core, key] = await Promise.all([read(p, lockerAddress, "core"), readPoolKey(p, lockerAddress, launch.token)]);
  // The pool key as the locker builds it: its fee is the factory's trading fee.
  const route: PoolRoute = { router: o.ekubo.router, locker: lockerAddress, coin: launch.token, currency: hex(currency.address),
    coinIsToken0: BigInt(launch.token) < BigInt(currency.address), fee: "0x" + key.fee.toString(16) };
  const pool = state.graduated ? await readPool(p, hex(core[0]), route, o.ekubo.coreVersion) : null;
  const block = Number(BigInt(launchBlock[0]));
  return {
    token: launch.token, curve: launch.curve, creator: launch.creator, devTokens: launch.devTokens, metadataUri: uri, metadataSha256: launch.metadataSha256, factory: f,
    state, params: curve, launchBlock: block, buyFeeBps: buyFeeBps(curve, block, head + 1),
    supply: u256(need(supply, 2, "supply"), 0), vault: hex(vault[0]), readAt: head, route, core: hex(core[0]), coreVersion: o.ekubo.coreVersion, pool, currency,
  };
}

/** Re-reads what moves: the curve's state, its buy fee while the launch window may still be open, and, once graduated,
 *  the pool's price and liquidity (for live quotes). */
export async function refreshCoin<C extends CoinOnChain>(p: CallSource & HeadSource, coin: C): Promise<C> {
  const [st, buyFee] = await Promise.all([
    read(p, coin.curve, "state"),
    // Once normal, always normal; until then, the fee for the next block (the earliest a buy sent now can land in).
    coin.buyFeeBps === coin.params.fee_bps ? coin.buyFeeBps : p.getBlockNumber().then(b => buyFeeBps(coin.params, coin.launchBlock, b + 1)),
  ]);
  const state = decodeCurveState(st);
  const pool = state.graduated ? await readPool(p, coin.core, coin.route, coin.coreVersion) : null;
  return { ...coin, state, pool, buyFeeBps: buyFee };
}

/** The STRK side of a graduated coin's locked position's fees not yet collected, as collecting would pay them: Ekubo
 *  Core's get_position_with_fees gives the position, then fees0 and fees1; Core keeps its protocol fee from each when
 *  they're collected (ceil(fees * fee / 2^128); 20% on Sepolia's Core, none on mainnet's). */
export async function readWaitingPoolFees(p: CallSource, coin: Pick<CoinOnChain, "state" | "core" | "route">): Promise<bigint> {
  if (!coin.state.graduated) return 0n;
  const full = "0x" + (88720000).toString(16);
  const [r, coreFee] = await Promise.all([
    read(p, coin.core, "get_position_with_fees", [...poolKeyFelts(coin.route), "0x0", coin.route.locker, full, "0x1", full, "0x0"]),
    read(p, coin.core, "get_core_protocol_fee").then(v => BigInt(v[0]), () => 0n),
  ]);
  // [liquidity, fees_per_liquidity_inside_last.value0, .value1, fees0, fees1]
  const fees = BigInt(coin.route.coinIsToken0 ? r[4] : r[3]);
  return fees - (fees * coreFee + (1n << 128n) - 1n) / (1n << 128n);
}

/** A coin's fee payees (address, share in basis points) and the protocol's share, from the fee vault. */
export async function readPayees(p: CallSource, vault: string, token: string): Promise<{ protocolBps: bigint; payees: { address: string; bps: bigint }[] }> {
  const [protocol, n] = await Promise.all([read(p, hex(vault), "protocol_bps"), read(p, hex(vault), "payee_count", [hex(token)])]);
  const count = Number(BigInt(n[0]));
  if (count < 1 || count > 10) throw new Error("the coin's payees aren't available yet");
  const payees = await Promise.all(Array.from({ length: count }, (_, i) => read(p, hex(vault), "payee_at", [hex(token), "0x" + i.toString(16)])));
  return { protocolBps: BigInt(protocol[0]), payees: payees.map(r => ({ address: hex(r[0]), bps: BigInt(r[1]) })) };
}

/** What the fee vault holds for `account` from `token`'s fees (claimable now). */
export const readVaultBalance = async (p: CallSource, vault: string, token: string, account: string) =>
  u256(need(await read(p, hex(vault), "balance_of", [hex(token), hex(account)]), 2, "balance_of"), 0);

/** The calls that claim a payee's fees for a coin: flush the curve's fees to the vault and collect the pool's (when
 *  there are any), then claim. `coin` must come from readCoin on a factory you trust. */
export function claimFeeCalls(coin: Pick<CoinOnChain, "token" | "curve" | "vault" | "state" | "route">, waitingPoolFees: bigint) {
  return [
    ...(coin.state.fees > 0n ? [{ contractAddress: coin.curve, entrypoint: "flush_fees", calldata: [] as string[] }] : []),
    ...(waitingPoolFees > 0n ? [{ contractAddress: coin.route.locker, entrypoint: "collect_fees", calldata: [coin.token] }] : []),
    { contractAddress: coin.vault, entrypoint: "claim", calldata: [coin.token] },
  ];
}
