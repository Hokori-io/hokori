# @hokoridotio/sdk

Hokori, the Starknet launchpad, for bots, agents and apps: the same code the hokori.io site and its market-data
service run. Exact arithmetic for the bonding curve and the Ekubo pools coins graduate into; verified reads of the
contracts; quotes, accepted orders and the calls to sign; launches and fee claims; event decoding and trade logs;
recovery after a lost wallet reply; and a client for the published market data.

## Principles

- **No dependencies.** The SDK talks to Starknet through a provider you pass in: starknet.js's `RpcProvider` fits as
  is. It holds no keys and never signs or sends: it returns calls, and your account executes them as one multicall.
- **The chain decides what's signed.** Transaction targets come from Hokori's launch factory (the network list,
  `NETWORKS`) and the factory's own reads (`readCoin`, `readFactory`), never from coin metadata or published data. The
  market-data service's files are for display and discovery.
- **Exact amounts.** Every amount is a `bigint` in base units (coins have 18 decimals; of the currencies, STRK has 18
  and ZEC 8). Floating point is used only for display figures (prices, market caps, candles).
- **JavaScript with type declarations.** The package is built from TypeScript (`npm run build`); Node 22.18 or later.

## Quick start: trade from a bot

```ts
import { RpcProvider, Account } from "starknet";
import { createHokori, parseUnits } from "@hokoridotio/sdk";

const provider = new RpcProvider({ nodeUrl: "https://starknet-sepolia-rpc.publicnode.com" });
const hokori = createHokori({ network: "sepolia", provider });

const coin = await hokori.coin("0x…dab");                       // as it stands on the chain now
const quote = hokori.quote(coin, { side: "buy", amount: parseUnits("5"), slippageBps: 100 });
console.log(`5 STRK buys ${quote.receive} base units, at least ${quote.minReceive}`);

const prepared = await hokori.prepareTrade(quote, coin.token);  // re-read and checked against the chain
if ("problem" in prepared) throw new Error(prepared.problem);   // quote again, accept the new quote
const account = new Account({ provider, address, signer });     // your own account and key
const { transaction_hash } = await account.execute(prepared.calls);
const outcome = await hokori.confirm(transaction_hash);         // accepted, then executed or reverted
```

`prepareTrade` does what the site's trade panel does before asking a wallet:
- it reads the coin again, and refuses a quote made for another coin;
- it refuses a curve buy inside the launch window (buys pay 99% in the launch block and the next). `quote` prices such
  a buy at the window's fee; once the window ends, that quote is refused too, since its minimum would barely protect
  the buy;
- it keeps the accepted venue and minimum, and never offers more than the quote spends (a last buy offers only what
  it takes);
- a buy that takes the curve's last tokens calls `buy_and_graduate`, graduating the coin in the same call.

If anything would need a different order, it returns a `problem` instead of calls.

The client checks once, before its first read, that the provider is on the client's network (`getChainId`). Deadlines
are unix seconds: a value in milliseconds is refused.

Before sending, check that your STRK balance covers the trade plus its network fee: Starknet charges the fee after the
trade runs, so a buy that spends the fee's STRK reverts and is still charged (`feeShortfall`, `feeHeadroom`).

## What's in it

