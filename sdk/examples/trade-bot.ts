// A minimal trading bot on @hokoridotio/sdk: quote a buy, show it, then (unless --dry-run) prepare the calls, check the STRK
// balance covers the trade and its network fee, sign with your own account and wait for the outcome.
//
//   node examples/trade-bot.ts --network sepolia --token 0x…dab --strk 5 --account 0x… --key-file ~/keys/bot.key [--dry-run]
//
// STRK coins only: a coin of the ZEC or BTC launchpad is refused before anything is quoted or signed (its amounts and
// balances are in another currency, with other decimals; see the SDK's README for trading those).
//
// The key file holds one hex private key and nothing else; keep it outside any repository, readable only by you.
// Nothing here is Hokori-specific magic: everything signed was read from the chain through the factory just before.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
// starknet.js is loaded where the bot connects or signs, so a refused coin or a dry run on a given chain needs none.
import type { RpcProvider } from "starknet";
import { createHokori, feeShortfall, formatUnits, parseUnits, quoteProblem, type HokoriNetwork, type NetworkName } from "@hokoridotio/sdk";

/** Runs the bot with command-line `argv`; returns the exit code. `deps` replaces the chain (tests). */
export async function main(argv: string[], deps: { provider?: RpcProvider; network?: HokoriNetwork; log?: (s: string) => void; error?: (s: string) => void } = {}): Promise<number> {
  const log = deps.log ?? console.log, error = deps.error ?? console.error;
  const { values: a } = parseArgs({ args: argv, options: {
    network: { type: "string", default: "sepolia" }, rpc: { type: "string" }, token: { type: "string" }, strk: { type: "string" },
    account: { type: "string" }, "key-file": { type: "string" }, slippage: { type: "string", default: "100" }, "dry-run": { type: "boolean", default: false },
  } });
  if (!a.token || !a.strk) { error("usage: --token <coin> --strk <amount> [--account <address> --key-file <path>] [--dry-run]"); return 2; }
  const name = a.network as NetworkName;
  const provider = deps.provider ?? new (await import("starknet")).RpcProvider({ nodeUrl: a.rpc ?? (name === "mainnet" ? "https://starknet-rpc.publicnode.com" : "https://starknet-sepolia-rpc.publicnode.com") });
  const hokori = createHokori({ network: deps.network ?? name, provider });

  const coin = await hokori.coin(a.token);
  // This example's amounts, balance and fee check are all STRK. A coin paid in ZEC or strkBTC (8 decimals) would be
  // quoted and bought in that currency instead: refused here, before anything is quoted or signed.
  if (BigInt(coin.currency.address) !== BigInt(hokori.network.strk)) {
    error(`This example trades only coins paid in STRK; ${coin.token} trades against ${coin.currency.symbol}. Nothing was quoted or signed.`);
    return 1;
  }
  let quote;
  try { quote = hokori.quote(coin, { side: "buy", amount: parseUnits(a.strk), slippageBps: Number(a.slippage) }); }
  catch (e) { error(quoteProblem(e)); return 1; }
  log(`${a.strk} STRK buys ${formatUnits(quote.receive)} tokens (at least ${formatUnits(quote.minReceive)}), fee ${formatUnits(quote.fee)} STRK, ${quote.venue}`);
  if (a["dry-run"]) return 0;

  if (!a.account || !a["key-file"]) { error("--account and --key-file are needed to trade"); return 2; }
  const key = readFileSync(a["key-file"], "utf8").trim();
  const { Account } = await import("starknet");
  const account = new Account({ provider, address: a.account, signer: key });

  const prepared = await hokori.prepareTrade(quote, coin.token);
  if ("problem" in prepared) { error(prepared.problem); return 1; }
  // Starknet charges the fee after the trade runs: a buy that spends the fee's STRK reverts and is still charged.
  const [balance, estimate] = await Promise.all([
    provider.callContract({ contractAddress: hokori.network.strk, entrypoint: "balance_of", calldata: [account.address] }).then(r => BigInt(r[0]) + (BigInt(r[1]) << 128n)),
    account.estimateInvokeFee(prepared.calls).then(f => BigInt(f.overall_fee)),
  ]);
  const short = feeShortfall(balance, prepared.order.amount, estimate);
  if (short) { error(`Not enough STRK for the trade and its network fee: at most ${formatUnits(short.maxSpend)} STRK could be spent.`); return 1; }

  const { transaction_hash } = await account.execute(prepared.calls);
  log(`sent ${transaction_hash}`);
  const outcome = await hokori.confirm(transaction_hash);
  log(outcome.ok ? "done" : `reverted: ${outcome.reason}`);
  return outcome.ok ? 0 : 1;
}

// Run from the command line (not when imported by a test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
