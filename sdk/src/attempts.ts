/**
 * A trade, from the moment it goes to the wallet until it's settled. It's kept (per network, account and coin: in the
 * browser's localStorage by default, or any store with its three methods) so that a lost wallet reply, a stopped wait,
 * a slow confirmation or a reload never turns into a second trade: while an attempt is unsettled, nothing new is sent
 * for that coin.
 * It settles only on proof (review 5325953, N1/N2):
 *   - its own transaction is accepted: it traded, or it reverted and nothing traded. Without a hash from the wallet,
 *     the transaction is found by its content, never by resemblance: events only point at candidates, and a
 *     candidate is this attempt only if it was sent from this account, at or after the nonce it had before the
 *     wallet was asked, with exactly this order's calls (venue, side, amount, minimum and deadline; for a pool trade,
 *     each of its calls through Ekubo's Router). A deadline isn't a unique identifier across browser tabs;
 *   - the wallet refused it (even after the page stopped waiting for its answer);
 *   - or the chain passed the deadline the trade carries (the contract enforces it), after which it can never trade.
 * A timeout, an unreachable node, an unchanged nonce or a balance change never settles it: a wallet prompt left open
 * can still be approved, so only its deadline closes it.
 *
 * Cancel frees the panel for a new trade, but never forgets a request that may still go through
 * the cancelled request moves to a separate list for its network, account and coin, kept across
 * reloads, and each one is followed on its own (by its startedAt) until the same proof settles it.
 */
import { allEvents, type EventSource } from "./events.ts";
import { EVENT, isHokoriSwap, swappedCurrencyFor, tradeFrom, type Trade, type Venue } from "./trades.ts";
import { checkTx, type Receipt, type ReceiptSource } from "./tx.ts";
import { COIN_DECIMALS, STRK_CURRENCY, knownCurrency, priceScale } from "./currency.ts";
import { decodeAccountCalls, felt, fingerprintCalls, sameCalls } from "./account-calls.ts";
import { SELECTOR } from "./selectors.ts";

export type TradeAttempt = {
  chainId: string; account: string; coin: string;
  target: string; venue: Venue; side: "buy" | "sell";
  /** A pool trade's Ekubo Core, which records it (Swapped): `target` is then the locker, the pool's extension. */
  core?: string;
  amount: string;          // offered, in base units (a decimal string: storage-safe)
  minReceive?: string;     // absent in pre-97b1b16 saved attempts: never invent it during recovery
  deadline: number;        // unix seconds, as signed
  fromBlock: number;       // a few blocks before it was sent: where to look for its trade
  nonceBefore: string;     // the account's nonce before it was sent
  startedAt: number;       // ms
  graduates?: boolean;     // a buy that takes the curve's last tokens (the curve graduates in the same call)
  /** Ordered pairs of [target, selector] and arguments (orders.ts callFingerprint), compared as decoded calls. */
  fingerprint?: string[][];
  hash?: string;           // once known: the wallet's answer (even a late one), or found on chain by its content
  failedAt?: number; walletError?: string;   // the wallet failed, or the page stopped waiting, without a hash
  refused?: boolean;       // the wallet refused it (possibly after the page stopped waiting): nothing was sent
  recoveryProblem?: string; // unreadable/unsupported saved state blocks new requests instead of silently forgetting one
  /** The coin's currency as the chain named it when the trade was sent (the ZEC launchpad, 1 Nov): the receipt's
   *  amounts are base units of it and its price is scaled by it. Absent from attempts saved before: STRK, then the only
   *  currency. */
  currency?: { address: string; decimals: number };
};
export type Settled =
  | { state: "open"; detail: string; hash?: string }   // `hash`: its transaction was found and isn't accepted yet
  | { state: "traded"; hash: string; trade: Trade | null; graduated?: boolean }
  | { state: "reverted"; hash: string; reason: string }
  | { state: "not-sent"; walletError: string }
  | { state: "expired"; hash?: string; previousOutcomeUnknown?: boolean };
export type AttemptSource = ReceiptSource & EventSource & {
  getBlockWithTxHashes(block: "latest"): Promise<unknown>;
  getNonceForAddress(address: string, block: "pre_confirmed"): Promise<string>;
  getTransactionByHash(hash: string): Promise<unknown>;
};
/** Where attempts are kept: localStorage, or anything with its three methods. */
export type AttemptStore = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
type Store = AttemptStore;

/** Allowance past the deadline, against an RPC node that answers from slightly different views of the chain. */
export const DEADLINE_MARGIN_S = 30;

