// A launch whose wallet reply was lost (or whose page was closed): settled only on proof, as trades are (attempts.ts).
// Its own transaction accepted or reverted; or the launch found on chain by its content; or the chain past the
// deadline the launch carries (the factory refuses it after that). Anything else leaves it open.
import { DEADLINE_MARGIN_S } from "./attempts.ts";
import { checkTx, type Receipt, type ReceiptSource } from "./tx.ts";

export type PendingLaunch = {
  address: string; factory: string; metadataUri: string; nonceBefore: string; startedAt: number;
  fromBlock?: number; hash?: string; deadline?: number;
};
type LaunchSource = ReceiptSource & { getBlockWithTxHashes(block: "latest"): Promise<unknown> };
export type LaunchRecovery<T> =
  | { state: "confirmed"; hash: string; receipt: Receipt }
  | { state: "reverted"; hash: string; reason: string }
  | { state: "found"; done: T }
  | { state: "expired" }
  | { state: "open"; detail: string };

/** A missing saved hash still needs the same history/deadline check as a lost wallet reply. History must be read
 * completely through the head whose timestamp we use; any RPC or receipt error leaves the attempt unresolved.
 * `findLaunch` returns only accepted successful launches. Old records without a starting block cannot prove absence. */
export async function recoverLaunch<T>(provider: LaunchSource, pending: PendingLaunch,
  findLaunch: (pending: PendingLaunch, throughBlock: number) => Promise<T | null>): Promise<LaunchRecovery<T>> {
  if (pending.hash) {
    const status = await checkTx(provider, pending.hash);
    if (status.state === "succeeded") return { state: "confirmed", hash: pending.hash, receipt: status.receipt };
    if (status.state === "reverted") return { state: "reverted", hash: pending.hash, reason: status.reason };
    if (status.state === "pending") return { state: "open", detail: "Starknet has your launch transaction but hasn't accepted it yet." };
  }
  const head = await provider.getBlockWithTxHashes("latest") as { block_number: number; timestamp: number };
  if (![head.block_number, head.timestamp].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("The chain head couldn't be read safely.");
  const done = await findLaunch(pending, head.block_number);
  if (done !== null) return { state: "found", done };
  if (pending.deadline !== undefined && Number.isSafeInteger(pending.deadline) && pending.deadline >= 0
    && pending.fromBlock !== undefined && Number.isSafeInteger(pending.fromBlock) && pending.fromBlock >= 0
    && pending.fromBlock <= head.block_number && head.timestamp > pending.deadline + DEADLINE_MARGIN_S) return { state: "expired" };
  return { state: "open", detail: "No launch with this coin's details shows on chain yet. If your wallet still shows the launch request, approve or reject it there; this page keeps checking." };
}
