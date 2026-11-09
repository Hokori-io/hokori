/**
 * Who holds a coin, from its ERC-20 Transfer events (OpenZeppelin's: `Transfer { #[key] from, #[key] to, value: u256 }`,
 * so keys are [selector, from, to] and data is the value's two halves). A coin's whole supply is minted once, at its
 * launch, from the zero address; a transfer to the zero address is a burn (the sale contracts burn what they no longer
 * need, and holders may burn their own). Shared by the market-data service, the site's reader of its files and the
 * verifier, so all three fold transfers the same way.
 *
 * The holder count leaves out Hokori's own contracts and the zero address: the coin's curve, Ekubo Core (which holds a
 * graduated coin's pool reserve), the factory's locker, its fee vault and the factory itself. They're still listed
 * among the top holders, labelled, so a page can show where the supply sits.
 *
 * Starknet's STRK20 privacy pool is labelled too ("privacy"): what it
 * holds is the coin's shielded supply, owned by any number of people, so it is neither counted as a holder nor taken
 * for one whale. Holder counts and shares are observations of public accounts only.
 */
import { EVENT } from "./trades.ts";

export type HolderLabel = "curve" | "pool" | "locker" | "vault" | "factory" | "privacy";
export const HOLDER_LABELS: readonly HolderLabel[] = ["curve", "pool", "locker", "vault", "factory", "privacy"];
/** The top holders a coin's file lists. */
export const TOP_HOLDERS = 100;

export type CoinTransfer = { token: string; block: number; seq: number; tx: string; from: string; to: string; value: bigint };
export type PublishedHolders = {
  /** Addresses holding any of the coin, not counting Hokori's contracts or the zero address. */
  count: number;
  /** The largest balances, largest first (ties by address), Hokori's contracts among them and labelled. */
  top: { address: string; balance: bigint; label?: HolderLabel }[];
  /** Everything sent to the zero address. */
  burned: bigint;
  /** The block the balances are complete to. */
  atBlock: number;
};

const ZERO = "0x" + "0".repeat(64);
const hex = (v: string | bigint) => "0x" + BigInt(v).toString(16).padStart(64, "0");
const u256 = (d: string[], i: number) => BigInt(d[i]) + (BigInt(d[i + 1]) << 128n);

/** A coin transfer from a Transfer event emitted by `token`, or null for anything else. */
export function transferFrom(e: { keys: string[]; data: string[]; block_number?: number; transaction_hash: string }, token: string, seq: number): CoinTransfer | null {
  if (e.keys.length < 3 || e.data.length < 2 || BigInt(e.keys[0]) !== BigInt(EVENT.TRANSFER)) return null;
  return { token: hex(token), block: e.block_number ?? 0, seq, tx: e.transaction_hash, from: hex(e.keys[1]), to: hex(e.keys[2]), value: u256(e.data, 0) };
}

/** Applies one transfer to `balances` (address → amount; an address that empties is removed). Returns the amount it
 *  burned. A transfer from the zero address is a mint. */
export function applyTransfer(balances: Map<string, bigint>, t: { from: string; to: string; value: bigint }): bigint {
  if (t.from !== ZERO) {
    const left = (balances.get(t.from) ?? 0n) - t.value;
    if (left === 0n) balances.delete(t.from); else balances.set(t.from, left);
  }
  if (t.to === ZERO) return t.value;
  balances.set(t.to, (balances.get(t.to) ?? 0n) + t.value);
  return 0n;
}

/** The holder count and top holders of `balances`. `protocol` names Hokori's contracts (address → label). */
export function summarizeHolders(balances: Map<string, bigint>, protocol: Map<string, HolderLabel>, limit = TOP_HOLDERS) {
  let count = 0;
  const held: { address: string; balance: bigint }[] = [];
  for (const [address, balance] of balances) {
    if (balance <= 0n) continue;
    if (!protocol.has(address)) count++;
    held.push({ address, balance });
  }
  held.sort((a, b) => (a.balance === b.balance ? (a.address < b.address ? -1 : 1) : a.balance > b.balance ? -1 : 1));
  return { count, top: held.slice(0, limit).map(h => ({ ...h, ...(protocol.has(h.address) ? { label: protocol.get(h.address)! } : {}) })) };
}

/** Hokori's contracts that may hold a coin, and Starknet's privacy pool (`privacy`: shielded balances), labelled. */
export function protocolHolders(o: { curve: string; core?: string; locker?: string; vault?: string; factory?: string; privacy?: string }): Map<string, HolderLabel> {
  const m = new Map<string, HolderLabel>();
  const add = (a: string | undefined, label: HolderLabel) => { if (a) m.set(hex(a), label); };
  add(o.privacy, "privacy"); add(o.factory, "factory"); add(o.vault, "vault"); add(o.locker, "locker"); add(o.core, "pool"); add(o.curve, "curve");
  return m;
}
/** What the privacy pool holds of a coin (its shielded supply), from the published top holders; 0 when it isn't among
 *  them. */
export const shieldedSupply = (top: readonly { balance: bigint; label?: HolderLabel }[]) => top.find(h => h.label === "privacy")?.balance ?? 0n;

export const holdersJson = (h: PublishedHolders) => ({ count: h.count, top: h.top.map(x => ({ ...x, balance: String(x.balance) })), burned: String(h.burned), atBlock: h.atBlock });

const AMOUNT = /^[0-9]{1,78}$/, ADDRESS = /^0x[0-9a-f]{64}$/;
/** A coin file's `holders`, checked; undefined if absent or not usable (a page then shows no holder figures, but the
 *  coin's trades and state are unaffected). */
export function holdersFromJson(j: unknown): PublishedHolders | undefined {
  if (!j || typeof j !== "object") return undefined;
  const h = j as Record<string, unknown>;
  if (!Number.isSafeInteger(h.count) || (h.count as number) < 0 || !Number.isSafeInteger(h.atBlock) || (h.atBlock as number) < 0) return undefined;
  if (typeof h.burned !== "string" || !AMOUNT.test(h.burned) || !Array.isArray(h.top) || h.top.length > TOP_HOLDERS) return undefined;
  const top: PublishedHolders["top"] = [];
  for (const x of h.top as Record<string, unknown>[]) {
    if (!x || typeof x.address !== "string" || !ADDRESS.test(x.address) || typeof x.balance !== "string" || !AMOUNT.test(x.balance)) return undefined;
    if (x.label !== undefined && !HOLDER_LABELS.includes(x.label as HolderLabel)) return undefined;
    const balance = BigInt(x.balance);
    if (balance <= 0n || (top.length && balance > top[top.length - 1].balance)) return undefined;   // largest first
    top.push({ address: x.address, balance, ...(x.label ? { label: x.label as HolderLabel } : {}) });
  }
  return { count: h.count as number, top, burned: BigInt(h.burned), atBlock: h.atBlock as number };
}