const canon = (a: string) => BigInt(a).toString(16);
const keyOf = (chainId: string, account: string, coin: string) => `hokori.trade.v1:${canon(chainId)}:${canon(account)}:${canon(coin)}`;
const storage = (): Store | null => { try { return (globalThis as { localStorage?: Store }).localStorage ?? null; } catch { return null; } };

/**
 * A trade request's record couldn't be kept (no storage, or storage refused or lost it). Thrown by `saveAttempt`, which
 * is called before the wallet is asked: nothing may be signed then, since after a reload or restart nothing would stop
 * the same trade being sent twice. Thrown by `addCancelled` too: the request then stays the active one, never in neither.
 */
export class AttemptNotKept extends Error {}
const NOT_KEPT = "The trade request's record couldn't be saved, so it must not be signed: after a reload or restart nothing would stop it being sent twice";
/** A store that keeps records only while this process runs, for a consumer without browser storage (Node) that
 *  accepts it: it can't protect anything across a reload or a restart. Pass it explicitly; it is never the default. */
export function memoryAttemptStore(): AttemptStore {
  const m = new Map<string, string>();
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: k => { m.delete(k); } };
}
/** Writes `value` under `key` and reads it back; throws AttemptNotKept when it isn't kept exactly. */
function keep(store: Store | null, key: string, value: string): void {
  if (!store) throw new AttemptNotKept(`${NOT_KEPT} (no storage here: pass a durable store, or memoryAttemptStore() knowingly)`);
  let back: string | null;
  try { store.setItem(key, value); back = store.getItem(key); }
  catch (e) { throw new AttemptNotKept(`${NOT_KEPT} (${(e as Error)?.message ?? e})`); }
  if (back !== value) throw new AttemptNotKept(`${NOT_KEPT} (it didn't read back)`);
}

/** A saved attempt, checked field by field; throws if it can't be read safely or belongs to another scope. */
function parseAttempt(value: unknown, chainId: string, account: string, coin: string): TradeAttempt {
  const saved = value as TradeAttempt & { format?: number };
  if (!saved || (saved.format !== undefined && saved.format !== 2)) throw new Error("unsupported format");
  for (const k of ["chainId", "account", "coin", "target", "nonceBefore"] as const) felt(saved[k]);
  if (!same(saved.chainId, chainId) || !same(saved.account, account) || !same(saved.coin, coin)) throw new Error("wrong scope");
  const amount = (v: unknown) => typeof v === "string" && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(v) && BigInt(v) < (1n << 256n);
  if (!amount(saved.amount) || (saved.minReceive !== undefined && !amount(saved.minReceive))) throw new Error("invalid amount");
  if (![saved.deadline, saved.fromBlock, saved.startedAt].every(n => Number.isSafeInteger(n) && n >= 0)
    || !["curve", "pool"].includes(saved.venue) || !["buy", "sell"].includes(saved.side)) throw new Error("invalid attempt");
  if (saved.hash !== undefined) felt(saved.hash);
  if (saved.core !== undefined) felt(saved.core);
  if (saved.fingerprint !== undefined && !fingerprintCalls(saved.fingerprint)) throw new Error("invalid calls");
  for (const k of ["refused", "graduates"] as const) if (saved[k] !== undefined && typeof saved[k] !== "boolean") throw new Error("invalid flag");
  for (const k of ["walletError", "recoveryProblem"] as const) if (saved[k] !== undefined && typeof saved[k] !== "string") throw new Error("invalid message");
  if (saved.failedAt !== undefined && (!Number.isSafeInteger(saved.failedAt) || saved.failedAt < 0)) throw new Error("invalid failure time");
  if (saved.currency !== undefined) {
    const c = saved.currency;
    felt(c?.address);
    if (!Number.isInteger(c.decimals) || c.decimals < 0 || c.decimals > COIN_DECIMALS) throw new Error("invalid currency");
    const known = knownCurrency(c.address);   // STRK or ZEC only with their own decimals
    if (known && known.decimals !== c.decimals) throw new Error("invalid currency");
  }
  const { format: _format, ...attempt } = saved;
  return attempt;
}

/** The guard a record stands for when it can't be read: never taken as "nothing pending". */
const unreadable = (chainId: string, account: string, coin: string, recoveryProblem: string): TradeAttempt => ({ chainId, account, coin, target: coin,
  venue: "curve", side: "buy", amount: "0", deadline: 0, fromBlock: 0, nonceBefore: "0", startedAt: 0, recoveryProblem });

/** The saved trade request for (chain, account, coin), or null when there is none. A store that fails to answer is not
 *  "none": the guard stands, with a recovery problem to show. (No store at all: nothing can have been saved there.) */
