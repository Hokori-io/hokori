/**
 * A launchpad's currency (a ZEC launchpad beside the STRK one). Every
 * coin has 18 decimals; the currency may have fewer (ZEC has 8). Prices are published and shown as whole currency per
 * whole token, so a price read from the chain, in base units per base unit, is scaled by 10^(18 - the currency's
 * decimals): 1 for STRK, 10^10 for ZEC. Amounts of currency are divided by 10^decimals.
 */
import { STRK } from "./trades.ts";
import { byteArrayFromFelts } from "./address.ts";

export type Currency = { address: string; symbol: string; decimals: number };

/** Every coin's decimals (contracts/src/token.cairo). */
export const COIN_DECIMALS = 18;
export const STRK_CURRENCY: Currency = { address: STRK, symbol: "STRK", decimals: 18 };
/** NEAR's bridged ZEC on Starknet mainnet (the Omni Bridge mints it), the ZEC launchpad's currency. */
export const ZEC_MAINNET: Currency = { address: "0x05ce53b9b68fb8e9ecab9283a96d97948914733fd6ed8d9a53a276a419497841", symbol: "ZEC", decimals: 8 };
/** strkBTC, Bitcoin on Starknet mainnet (StarkGate's mintable token, minted by its bridge), the BTC launchpad's
 *  currency. Its own symbol is "strkBTC"; pages show it as BTC. */
export const STRKBTC_MAINNET: Currency = { address: "0x0787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135", symbol: "strkBTC", decimals: 8 };

/** What a price in base units per base unit is multiplied by to give whole currency per whole token. */
export function priceScale(currency?: Pick<Currency, "decimals">): number {
  return 10 ** (COIN_DECIMALS - (currency?.decimals ?? COIN_DECIMALS));
}

/** An amount of currency in whole units, for figures (volumes): display only. */
export function currencyUnits(amount: bigint, currency?: Pick<Currency, "decimals">): number {
  return Number(amount) / 10 ** (currency?.decimals ?? COIN_DECIMALS);
}

/** The currencies Hokori's launchpads use, known without a read. */
export const KNOWN_CURRENCIES: readonly Currency[] = [STRK_CURRENCY, ZEC_MAINNET, STRKBTC_MAINNET];
/** A known currency by its token's address, or null. */
export function knownCurrency(address: string): Currency | null {
  return KNOWN_CURRENCIES.find(c => BigInt(c.address) === BigInt(address)) ?? null;
}
type Caller = { callContract(call: { contractAddress: string; entrypoint: string; calldata: string[] }): Promise<string[]> };
/** One short string (a felt holding up to 31 ASCII bytes) as text. */
const shortText = (felt: string) => { let v = BigInt(felt), out = ""; while (v > 0n) { out = String.fromCharCode(Number(v & 0xffn)) + out; v >>= 8n; } return out; };
/** A launchpad's currency by its token's address: a known one without a read, any other by its token's own `symbol`
 *  (a ByteArray, or one short string from older tokens) and `decimals`. */
export async function readCurrency(p: Caller, address: string): Promise<Currency> {
  const known = knownCurrency(address);
  if (known) return known;
  const [symbol, decimals] = await Promise.all([
    p.callContract({ contractAddress: address, entrypoint: "symbol", calldata: [] }),
    p.callContract({ contractAddress: address, entrypoint: "decimals", calldata: [] }),
  ]);
  const d = Number(BigInt(decimals[0]));
  if (!Number.isInteger(d) || d < 0 || d > COIN_DECIMALS) throw new Error(`the currency ${address} reports ${d} decimals`);
  return { address: "0x" + BigInt(address).toString(16).padStart(64, "0"), symbol: symbol.length === 1 ? shortText(symbol[0]) : byteArrayFromFelts(symbol).text, decimals: d };
}

/** A currency as published (market.json's factory settings), or null when malformed. A known token (STRK, ZEC) must be
 *  published exactly as it is: its own symbol and decimals; and a known symbol on any other token is refused (review
 *  2026-11-01 C1/C2 R1: ZEC published with 18 decimals made an amount typed as 0.0000000001 ZEC quote one whole ZEC,
 *  and a forged "ZEC" symbol could select ZEC's dollar price for another token). */
export function currencyFromJson(v: unknown): Currency | null {
  const c = v as Partial<Currency> | null;
  if (!c || typeof c !== "object" || typeof c.address !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(c.address)
    || typeof c.symbol !== "string" || !/^[A-Za-z0-9.]{1,12}$/.test(c.symbol)
    || typeof c.decimals !== "number" || !Number.isInteger(c.decimals) || c.decimals < 0 || c.decimals > COIN_DECIMALS) return null;
  const known = knownCurrency(c.address);
  if (known) return known.symbol === c.symbol && known.decimals === c.decimals ? known : null;
  if (KNOWN_CURRENCIES.some(k => k.symbol.toUpperCase() === c.symbol!.toUpperCase())) return null;
  return { address: c.address, symbol: c.symbol, decimals: c.decimals };
}

/** The same currency, by the same token and the same decimals: what an amount was quoted in, against what the chain says
 *  the coin trades in. */
export const sameCurrency = (a: Pick<Currency, "address" | "decimals">, b: Pick<Currency, "address" | "decimals">) =>
  BigInt(a.address) === BigInt(b.address) && a.decimals === b.decimals;
