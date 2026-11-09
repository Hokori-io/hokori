// How the fee vault splits each deposit (contracts/src/fee_vault.cairo): the protocol's cut first (rounded down),
// then each payee its share of the rest (rounded down), the last payee taking the remainder. Each deposit (a
// curve or pool fee flush) is split on its own, so totals over several deposits are sums of per-deposit splits.
import { BPS, mulDiv, uint, type IntLike } from "./math.ts";

export const VAULT_MAX_PAYEES = 10;   // the contract's limit
export const SITE_MAX_PAYEES = 5;     // what the Hokori launch form offers

/**
 * Checks a payee list as the vault would at registration (1 to `max` payees, non-zero addresses, every share > 0,
 * shares summing to exactly 10,000 bps). Returns a list of problems (empty if valid).
 */
export function payeeProblems(payees: { address: IntLike; shareBps: IntLike }[], { max = SITE_MAX_PAYEES }: { max?: number } = {}): string[] {
  const problems: string[] = [];
  if (!Array.isArray(payees) || payees.length === 0) return ["at least one payee"];
  if (payees.length > max) problems.push(`at most ${max} payees`);
  let total = 0n;
  const seen = new Set<bigint>();
  payees.forEach((p, i) => {
    let address: bigint | null = null;
    try { address = uint(p.address, "address"); } catch { problems.push(`payee ${i + 1}: not a Starknet address`); }
    if (address === 0n) problems.push(`payee ${i + 1}: zero address`);
    if (address !== null && address >= 2n ** 251n) problems.push(`payee ${i + 1}: outside the Starknet address range`);
    if (address !== null && seen.has(address)) problems.push(`payee ${i + 1}: listed twice`);
    if (address !== null) seen.add(address);
    let share = 0n;
    try { share = uint(p.shareBps, "share"); } catch { problems.push(`payee ${i + 1}: share is not a whole number of bps`); }
    if (share === 0n) problems.push(`payee ${i + 1}: share must be above zero`);
    total += share;
  });
  if (total !== BPS) problems.push(`shares add up to ${total} bps, not 10,000`);
  return problems;
}

/** One deposit's split: { protocol, payees: [amount per payee, in order] }. */
export function splitDeposit(amountIn: IntLike, protocolBps: IntLike, sharesBps: IntLike[]): { protocol: bigint; payees: bigint[] } {
  const amount = uint(amountIn, "amount");
  const protocol = mulDiv(amount, uint(protocolBps), BPS);
  const rest = amount - protocol;
  let credited = 0n;
  const payees = sharesBps.map((s, i) => {
    const part = i + 1 === sharesBps.length ? rest - credited : mulDiv(rest, uint(s), BPS);
    credited += part;
    return part;
  });
  return { protocol, payees };
}

/** Splits several deposits one at a time and sums them, as the vault credits them. */
export function splitDeposits(amounts: IntLike[], protocolBps: IntLike, sharesBps: IntLike[]): { protocol: bigint; payees: bigint[] } {
  const total = { protocol: 0n, payees: sharesBps.map(() => 0n) };
  for (const a of amounts) {
    const s = splitDeposit(a, protocolBps, sharesBps);
    total.protocol += s.protocol;
    s.payees.forEach((v, i) => { total.payees[i] += v; });
  }
  return total;
}
