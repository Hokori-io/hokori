// Where the factory deploys a coin, and the search for a salt that gives the required address ending (Hokori:
// "...dab"). Mirrors contracts/src/factory.cairo: the coin is deployed by the factory with
//   deploy_salt = poseidon(creator, salt)
//   address = pedersen_chain(["STARKNET_CONTRACT_ADDRESS", factory, deploy_salt, token_class, hash(calldata)]) mod (2^251 - 256)
// where calldata = [name (ByteArray), symbol (ByteArray), supply (u256), factory].
// The hash functions are passed in (e.g. from @scure/starknet), so this module has no dependencies and runs in the
// browser, in Web Workers and in Node alike.
import type { IntLike } from "./math.ts";

const PREFIX = 0x535441524b4e45545f434f4e54524143545f41444452455353n;   // 'STARKNET_CONTRACT_ADDRESS'
const ADDR_BOUND = 2n ** 251n - 256n;
const U128 = (1n << 128n) - 1n;

/** A string as Cairo serializes a ByteArray: [full 31-byte words count, ...words, pending word, pending length]. */
export function byteArrayFelts(text: string): bigint[] {
  const bytes = new TextEncoder().encode(text);
  const word = (b: Uint8Array) => b.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);
  const full = Math.floor(bytes.length / 31);
  const out = [BigInt(full)];
  for (let i = 0; i < full; i++) out.push(word(bytes.subarray(i * 31, i * 31 + 31)));
  const rest = bytes.subarray(full * 31);
  out.push(word(rest), BigInt(rest.length));
  return out;
}

/** The coin's constructor calldata, exactly as the factory builds it. */
export function tokenCalldata({ name, symbol, supply, factory }: { name: string; symbol: string; supply: IntLike; factory: IntLike }): bigint[] {
  const s = BigInt(supply);
  return [...byteArrayFelts(name), ...byteArrayFelts(symbol), s & U128, s >> 128n, BigInt(factory)];
}

/** The two Starknet hashes the address needs (e.g. @scure/starknet's); bigint or hex results both work. */
export type Hashes = { pedersen(a: bigint, b: bigint): bigint | string; poseidonHashMany(values: bigint[]): bigint | string };
/** Everything that stays fixed while searching salts for one creator and one name/ticker. */
export type AddressPrep = { creator: bigint; classHash: bigint; calldataHash: bigint; prefix: bigint };

/** Address tools over the given hash functions. */
export function coinAddressTools(hashes: Hashes) {
  const h = (a: bigint, b: bigint) => BigInt(hashes.pedersen(a, b));
  const onElements = (values: IntLike[]) => { let acc = 0n; for (const v of values) acc = h(acc, BigInt(v)); return h(acc, BigInt(values.length)); };
  const deploySalt = (creator: IntLike, salt: IntLike) => BigInt(hashes.poseidonHashMany([BigInt(creator), BigInt(salt)]));

  function prepare({ factory, tokenClass, name, symbol, supply, creator }: { factory: IntLike; tokenClass: IntLike; name: string; symbol: string; supply: IntLike; creator: IntLike }): AddressPrep {
    return {
      creator: BigInt(creator), classHash: BigInt(tokenClass),
      calldataHash: onElements(tokenCalldata({ name, symbol, supply, factory })),
      prefix: h(h(0n, PREFIX), BigInt(factory)),   // the chain's first two steps are the same for every salt
    };
  }

  /** The coin's address for `salt`. */
  function addressFor(prep: AddressPrep, salt: IntLike): bigint {
    let acc = h(prep.prefix, deploySalt(prep.creator, salt));
    acc = h(acc, prep.classHash);
    acc = h(acc, prep.calldataHash);
    return h(acc, 5n) % ADDR_BOUND;
  }

  /** Searches salts start, start+step, ... for an address ending in `suffix` (`digits` hex digits). Returns the first
   *  hit, or null after `limit` tries. `onTry(tries)` is called every 64 tries (for progress and cancellation:
   *  return false from it to stop). */
  function search(prep: AddressPrep, { suffix, digits, start = 0n, step = 1n, limit = Infinity, onTry }:
    { suffix: IntLike; digits: number; start?: IntLike; step?: IntLike; limit?: number; onTry?: (tries: number) => boolean | void }): { salt: bigint; address: bigint; tries: number } | null {
    const mod = 16n ** BigInt(digits), want = BigInt(suffix);
    let salt = BigInt(start);
    for (let tries = 1; tries <= limit; tries++, salt += BigInt(step)) {
      const address = addressFor(prep, salt);
      if (address % mod === want) return { salt, address, tries };
      if (onTry && tries % 64 === 0 && onTry(tries) === false) return null;
    }
    return null;
  }

  return { onElements, deploySalt, prepare, addressFor, search };
}

/** Does `address` end in the rule's digits? */
export const hasEnding = (address: IntLike, suffix: IntLike, digits: IntLike): boolean =>
  (Number(digits) === 0 ? true : BigInt(address) % 16n ** BigInt(digits) === BigInt(suffix));

/** Reads a Cairo-serialized ByteArray from `felts` at `offset` (inverse of byteArrayFelts). Returns the text (UTF-8)
 *  and the offset after it. Malformed input throws rather than guessing. */
export function byteArrayFromFelts(felts: readonly (bigint | string)[], offset = 0): { text: string; next: number } {
  const n = Number(BigInt(felts[offset]));
  if (!Number.isSafeInteger(n) || n < 0 || offset + n + 3 > felts.length) throw new Error("malformed ByteArray");
  const bytes: number[] = [];
  const push = (word: bigint, len: number) => { for (let i = len - 1; i >= 0; i--) bytes.push(Number((word >> BigInt(8 * i)) & 0xffn)); };
  for (let i = 0; i < n; i++) push(BigInt(felts[offset + 1 + i]), 31);
  const pendingLen = Number(BigInt(felts[offset + 2 + n]));
  if (pendingLen > 30) throw new Error("malformed ByteArray");
  push(BigInt(felts[offset + 1 + n]), pendingLen);
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes)), next: offset + 3 + n };
}
