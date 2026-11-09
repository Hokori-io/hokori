// Where Hokori runs: each network's chain ID, STRK, Ekubo's Core and Router (with the Core version, which decides a
// pool quote's rounding), and Hokori's launchpads (STRK; ZEC and BTC since November 2026) with their factories and
// deployment blocks. Transaction targets start here and at the factories' own reads, never at published data.
import type { EkuboCore } from "./ekubo.ts";

export type NetworkName = "mainnet" | "sepolia";
export type HokoriNetwork = {
  name: NetworkName; label: string;
  /** The chain ID as a hex felt: "SN_MAIN" or "SN_SEPOLIA". */
  chainId: string;
  /** STRK, the currency of the STRK launchpad, and of every network fee. */
  strk: string;
  /** Ekubo, where graduated coins trade: Core (every pool's state and Swapped events) and the Router. */
  ekubo: { core: string; coreVersion: EkuboCore; router: string };
  /** The STRK launchpad's factories, oldest first, each with the block it was deployed in (reading its history starts
   *  there). The newest is where new STRK launches go; earlier ones keep serving the coins they launched, with their own
   *  settings (a later factory never drops earlier coins). Empty until the first is deployed. */
  factories: FactoryRef[];
  /** Every launchpad on this network, the STRK one (whose factories are `factories`) first: the currency its coins trade
   *  against, and its factories (a ZEC launchpad beside the STRK one). A network's market-data service
   *  follows all of their factories, so a reader follows the same set (`networkFactories`). Absent: the STRK launchpad
   *  alone. */
  launchpads?: Launchpad[];
  /** Starknet's STRK20 privacy pool, and Hokori's privacy adapters with the factory each is pinned to, as deployed (the
   *  adapter class 0x06c00f44…47a8). A trade is protected only when its coin's factory's adapter records it
   *  (protected.ts). Absent: no protected trading on this network. */
  privacy?: { pool: string; adapters: PrivacyAdapterRef[]; reviewed: PrivacyReviewed };
};
/** What was reviewed of the privacy deployment, checked fresh before every protected signature: any other value halts
 *  protected trading ("Privacy deployment changed") until it is reviewed again. The pool's class and version, its
 *  auditor and screener keys, its fee and proof validity (as the adapters' deployments froze them), the Ekubo Router's
 *  class and the adapter class. */
export type PrivacyReviewed = { poolClass: string; poolVersion: string; auditor: string; screener: string; feeAmount: string; proofValidityBlocks: string; routerClass: string; adapterClass: string };
/** A launch factory and its deployment block. */
export type FactoryRef = { address: string; block: number };
/** One of Hokori's launchpads: its name, by the currency its coins trade against ("STRK", "ZEC", or "BTC" for strkBTC;
 *  each factory's own `currency` read is what counts on chain), and its factories, oldest first; the newest takes the
 *  launchpad's new launches. */
export type Launchpad = { currency: string; factories: FactoryRef[] };
/** A privacy adapter, the factory it is pinned to (it trades only that factory's coins), and its deployment block. */
export type PrivacyAdapterRef = { address: string; factory: string; block: number };
/** A network's launchpads: its `launchpads` when their STRK launchpad is its `factories`; otherwise the STRK launchpad
 *  alone, as `factories`. So a copy of a network with other `factories` (`{ ...NETWORKS.sepolia, factories: [test] }`)
 *  follows exactly those, as it did before launchpads existed. */
export function launchpadsOf(n: Pick<HokoriNetwork, "factories" | "launchpads">): Launchpad[] {
  const strk = n.launchpads?.find(l => l.currency === "STRK");
  const same = !!strk && strk.factories.length === n.factories.length && strk.factories.every((f, i) => BigInt(f.address) === BigInt(n.factories[i].address));
  return same ? n.launchpads! : [{ currency: "STRK", factories: n.factories }];
}
/** Every factory of a network's launchpads, oldest first, each once: the set its market-data service follows. */
export function networkFactories(n: Pick<HokoriNetwork, "factories" | "launchpads">): FactoryRef[] {
  const out: FactoryRef[] = [];
  for (const f of launchpadsOf(n).flatMap(l => l.factories)) if (!out.some(o => BigInt(o.address) === BigInt(f.address))) out.push(f);
  return out.sort((a, b) => a.block - b.block);
}
/** The factory new launches go to: the newest of a launchpad's (`currency`, STRK by default), or null when it has none.
 *  Given only `factories` (a site's own list), the newest of those. */
export const launchFactory = (n: Pick<HokoriNetwork, "factories"> & { launchpads?: Launchpad[] }, currency = "STRK"): FactoryRef | null => {
  const factories = launchpadsOf(n).find(l => l.currency === currency)?.factories ?? [];
  return factories.length ? factories[factories.length - 1] : null;
};
/** The block reading a network's history starts at: the oldest factory's. */
export const historyStart = (factories: FactoryRef[]): number => (factories.length ? Math.min(...factories.map(f => f.block)) : 0);

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
// The launch factory (28 Oct 2026): the 100,000 STRK curve, its fees to Hokori's splitter for good.
const MAINNET_STRK: FactoryRef[] = [{ address: "0x3887d1565b079265b5886a33243920515a966e50c8f38f0812552b4b44ad8c7", block: 17045147 }];
// Test factories on a 10 STRK test curve, oldest first: v3 (15 Oct: the old 0.7% settings, no launches) and v4 (16 Oct:
// the launch settings, where new test launches go).
const SEPOLIA_STRK: FactoryRef[] = [
  { address: "0x049e9ac2d651039bf0aebed299114fc2defa9355c9acfc200431496f71b6a9a1", block: 16633595 },
  { address: "0x058471273c1b4ff0a5cb875912e0692072511d3a6868d99992b34d3b5ea8dc15", block: 16658842 },
];