export function loadAttempt(chainId: string, account: string, coin: string, store = storage()): TradeAttempt | null {
  let raw: string | null;
  try { raw = store?.getItem(keyOf(chainId, account, coin)) ?? null; }
  catch { return unreadable(chainId, account, coin, "Saved trade requests couldn't be read just now. Check your wallet's activity before trading again."); }
  if (raw === null) return null;
  try {
    return parseAttempt(JSON.parse(raw), chainId, account, coin);
  } catch {
    // Keep the guard when an existing record can't be understood. A missing/invalid field isn't proof of no send.
    return unreadable(chainId, account, coin, "This saved trade request couldn't be read safely. Check your wallet's activity before clearing the saved request.");
  }
}
/** Saves `a` and reads it back. Call it before the wallet is asked: it throws AttemptNotKept when the record isn't kept,
 *  and then nothing may be signed. (Without browser storage, pass a durable store.) */
export function saveAttempt(a: TradeAttempt, store = storage()): void {
  // Keep the existing key so older tabs still see the guard. The payload is versioned; unversioned records are read above.
  keep(store, keyOf(a.chainId, a.account, a.coin), JSON.stringify({ ...a, format: 2 }));
}
/** Removes the saved attempt if it's still `a` (never a newer one saved since, by this tab or another). An unreadable
 *  record goes only when `a` is the guard standing for it (recoveryProblem), on the viewer's explicit request. */
export function clearAttempt(a: TradeAttempt, store = storage()) {
  try {
    const key = keyOf(a.chainId, a.account, a.coin), raw = store?.getItem(key) ?? null;
    if (raw === null) return;
    if (!a.recoveryProblem && (JSON.parse(raw) as { startedAt?: unknown } | null)?.startedAt !== a.startedAt) return;
    store?.removeItem(key);
  } catch { /* storage unavailable, or a record that isn't this attempt */ }
}

const cancelledKeyOf = (chainId: string, account: string, coin: string) => `hokori.trade-cancelled.v1:${canon(chainId)}:${canon(account)}:${canon(coin)}`;
/** Requests cancelled while they could still be sent, for this network, account and coin. An entry that can't be read
 *  safely is left out (it can't be followed). */
