/**
 * One receipt policy for everything Hokori's site and bots send: launches, trades, graduations and fee claims. A transaction is
 * done only once Starknet has ACCEPTED it (on L2 or L1), and then only if it executed successfully. An accepted but
 * reverted transaction is a failure that changed nothing but the network fee. Anything short of acceptance (received,
 * pre-confirmed, a hash the node doesn't know yet, a node that can't be reached) is still pending, never a failure.
 */
export type ReceiptEvent = { from_address: string; keys: string[]; data: string[] };
export type Receipt = { execution_status?: string; finality_status?: string; revert_reason?: string; block_number?: number; events?: ReceiptEvent[] };
/** A provider that reports transactions (starknet.js's RpcProvider fits). */
export type ReceiptSource = {
  getTransactionStatus(hash: string): Promise<{ finality_status?: string; execution_status?: string; failure_reason?: string }>;
  getTransactionReceipt(hash: string): Promise<unknown>;
};
export type TxCheck =
  | { state: "succeeded"; receipt: Receipt }
  | { state: "reverted"; reason: string; receipt: Receipt }
  | { state: "pending"; finality: string }   // received, candidate or pre-confirmed: not accepted yet
  | { state: "unseen" };                     // the node doesn't know the hash (not seen yet, or dropped)

const ACCEPTED = new Set(["ACCEPTED_ON_L2", "ACCEPTED_ON_L1"]);
const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 120);

/** Starknet's "transaction hash not found" (error 29), as starknet.js reports it. */
export function hashNotFound(e: unknown): boolean {
  const err = e as { baseError?: { code?: number }; message?: string } | null;
  return err?.baseError?.code === 29 || /TXN_HASH_NOT_FOUND|Transaction hash not found/i.test(String(err?.message ?? ""));
}

/** One look at a transaction. Throws only when the node can't be read (which says nothing about the transaction). */
export async function checkTx(provider: ReceiptSource, hash: string): Promise<TxCheck> {
  let status;
  try { status = await provider.getTransactionStatus(hash); }
  catch (e) { if (hashNotFound(e)) return { state: "unseen" }; throw e; }
  const finality = status.finality_status ?? "";
  if (!ACCEPTED.has(finality)) return { state: "pending", finality };
  const receipt = await provider.getTransactionReceipt(hash) as Receipt;
  const execution = receipt.execution_status ?? status.execution_status;
  if (execution === "SUCCEEDED") return { state: "succeeded", receipt };
  if (execution === "REVERTED") return { state: "reverted", reason: receipt.revert_reason ?? status.failure_reason ?? "", receipt };
  return { state: "pending", finality };
}

/** A transaction that was sent but isn't accepted yet: not a failure. Carries its hash so the page can keep it. */
export class TxUnconfirmed extends Error {
  readonly hash: string;
  constructor(hash: string, detail: string) { super(`Sent, but not confirmed yet (${detail})`); this.hash = hash; }
}

/** Waits until `hash` is accepted, then says whether it executed. If it isn't accepted within `timeoutMs`, throws
 *  TxUnconfirmed: the caller keeps the hash and shows it as pending, never as failed. */
export async function confirmTx(provider: ReceiptSource, hash: string, { intervalMs = 2_000, timeoutMs = 180_000 } = {}):
  Promise<{ ok: true; receipt: Receipt } | { ok: false; reason: string; receipt: Receipt }> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let detail: string;
    try {
      const c = await checkTx(provider, hash);
      if (c.state === "succeeded") return { ok: true, receipt: c.receipt };
      if (c.state === "reverted") return { ok: false, reason: c.reason, receipt: c.receipt };
      detail = c.state === "pending" ? `${c.finality.toLowerCase().replace(/_/g, " ")}` : "not seen by the network yet";
    } catch (e) { detail = `couldn't reach Starknet: ${short(e)}`; }
    if (Date.now() >= until) throw new TxUnconfirmed(hash, detail);
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

/** The useful end of a Cairo revert reason (they nest every frame of the call). */
export const revertText = (reason: string) => {
  const felt = reason.match(/'([^']{2,})'/g)?.at(-1)?.slice(1, -1);
  return felt ?? reason.slice(-140);
};

/** Rejects with `message` if `p` hasn't settled within `ms`. (The work itself carries on; only the waiting stops.) */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}

/** The page stopped waiting for the wallet's answer (the wallet may still act on the request). */
export class StoppedWaiting extends Error {
  constructor() { super("You stopped waiting for your wallet"); }
}

/** Waits for a wallet request in a way the page can stop: `stop()` rejects with StoppedWaiting. It can't withdraw the
 *  request from the wallet: callers keep listening to `original` after a stop, so a late answer (a hash, or a refusal)
 *  is never lost, and treat the stop like a lost reply meanwhile (the transaction may still be sent). */
export function stoppable<T>(p: Promise<T>): { promise: Promise<T>; stop: () => void; original: Promise<T> } {
  let stop!: () => void;
  const stopped = new Promise<never>((_, reject) => { stop = () => reject(new StoppedWaiting()); });
  p.catch(() => {});   // a rejection after a stop is handled through `original`, not left unhandled
  return { promise: Promise.race([p, stopped]), stop, original: p };
}

export class Cancelled extends Error {
  constructor() { super("Cancelled"); }
}

/** The steps before a wallet request, which the viewer can call off at any point: `step(p)` waits for
 *  `p` unless `cancel()` (rejects with Cancelled) or `fail(e)` (rejects with e, e.g. a time limit) comes first. A step
 *  left behind finishes on its own; nothing waits for it. */
export function cancellable() {
  let reject!: (e: unknown) => void, reason: unknown = null;
  const off = new Promise<never>((_, r) => { reject = r; });
  off.catch(() => {});   // never rejects unless called, and a rejection nobody is waiting for isn't an error
  const end = (e: unknown) => { reason ??= e; reject(reason); };
  return {
    /** Once cancelled (or failed), every step is refused, even one whose answer is already in. */
    step: <T>(p: Promise<T>): Promise<T> => { p.catch(() => {}); return reason ? Promise.reject(reason) : Promise.race([p, off]); },
    cancel: () => end(new Cancelled()),
    fail: (e: unknown) => end(e),
  };
}
