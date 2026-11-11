// The selectors of the entry points Hokori's transactions call (starknet_keccak of the name), as constants: the SDK has
// no dependencies, and these are the only ones it needs (checked against starknet.js in the site's tests).

export const SELECTOR = {
  approve: "0x219209e083275171774dab1df80982e9df2096516f06319c5c6d71ae0a8480c",
  transfer: "0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e",
  buy: "0x2d88e868af0a1983e3886d5f3e95a2fafbd6c3450bc229e27342283dc429ccc",
  sell: "0x3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775",
  buy_and_graduate: "0x3c8f444bfe5130964225d01d799bc14eda9b986980e869385bd65f4daa92a52",
  graduate: "0x216494392d833c374f504bbf4c8be11db5c1f8e7fbb42a7ff4845c9de915784",
  flush_fees: "0x77291c34f49fe54089bd79646425a52e8282dab4ce4410fe2a31ff248f92c7",
  launch: "0xd8fb40ed4f14ebdf4d43dc6ea3939d1806a45df5472bf1d3b648891798f9a8",
  check_deadline: "0x27279d93f6e0a2947c47b447626aed2cdf3e0a24e151ddddf760499197e59",
  collect_fees: "0x15bfcc0d8740529e70b4d8aa4a5a5ff6f1044a7f3aff662df42ef4c24acef7",
  claim: "0xb758361d5e84380ef1e632f89d8e76a8677dbc3f4b93a4f9d75d2a6048f312",
  swap: "0x15543c3708653cda9d418b4ccd3be11368e40636c10c44b18cfe756b6d88b29",
  clear_minimum: "0x2e1d93dafae32660a4a76a0fd6f31550f3ddfd6a51c29ef2e055b80afbbd011",
  clear: "0x292f3f4df7749c2ae1fdc3379303c2e6caa9bbc3033ee67709fde5b77f65836",
  // The fee vault's event naming each coin's recipients (contracts/src/fee_vault.cairo).
  PayeeRegistered: "0xaf4a03b8593fa68e658e1e2f1b343d566aa4ae1eaa233c0df89021add22088",
  // The privacy adapter's record of each protected trade, read so that such a trade is credited to no account.
  ProtectedTrade: "0xe56d203b04b5d1a205d9f8bc18e7053182e0986ee8f7311aab60a472a3e067",
  // Hokori's TradeAdapter's records of each trade it routes (one-click trading, limit orders), read to credit the account.
  Bought: "0x20cb8131637de1953a75938db3477cc6b648e5ed255f5b3fe3f0fb9299f0afc",
  Sold: "0x123e760cef925d0b4f685db5e1ac87aadaf1ad9f8069122a5bb03353444c386",
} as const;
export type EntryPoint = keyof typeof SELECTOR;

/** The selector of one of Hokori's entry points; any other name throws (this SDK doesn't hash names). */
export function selectorOf(name: string): string {
  const s = (SELECTOR as Record<string, string>)[name];
  if (!s) throw new Error(`no selector for ${name}: not one of Hokori's entry points`);
  return s;
}
