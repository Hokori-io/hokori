// A scripted Starknet provider answering Hokori's reads for one coin (factory, curve, locker, Ekubo Core, fee vault), as
// the contracts lay out their return values. Shared by the SDK's tests.
import { ONE, byteArrayFelts, curveParams, ekuboFeeFor } from "../src/index.ts";
import { NETWORKS } from "../src/networks.ts";

export const U128 = (1n << 128n) - 1n;
export const u = v => ["0x" + (v & U128).toString(16), "0x" + (v >> 128n).toString(16)];
export const hex = v => "0x" + BigInt(v).toString(16).padStart(64, "0");
export const P = curveParams({ v0: 30n * ONE, t0: 1_073_000_000n * ONE, curve_tokens: 793_100_000n * ONE, x_reserve: 206_900_000n * ONE, min_trade: 10n ** 12n,
  fee_bps: 90n, grad_fee_bps: 100n, sniper_fee_bps: 9900n, sniper_blocks: 2n });
export const paramsFelts = p => [...u(p.v0), ...u(p.t0), ...u(p.curve_tokens), ...u(p.x_reserve), ...u(p.min_trade), String(p.fee_bps), String(p.grad_fee_bps), String(p.sniper_fee_bps), String(p.sniper_blocks)];
export const TOKEN = "0x1dab", CURVE = "0x2001", FACTORY = "0xfac", LOCKER = "0x4000", CORE = "0xc0de", VAULT = "0x7a017", STRK = NETWORKS.sepolia.strk;
/** An earlier factory that didn't launch TOKEN (a site may follow several). */
export const OTHER_FACTORY = "0xfab";

/** A provider answering Hokori's reads for one coin: on its curve, or graduated into its pool. */
export function provider({ graduated = false, head = 100, launchBlock = 100, maxDev = true, q = 40n * ONE, t = 1_000_000_000n * ONE, sold = 73_000_000n * ONE, chainId = NETWORKS.sepolia.chainId, currency = STRK } = {}) {
  const calls = [];
  let headRead = false;
  const answers = {
    [`${FACTORY}:launch_of`]: c => (BigInt(c[0]) === BigInt(TOKEN) ? [TOKEN, CURVE, "0xc0", ...u(5n * ONE), ...u(0xabcn)] : Promise.reject(new Error("Execution failed: 'factory: unknown token'"))),
    // curve_of: the coin's curve, or zero for any other address (how a reader finds which factory launched a coin).
    [`${FACTORY}:curve_of`]: c => [BigInt(c[0]) === BigInt(TOKEN) ? CURVE : "0x0"],
    [`${OTHER_FACTORY}:curve_of`]: () => ["0x0"],
    [`${FACTORY}:metadata_uri`]: () => byteArrayFelts("ar://meta").map(v => "0x" + v.toString(16)),
    [`${FACTORY}:supply`]: () => u(1_000_000_000n * ONE), [`${FACTORY}:fee_vault`]: () => [VAULT], [`${FACTORY}:locker`]: () => [LOCKER],
    [`${FACTORY}:curve_params`]: () => paramsFelts(P), [`${FACTORY}:currency`]: () => [currency], [`${FACTORY}:address_rule`]: () => ["0xdab", "0x3"],
    [`${FACTORY}:token_class`]: () => ["0xc1a55"], [`${FACTORY}:launch_fee`]: () => u(0n), [`${FACTORY}:protocol`]: () => ["0x7ea"],
    [`${FACTORY}:max_dev_tokens`]: () => (maxDev ? u(99_900_000n * ONE) : Promise.reject(new Error("Requested entrypoint does not exist: ENTRYPOINT_NOT_FOUND"))),
    [`${CURVE}:state`]: () => [...u(q), ...u(t), ...u(sold), ...u(10n * ONE), ...u(ONE / 10n), graduated ? "0x0" : "0x1", graduated ? "0x1" : "0x0", LOCKER],
    [`${CURVE}:params`]: () => paramsFelts(P), [`${CURVE}:launch_block`]: () => [String(launchBlock)],
    [`${LOCKER}:core`]: () => [CORE], [`${LOCKER}:pool_key`]: () => (BigInt(TOKEN) < BigInt(currency) ? [TOKEN, currency] : [currency, TOKEN]).concat(["0x" + ekuboFeeFor(90n).toString(16), "0x4e20", LOCKER]),
    [`${CORE}:get_pool_price`]: () => [...u(1n << 127n), "0x5", "0x1"], [`${CORE}:get_pool_liquidity`]: () => ["0x1234"],
    [`${VAULT}:protocol_bps`]: () => ["0x5dc"], [`${VAULT}:payee_count`]: () => ["0x2"],
    [`${VAULT}:payee_at`]: c => (Number(BigInt(c[1])) === 0 ? ["0xa1", "0x1770"] : ["0xa2", "0xfa0"]),
  };
  return {
    calls,
    async getBlockNumber() { headRead = true; return head; },
    async getChainId() { return chainId; },
    /** No events: enough for a market feed's first poll (the factories' settings, an empty market). */
    async getEvents() { return { events: [] }; },
    async getBlockWithTxHashes(n) { return { block_number: n, block_hash: "0x" + (0xb10c00 + Number(n)).toString(16), timestamp: 1_000_000 + Number(n) }; },
    async callContract({ contractAddress, entrypoint, calldata }) {
      calls.push({ address: BigInt(contractAddress), entrypoint, headRead });
      const key = Object.keys(answers).find(k => { const [a, e] = k.split(":"); return BigInt(a) === BigInt(contractAddress) && e === entrypoint; });
      if (!key) throw new Error(`unscripted ${contractAddress} ${entrypoint}`);
      return answers[key](calldata);
    },
  };
}

