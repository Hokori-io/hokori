// A minimal trading bot on @hokoridotio/sdk: quote a buy, show it, then (unless --dry-run) prepare the calls, check the STRK
// balance covers the trade and its network fee, sign with your own account and wait for the outcome.
//
//   node examples/trade-bot.ts --network sepolia --token 0x…dab --strk 5 --account 0x… --key-file ~/keys/bot.key [--dry-run]
//
// The key file holds one hex private key and nothing else; keep it outside any repository, readable only by you.
// Nothing here is Hokori-specific magic: everything signed was read from the chain through the factory just before.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Account, RpcProvider } from "starknet";
import { createHokori, feeShortfall, formatUnits, parseUnits, quoteProblem, type NetworkName } from "@hokoridotio/sdk";

const { values: a } = parseArgs({ options: {
  network: { type: "string", default: "sepolia" }, rpc: { type: "string" }, token: { type: "string" }, strk: { type: "string" },
  account: { type: "string" }, "key-file": { type: "string" }, slippage: { type: "string", default: "100" }, "dry-run": { type: "boolean", default: false },
} });
if (!a.token || !a.strk) { console.error("usage: --token <coin> --strk <amount> [--account <address> --key-file <path>] [--dry-run]"); process.exit(2); }
const network = a.network as NetworkName;
const provider = new RpcProvider({ nodeUrl: a.rpc ?? (network === "mainnet" ? "https://starknet-rpc.publicnode.com" : "https://starknet-sepolia-rpc.publicnode.com") });
const hokori = createHokori({ network, provider });

const coin = await hokori.coin(a.token);
let quote;
try { quote = hokori.quote(coin, { side: "buy", amount: parseUnits(a.strk), slippageBps: Number(a.slippage) }); }
catch (e) { console.error(quoteProblem(e)); process.exit(1); }
console.log(`${a.strk} STRK buys ${formatUnits(quote.receive)} tokens (at least ${formatUnits(quote.minReceive)}), fee ${formatUnits(quote.fee)} STRK, ${quote.venue}`);
if (a["dry-run"]) process.exit(0);

if (!a.account || !a["key-file"]) { console.error("--account and --key-file are needed to trade"); process.exit(2); }
const key = readFileSync(a["key-file"], "utf8").trim();
const account = new Account({ provider, address: a.account, signer: key });

const prepared = await hokori.prepareTrade(quote, coin.token);
if ("problem" in prepared) { console.error(prepared.problem); process.exit(1); }
// Starknet charges the fee after the trade runs: a buy that spends the fee's STRK reverts and is still charged.
const [balance, estimate] = await Promise.all([
  provider.callContract({ contractAddress: hokori.network.strk, entrypoint: "balance_of", calldata: [account.address] }).then(r => BigInt(r[0]) + (BigInt(r[1]) << 128n)),
  account.estimateInvokeFee(prepared.calls).then(f => BigInt(f.overall_fee)),
]);
const short = feeShortfall(balance, prepared.order.amount, estimate);
if (short) { console.error(`Not enough STRK for the trade and its network fee: at most ${formatUnits(short.maxSpend)} STRK could be spent.`); process.exit(1); }

const { transaction_hash } = await account.execute(prepared.calls);
console.log(`sent ${transaction_hash}`);
const outcome = await hokori.confirm(transaction_hash);
console.log(outcome.ok ? "done" : `reverted: ${outcome.reason}`);
