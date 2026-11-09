// A launch as Starknet calls: an exact STRK approval for the launch fee plus the dev buy (only if there is something to
// pay), then factory.launch, in one multicall so the approval and the launch happen together. The dev buy is first in
// line on a brand-new curve, so its exact quote is also its minimum. Pure: a page or a bot passes these to the wallet.
import { byteArrayFelts } from "./address.ts";
import type { HokoriCall } from "./calls.ts";

export type LaunchArgs = {
  factory: string; currency: string;
  name: string; symbol: string; metadataUri: string; metadataSha256: bigint;
  /** The coin's fee payees, with their shares in basis points (adding up to 10,000; the vault checks). */
  payees: { address: string; bps: number }[];
  devBuy: bigint; minDevTokens: bigint;
  /** The factory's launch fee (paid to the protocol in the same transaction). */
  launchFee: bigint;
  /** Found by the address search (coinAddressTools): puts the coin on the factory's required ending. */
  salt: bigint;
  /** Block timestamp after which the factory refuses this launch, so an unanswered launch request can be known to
   *  have failed once the chain passes it. */
  deadline: number;
};

const U128 = (1n << 128n) - 1n;
const u256 = (v: bigint) => [v & U128, v >> 128n];
const hex = (v: bigint | string) => "0x" + BigInt(v).toString(16);

export function launchCalls(a: LaunchArgs): HokoriCall[] {
  if (!a.payees.length) throw new Error("at least one payee");
  if (a.devBuy < 0n || a.minDevTokens < 0n || a.launchFee < 0n) throw new Error("negative amount");
  const calls: HokoriCall[] = [];
  const pay = a.devBuy + a.launchFee;
  if (pay > 0n) calls.push({ contractAddress: a.currency, entrypoint: "approve", calldata: [hex(a.factory), ...u256(pay).map(hex)] });
  // Encoded by hand in the factory's argument order: names may contain any UTF-8 (starknet.js refuses non-ASCII text
  // in a ByteArray), and byteArrayFelts is also what the address search hashes, so both see the same bytes.
  const felts = [
    ...byteArrayFelts(a.name), ...byteArrayFelts(a.symbol), ...byteArrayFelts(a.metadataUri), ...u256(a.metadataSha256),
    BigInt(a.payees.length), ...a.payees.map(p => BigInt(p.address)), BigInt(a.payees.length), ...a.payees.map(p => BigInt(p.bps)),
    ...u256(a.devBuy), ...u256(a.minDevTokens), a.salt, BigInt(a.deadline),
  ];
  calls.push({ contractAddress: a.factory, entrypoint: "launch", calldata: felts.map(hex) });
  return calls;
}
