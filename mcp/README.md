# Hokori MCP server

Hokori for AI agents: a Model Context Protocol server over stdio, built on @hokoridotio/sdk. It reads the market, one coin,
a wallet's holdings and the latest trades; it quotes trades; and it prepares a trade's unsigned calls. **It holds no
key and sends nothing.** A trade is signed by the person's own wallet, after they've seen the quote.

## Tools

| Tool | What it does |
|---|---|
| `list_coins` | Coins with market cap and 24-hour volume in each coin's currency (STRK, or ZEC for the ZEC launchpad's coins; in dollars too with `HOKORI_DATA_URL`), curve progress and graduation; sorted by trending, new or market cap (across currencies in dollars, else within each currency); filtered by name, symbol or address. |
| `get_coin` | One coin as it stands on Starknet now, read through its factory: price, market cap, its curve or Ekubo pool, fees, the launch window if open, its creator, and its metadata checked against the committed hash. |
| `quote_trade` | What a buy (the coin's currency in: STRK, or ZEC) or a sell (tokens in) gets now, its fee, the minimum after slippage, and its price impact. |
| `prepare_trade` | The unsigned calls for a trade, checked against the chain now (the SDK's prepareTrade), with the quote they carry and their deadline. Sign and send them together as one multicall. |
| `get_account` | A wallet's Hokori coins and recent trades (needs the market-data service). |
| `recent_trades` | The latest trades, across coins or for one coin. |
| `launch_settings` | The launch factory's rules: fees and Hokori's share, the launch window, graduation, launch fee, dev buy cap. |

Amounts are decimal strings in whole units: tokens (18 decimals), or the coin's currency, STRK (18) or ZEC on Starknet (8). Every row and quote
names its `currency`; fields named `*_strk` appear only for STRK coins. Network fees are always STRK.

## Running it

From npm, with Node 22.18 or later:

```
npx -y @hokoridotio/mcp
```

In Claude Code: `claude mcp add hokori -e HOKORI_NETWORK=mainnet -e HOKORI_DATA_URL=https://data.hokori.io -- npx -y @hokoridotio/mcp`.

Or from this repository's source:

```
cd mcp && npm install
HOKORI_NETWORK=sepolia node server.ts
```

By default it follows every Hokori launchpad on the network (STRK, ZEC and BTC).

Settings, from the environment:

| Setting | Meaning |
|---|---|
| `HOKORI_NETWORK` | `sepolia` (default) or `mainnet` |
| `HOKORI_RPC` | a Starknet RPC URL (default: a public endpoint for the network) |
| `HOKORI_DATA_URL` | the market-data service (e.g. `https://data.hokori.io`). Without it, the market is read from the chain, `get_account` isn't available, and coins in different currencies are listed without dollar figures. |
| `HOKORI_FACTORY` | `<address>@<block>`: a launch factory to follow instead of the launchpads, such as a test factory; or several, oldest first, separated by commas (the newest takes launches; a coin is read through the one that launched it) |
| `HOKORI_GATEWAY` | the Arweave gateway for coins' metadata (default `https://arweave.net/`) |

In Claude Code: `claude mcp add hokori -e HOKORI_NETWORK=sepolia -- node /path/to/mcp/server.ts`.

## Tests

- `npm test`: the protocol, with no chain.
- `npm run pack:check`: builds the SDK and the server into JavaScript, packs both as they would be published, installs
  them into an empty project in a temporary folder, and runs the installed `hokori-mcp` command there: it must answer
  an MCP client over stdio and exit when the client closes. Nothing is published.