export const NETWORKS: Record<NetworkName, HokoriNetwork> = {
  mainnet: {
    name: "mainnet", label: "Starknet", chainId: "0x534e5f4d41494e", strk: STRK,
    ekubo: { core: "0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b", coreVersion: "v5", router: "0x0199741822c2dc722f6f605204f35e56dbc23bceed54818168c4c49e4fb8737e" },
    factories: MAINNET_STRK,
    launchpads: [
      { currency: "STRK", factories: MAINNET_STRK },
      // The ZEC launchpad (3 Nov 2026): NEAR's bridged ZEC on Starknet, 8 decimals; graduation at 4 ZEC raised.
      { currency: "ZEC", factories: [{ address: "0x0447640e0c2e0f20d4c4215c85e3be73bfc4e1c2abd574e0ac081fbaa7bf74ad", block: 17393022 }] },
      // The BTC launchpad (9 Nov 2026): strkBTC, 8 decimals; graduation at 0.12 BTC raised.
      { currency: "BTC", factories: [{ address: "0x04511f2c14c3e074f2003cb90d6390e1fd30e8b5f42ddbacf49b02edb4415c69", block: 17670134 }] },
    ],
    // One adapter per launchpad factory (3 Nov 2026); none yet for the BTC launchpad (protected trades later).
    privacy: {
      pool: "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a",
      // As the mainnet deployment froze them (3 Nov 2026): fee 2.5 STRK.
      reviewed: {
        poolClass: "0x06d163f2b27df0f53c5b0d019366261ba8034af1bef949dee920a60fe58bcf83", poolVersion: "0x322e31",
        auditor: "0x01eed60b8d483b3bede62d1cc0f32874aea30747e6943437c858359b41801bf7", screener: "0x0501cc452e5a4370e2f0879c9a863b3efc915005817487460b23a8d6ef88fdb2",
        feeAmount: "0x22b1c8c1227a0000", proofValidityBlocks: "0x1c2",
        routerClass: "0x0137a5970f752fd80649fb38d684b090decebec4f2853396617e4f2f01e5396a", adapterClass: "0x06c00f441d4fcb2aed2db12a2e18d337ca99b3b8928031b828e35141a29d47a8",
      },
      adapters: [
        { address: "0x06fa392236b7e0439f89b1cbd1f2e959cf767e6b86bdeb72e2ca503d18513015", factory: "0x03887d1565b079265b5886a33243920515a966e50c8f38f0812552b4b44ad8c7", block: 17361655 },
        // The ZEC launchpad's.
        { address: "0x043596a87ecd0c96299064d2c30d56c76db1bb0d32537dba9c80f8c0cade1b75", factory: "0x0447640e0c2e0f20d4c4215c85e3be73bfc4e1c2abd574e0ac081fbaa7bf74ad", block: 17393307 },
      ],
    },
  },
  sepolia: {
    name: "sepolia", label: "Starknet Sepolia (testnet)", chainId: "0x534e5f5345504f4c4941", strk: STRK,
    ekubo: { core: "0x0444a09d96389aa7148f1aada508e30b71299ffe650d9c97fdaae38cb9a23384", coreVersion: "v4", router: "0x0045f933adf0607292468ad1c1dedaa74d5ad166392590e72676a34d01d7b763" },
    factories: SEPOLIA_STRK,
    launchpads: [
      { currency: "STRK", factories: SEPOLIA_STRK },
      // The Sepolia ZEC launchpad (2 Nov 2026), on an 8-decimal test ZEC (NEAR's ZEC isn't on Sepolia).
      { currency: "ZEC", factories: [{ address: "0x070efa3220653c1e1d545862a32f893f937a1135668af783bab5fbd55cfe9d36", block: 17540869 }] },
    ],
    // The test adapters (2 Nov 2026): the v4 factory's, and the Sepolia ZEC launchpad's.
    privacy: {
      pool: "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91",
      // As reviewed on 2 Nov 2026: fee 2.0 STRK.
      reviewed: {
        poolClass: "0x06d163f2b27df0f53c5b0d019366261ba8034af1bef949dee920a60fe58bcf83", poolVersion: "0x322e31",
        auditor: "0x01d17f98be07e99713265714699a5c40ccbf7b50c950fb7a2abd81846fcdfbb2", screener: "0x062f1e7ca586cbc15b558550be96244874c8dd3e4a50369a6858b29c1e51b552",
        feeAmount: "0x1bc16d674ec80000", proofValidityBlocks: "0x1c2",
        routerClass: "0x0137a5970f752fd80649fb38d684b090decebec4f2853396617e4f2f01e5396a", adapterClass: "0x06c00f441d4fcb2aed2db12a2e18d337ca99b3b8928031b828e35141a29d47a8",
      },
      adapters: [
        { address: "0x050e65ace3f09de8975745ec0bf9846fae7cba92b8f905f4b1b8fb9491e19aae", factory: "0x058471273c1b4ff0a5cb875912e0692072511d3a6868d99992b34d3b5ea8dc15", block: 17538428 },
        { address: "0x0734505c329a236f10a9bed168b7fe5e07a3d2e27290b72a195cbeee1177776e", factory: "0x070efa3220653c1e1d545862a32f893f937a1135668af783bab5fbd55cfe9d36", block: 17540879 },
      ],
    },
  },
};

/** The network with this chain ID, or null. */
export function networkOf(chainId: string): HokoriNetwork | null {
  try { return Object.values(NETWORKS).find(n => BigInt(n.chainId) === BigInt(chainId)) ?? null; } catch { return null; }
}