| Area | Exports |
|---|---|
| Networks | `NETWORKS` (chain ID, STRK, Ekubo Core and Router with the Core version, and the launchpads: STRK, and ZEC since November 2026, each with its factories and their blocks, oldest first: the newest takes the launchpad's launches, earlier ones keep their coins), `networkOf`, `launchFactory` (a launchpad's, STRK by default), `networkFactories` (every launchpad's: what the market-data service follows), `launchpadsOf`, `historyStart` |
| Client | `createHokori` (follows every launchpad; launches go to the STRK launchpad unless you pass `factories`), `prepareTrade`, `marketOf` |
| Chain reads | `readFactory`, `readCoin` (through one factory, or `factories`: whichever launched the coin), `resolveFactory`, `readCurveOf`, `refreshCoin`, `readLaunch`, `readMetadataUri`, `readPoolKey`, `readPool`, `readPayees`, `readVaultBalance`, `readWaitingPoolFees`, `isUnknownToken`; decoders `decodeCurveParams`, `decodeCurveState` |
| Curve arithmetic | `quoteBuy`, `quoteSell`, `costForTokens`, `costToClose`, `buyFeeBps` (the launch window), `applyBuy`, `applySell`, `graduationSeed`, `factoryFigures`, `devBuy` |
| Ekubo pools | `ekuboPool`, `ekuboQuoteBuy`, `ekuboQuoteSell`, `ekuboPrice`, `ekuboReserves`, `ekuboFeeFor` (Core v4 and v5 rounding) |
| Orders | `tradeQuote`, `placeOrder`, `orderCalls`, `quoteProblem`, `costOfTokens`, `tokensForProceeds`, `nativeAmount`, `feeShortfall`, `buyShare`, `callFingerprint` |
| Calls | `curveTradeCalls`, `buildCurveTradeCalls`, `buildEkuboTradeCalls`, `ekuboPoolKey`, `launchCalls`, `claimFeeCalls` |
| Launching | `coinMetadata` (the committed document and its SHA-256), `coinAddressTools` (the search for the "dab" address ending; pass @scure/starknet's hashes), `payeeProblems`, `splitDeposits` |
| Events | `EVENT` selectors, `allEvents` (complete pages or an error), `parseLaunch`, `tradeFrom`, `createTradeLog`, `readCoinRange`, `isHokoriSwap`, `transferFrom` |
| Coin state and holders | `applyEvent`, `LAUNCHED`, `summarizeHolders`, `protocolHolders` |
| Market figures | `coinStats`, `minuteCandles`, `aggregateCandles` |
| Market data | `createDataFeed` (the whole market), `createPublishedTrades` (one coin), `createPublishedAccount` (one wallet), `createMarketFeed` (the market read from the chain), `streamBlocks` (live, resumable). A service that follows more launchpads than you do is still read, its other coins left out, so a new launchpad never cuts you off; pass `match: "exact"` to accept only a service following exactly your factories |
| Recovery | `checkTx`, `confirmTx`, trade attempts (`saveAttempt`, `settleAttempt`, `isAttemptTx`, `isRefusal`), `recoverLaunch` |
| Metadata | `fetchMetadata` (capped, time-limited, checked against the committed hash) |

## Following the market live

```ts
import { streamBlocks } from "@hokoridotio/sdk";

const stream = streamBlocks({
  url: "https://data.hokori.io",           // the market-data service
  from: savedResumePoint,                   // leave out to start at the newest block
  onBlock: b => { for (const t of b.trades) console.log(t.token, t.side, t.currency); },
  onRollback: block => dropEverythingAfter(block),
});
// Later: save stream.last ("<block>:<hash>") to resume from; stream.close() to stop.
```

It reconnects by itself and resumes after the last block received, without repeats. If that block was replaced
while it was away, it first calls `onRollback`.

### Using data.hokori.io fairly

The market data is free to read. To keep it that way for everyone:
- **Follow the stream rather than polling.** It sends every launch, trade and graduation as its block is indexed.
- **Poll a file at most once a second.** Each file is cached for one second, so polling faster returns the same file.
  `market-live.json` is the small one for frequent reads; `market.json` holds everything.
- **Don't add query strings or invent paths:** they skip the cache. The SDK's readers (`createDataFeed`,
  `createPublishedTrades`, `createPublishedAccount`, `streamBlocks`) build the right ones.
- **At most 10 stream connections from one address,** and the service takes about 1,000 in all. When it refuses one,
  it answers 429 (too many from this address) or 503 (full) with a `Retry-After`, which `streamBlocks` waits out
  before trying again.

Signing never depends on this data: quotes and the calls you sign read the chain through your own provider.

## For AI agents

The MCP server in `../mcp` offers these as tools (read the market and a coin, quote, prepare unsigned calls), and
never signs.

## After a lost reply: never trade twice

A wallet that doesn't answer may still have sent the transaction. Save the attempt before asking the wallet
(`saveAttempt`: the account's nonce, the deadline, the calls' fingerprint), and settle it only on proof
(`settleAttempt`):
- its own transaction accepted;
- the wallet's refusal;
- or the chain past the deadline the trade carries.

A timeout or an unchanged nonce is never proof. Until it settles, send nothing new for that coin.

The store:
- **The default is the browser's localStorage.** Elsewhere (Node), pass a durable store with `getItem`, `setItem` and
  `removeItem`.
- **`saveAttempt` writes the record and reads it back.** It throws `AttemptNotKept` when it can't (no storage, or storage
  that refuses or loses it). Don't ask the wallet then: nothing would stop the same trade being sent twice after a
  reload or restart.
- **`loadAttempt` never reads a store failure as "nothing pending".** It returns a guard with a `recoveryProblem` to
  show.
- **`memoryAttemptStore()`** keeps records only while the process runs. Pass it explicitly if that is acceptable; it
  can't protect across a restart.

## Tests

`npm test` in `sdk/` covers:
- the arithmetic, against the curve's reference vectors (`test/vectors.json`) and amounts the contracts produced on a
  devnet (`test/devnet-recorded.json`);
- call encoding;
- the reads, against a scripted chain;
- the client's trade path.

## Examples

- `examples/trade-bot.ts`: quote a buy, show it, prepare and check it, confirm the STRK covers the trade and its
  network fee, sign with your own account (its key from a file), and wait for the outcome. `--dry-run` only quotes.
- `examples/watch-trades.ts`: follow the stream and report launches, graduations and large trades, to the console
  and to a Telegram chat when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set; it resumes where it stopped.

## Packaging

`npm run build` compiles `src/` into `dist/` (JavaScript and type declarations). `npm run pack:check` builds it,
packs a tarball whose exports point at the build, checks the tarball holds nothing else, installs it into an empty
project in a temporary folder, and uses it there from plain Node and from a strict TypeScript project.
