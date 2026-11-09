# Hokori

Open-source tools for [Hokori](https://hokori.io), a memecoin launchpad on Starknet: coins launch on a bonding curve,
graduate into an Ekubo pool whose liquidity is locked for good, and pay their trading fees to up to five recipients
fixed at launch.

| Folder | Package | What it is |
|---|---|---|
| [`sdk/`](sdk/README.md) | `@hokoridotio/sdk` | TypeScript, no dependencies. Exact curve and pool arithmetic, verified reads of the contracts, quotes and the unsigned calls for launches, trades and fee claims, event decoding, recovery after a lost wallet reply, and a client for Hokori's published market data and live stream. |
| [`mcp/`](mcp/README.md) | `@hokoridotio/mcp` | A Model Context Protocol server for AI agents: reads the market and a coin, quotes trades and prepares unsigned calls. |
| [`contracts/`](contracts) | | Cairo. The contracts every coin runs on: the launch factory, the coin token, the bonding curve, the fee vault (with paying all of a coin's recipients) and the locker that holds each graduated coin's Ekubo liquidity for good, with their tests. |

## Start here

Node 22.18 or later. The SDK's [quick start](sdk/README.md#quick-start-trade-from-a-bot) trades from a bot in a dozen
lines; [`sdk/examples/`](sdk/examples) has a trading bot and a market watcher.

## What these tools never do

- **Hold keys or sign.** The SDK and the MCP server return calls; your own account signs and sends them.
- **Trust published data for what you sign.** Transaction targets come from the launch factory and the contracts' own
  reads, never from coin metadata or the market-data files, which are for display and discovery.

## Risks

Memecoins are highly speculative and can lose all their value. This software is provided as is, without warranty of
any kind (see the licence). Nothing here is financial advice.

## Licence

MIT: see [LICENSE](LICENSE). The licence covers the code only: the Hokori name and logo are not licensed.

## Security

Please report vulnerabilities privately: see [SECURITY.md](SECURITY.md).