export function loadCancelled(chainId: string, account: string, coin: string, store = storage()): TradeAttempt[] {
  let list: unknown;
  try { list = JSON.parse(store?.getItem(cancelledKeyOf(chainId, account, coin)) ?? "[]"); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const out: TradeAttempt[] = [];
  for (const item of list) { try { out.push(parseAttempt(item, chainId, account, coin)); } catch { /* unreadable entry */ } }
  return out;
}
/** Writes the cancelled list, throwing AttemptNotKept when it isn't kept; an empty list removes it. */
function saveCancelled(scope: TradeAttempt, list: TradeAttempt[], store: Store | null) {
  const key = cancelledKeyOf(scope.chainId, scope.account, scope.coin);
  if (list.length) keep(store, key, JSON.stringify(list.map(a => ({ ...a, format: 2 }))));
  else try { store?.removeItem(key); } catch { /* left listed: still followed, never lost */ }
}
/** Moves `a` to the cancelled list (before the caller clears it as the active attempt: it's never in neither). Throws
 *  AttemptNotKept when the list isn't kept: the caller must then leave `a` the active attempt. */
export function addCancelled(a: TradeAttempt, store = storage()) {
  saveCancelled(a, [...loadCancelled(a.chainId, a.account, a.coin, store).filter(x => x.startedAt !== a.startedAt), a], store);
}
/** Updates `a` (matched by startedAt) if it's still listed: a late hash, or one found on chain. Best effort: if it isn't
 *  kept, the entry stays listed without it, still followed. */
export function updateCancelled(a: TradeAttempt, store = storage()) {
  const list = loadCancelled(a.chainId, a.account, a.coin, store);
  if (list.some(x => x.startedAt === a.startedAt)) try { saveCancelled(a, list.map(x => (x.startedAt === a.startedAt ? a : x)), store); } catch { /* still listed */ }
}
/** Removes `a` once its outcome is proven (or the wallet refused it). Best effort: if it isn't kept, it stays listed. */
export function removeCancelled(a: TradeAttempt, store = storage()) {
  try { saveCancelled(a, loadCancelled(a.chainId, a.account, a.coin, store).filter(x => x.startedAt !== a.startedAt), store); } catch { /* still listed */ }
}

/** A wallet's refusal: the user said no, so nothing was sent. (Wallets word it differently; code 113 is the Wallet
 *  API's USER_REFUSED_OP.) Anything else without a hash may have been sent. */
export function isRefusal(e: unknown): boolean {
  const err = e as { code?: number; message?: string } | null;
  return err?.code === 113 || err?.code === 4001
    || /USER_REFUSED_OP|user (rejected|refused|declined|denied|aborted|cancell?ed)|(rejected|cancell?ed|declined) by (the )?user|user abort/i.test(String(err?.message ?? e));
}

const same = (a: string, b: string) => BigInt(a) === BigInt(b);

/** The attempt's trade in a receipt (its own transaction, from this account): the curve's event for this account, or
 *  Core's Swapped event for this coin's pool (the locker has no swap hooks, so Core's event is the record). Its price is
 *  in whole currency per whole token, in the attempt's currency (a ZEC trade's was 10^10 too
 *  small); an attempt saved before currencies were recorded is STRK's, as before. */
export function tradeInReceipt(receipt: Receipt, a: TradeAttempt, hash: string): Trade | null {
  const paid = a.currency ?? STRK_CURRENCY, scale = priceScale(paid);
  for (const e of receipt.events ?? []) {
    if (a.venue === "pool") {
      const currency = a.core && isHokoriSwap(e, a.core, new Set([hexOf(a.target)])) ? swappedCurrencyFor(e, a.coin) : null;
      // The coin's pool against its own currency only (an attempt with none recorded: any, as before).
      if (!currency || (a.currency && !same(currency, a.currency.address))) continue;
      const t = tradeFrom({ ...e, transaction_hash: hash, block_number: receipt.block_number }, "pool", 0, currency, a.account, scale);
      if (t) return t;
      continue;
    }
    if (!same(e.from_address, a.target) || e.keys.length < 2 || !same(e.keys[1], a.account)) continue;
    const t = tradeFrom({ ...e, transaction_hash: hash, block_number: receipt.block_number }, a.venue, 0, paid.address, undefined, scale);
    if (t) return t;
  }
  return null;
}
const hexOf = (v: string) => "0x" + BigInt(v).toString(16).padStart(64, "0");

/** Whether the receipt carries the curve's graduation (a buy-out sent together with it). */
const graduatedIn = (receipt: Receipt, a: TradeAttempt) =>
  (receipt.events ?? []).some(e => same(e.from_address, a.target) && e.keys.length > 0 && same(e.keys[0], EVENT.GRAD));

const U128 = (1n << 128n) - 1n;
const felts = (v: bigint) => [v & U128, v >> 128n];

/** Match actual decoded calls, binding every argument to its target/selector. A new fingerprint matches the whole
 * multicall, in order, without extra calls. Older complete records match one unambiguous trade call at their target. */
export function isAttemptTx(tx: { sender_address?: string; nonce?: string; calldata?: string[] }, a: TradeAttempt): boolean {
  try {
    if (!tx.sender_address || !same(tx.sender_address, a.account)) return false;
    if (tx.nonce === undefined || felt(tx.nonce) < felt(a.nonceBefore)) return false;
    const calls = decodeAccountCalls(tx.calldata ?? []);
    if (!calls) return false;
    if (a.fingerprint) { const expected = fingerprintCalls(a.fingerprint); return !!expected && sameCalls(calls, expected); }
    if (a.minReceive === undefined) return false; // an incomplete legacy order cannot be identified by resemblance
    const args = [...felts(BigInt(a.amount)), ...felts(BigInt(a.minReceive)), BigInt(a.deadline)];
    const trades = calls.filter(c => c.target === BigInt(a.target) && [SELECTOR.buy, SELECTOR.sell].some(s => c.selector === BigInt(s)));
    return trades.length === 1 && sameCalls(trades, [{ target: BigInt(a.target), selector: BigInt(SELECTOR[a.side]), args }]);
  } catch { return false; }
}

/** A transaction this account sent before the attempt (a lower nonce): it can't be the attempt. */
function earlierOwnTx(tx: { sender_address?: string; nonce?: string }, a: TradeAttempt): boolean {
  try { return !!tx.sender_address && same(tx.sender_address, a.account) && tx.nonce !== undefined && felt(tx.nonce) < felt(a.nonceBefore); }
  catch { return false; }
}

/** The attempt's own transaction among the trades at its curve (this account's) or its coin's pool since it started, if
 *  it has landed. A pool's swaps are Core's Swapped events, which don't name the trader: each candidate's sender is
 *  checked with the rest of the transaction. */
async function findAttemptTx(provider: AttemptSource, a: TradeAttempt, head: number): Promise<{ hash: string | null; unidentified: boolean }> {
  // Without Core's address (a pool request saved before it was recorded) its trades can't be searched: its outcome is
  // then unknown at its deadline, never "nothing traded".
  if (a.venue === "pool" && !a.core) return { hash: null, unidentified: true };
  const events = a.venue === "curve"
    ? await allEvents(provider, { address: a.target, keys: [[EVENT.BUY, EVENT.SELL], [a.account]], from: a.fromBlock, to: head })
    : (await allEvents(provider, { address: a.core!, keys: [[EVENT.SWAPPED]], from: a.fromBlock, to: head }))
      .filter(e => isHokoriSwap(e, a.core!, new Set([hexOf(a.target)])) && swappedCurrencyFor(e, a.coin) !== null);
  const candidates = [...new Set(events.map(e => e.transaction_hash))];
  const matches: string[] = [];
  let unidentified = false;
  for (const h of candidates) {
    const tx = await provider.getTransactionByHash(h) as { sender_address?: string; nonce?: string; calldata?: string[] };
    if (isAttemptTx(tx, a)) matches.push("0x" + BigInt(h).toString(16));
    // Any other trade by this account at this coin since the attempt began might still be this attempt: a wallet that
    // changed or added calls, a relayer that sent them for the account, another device. Only the account's own earlier
    // transactions are ruled out. At expiry its outcome is then reported as unknown, never as "nothing traded".
    else if (!earlierOwnTx(tx, a)) unidentified = true;
  }
  return { hash: matches.length === 1 ? matches[0] : null, unidentified: unidentified || matches.length > 1 };
}

/** A provider's "this account isn't on Starknet yet" (code 20, Contract not found), as starknet.js passes it on: a
 *  brand-new account, which its wallet deploys with its first transaction. */
const notOnChainYet = (e: unknown): boolean => {
  const text = e instanceof Error ? e.message : String(e ?? "");
  return /Contract not found|CONTRACT_NOT_FOUND/i.test(text) || (e as { code?: unknown })?.code === 20
    || (e as { baseError?: { code?: unknown } })?.baseError?.code === 20;
};

/** One look at an attempt. Throws only when the chain can't be read (the attempt stays open). */
export async function settleAttempt(provider: AttemptSource, a: TradeAttempt): Promise<Settled> {
  if (a.recoveryProblem) return { state: "open", detail: a.recoveryProblem };
  if (a.refused) return { state: "not-sent", walletError: a.walletError || "You declined in your wallet" };
  const head = await provider.getBlockWithTxHashes("latest") as { block_number: number; timestamp: number };
  const found = a.hash ? { hash: a.hash, unidentified: false } : await findAttemptTx(provider, a, head.block_number);
  const hash = found.hash;
  if (hash) {
    const c = await checkTx(provider, hash);
    if (c.state === "succeeded") return { state: "traded", hash, trade: tradeInReceipt(c.receipt, a, hash), graduated: graduatedIn(c.receipt, a) };
    if (c.state === "reverted") return { state: "reverted", hash, reason: c.reason };
    if (c.state === "pending") return { state: "open", hash, detail: "Starknet has it but hasn't accepted it yet." };
  }
  // Past the deadline (on the chain's clock) with no trade of its own seen, it can never trade: the contract refuses it.
  // Decided before the nonce is read, which only words the open state (a brand-new account's
  // nonce read failed, so its first trade's request never expired).
  if (head.timestamp > a.deadline + DEADLINE_MARGIN_S) return { state: "expired", hash: hash ?? undefined,
    ...(found.unidentified || (!a.hash && a.minReceive === undefined && !a.fingerprint) ? { previousOutcomeUnknown: true } : {}) };
  if (hash) return { state: "open", hash, detail: "The network hasn't seen the transaction yet." };
  // Without its transaction, nothing short of the deadline proves it can't still be sent: a prompt left open in the
  // wallet can be approved later, and an account not on Starknet yet is no proof either (its wallet deploys it with that
  // very transaction). The nonce only tells the viewer whether anything went out meanwhile; a brand-new account's is 0.
  let nonce: bigint;
  try { nonce = BigInt(await provider.getNonceForAddress(a.account, "pre_confirmed")); }
  catch (e) { if (!notOnChainYet(e)) throw e; nonce = 0n; }
  const moved = nonce > BigInt(a.nonceBefore);
  return { state: "open", detail: moved ? "Your account has sent a transaction since; looking for this trade." : "Nothing from your wallet yet. If it still shows the request, approve or reject it there." };
}
