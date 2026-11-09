/**
 * A coin's market figures for the landing page, from its trades (each trade's price is the spot price after it, read
 * from the event's own reserves): market cap now, all-time high and low (the launch price counts), 24-hour volume and
 * hourly volume bars, curve progress. Pure; display only (floating point is fine here, never for amounts).
 */
export type MarketTrade = { time: number; block: number; tx: string; venue: "curve" | "pool"; side: "buy" | "sell"; trader: string; tokens: bigint; currency: bigint; priceAfter: number;
  /** sdk/src/protected.ts: absent is an account's trade. */
  attribution?: "account" | "protected" | "unknown" };
export type CoinStats = {
  mcap: number; ath: number; atl: number; volume24h: number; volumeBars: number[]; lastTrade: number | null; trades: number;
  /** When the all-time high and low were set (unix seconds; null for the launch price before any trade, or when unknown). */
  athAt?: number | null; atlAt?: number | null;
  change24h: number | null;   // market cap change over 24 h, as a fraction (0.12 = +12%)
  /** Some trades are missing (a page reading the chain keeps only recent pool trades): ATH/ATL, 24 h volume and the
   *  trade count are lower bounds, and aren't shown as figures. */
  partial?: boolean;
};

/** `priceNow`: the current price when known apart from the trades (a pool's price, for a coin whose recent pool trades
 *  are missing). `partial`: the trades are incomplete (review b37a86c R5): the market cap uses the latest known price,
 *  and the figures that need every trade (24 h change and volume, all-time high and low, the count) are flagged. */
export function coinStats(o: { startPrice: number; supply: number; trades: MarketTrade[]; now: number; hours?: number; priceNow?: number; partial?: boolean;
  /** The currency's decimals, for the volumes (18, STRK's, unless the coin's factory says otherwise). */
  currencyDecimals?: number }): CoinStats {
  const hours = o.hours ?? 24, unit = 10 ** (o.currencyDecimals ?? 18);
  let price = o.startPrice, ath = o.startPrice, atl = o.startPrice, volume24h = 0, athAt: number | null = null, atlAt: number | null = null;
  const bars = new Array(hours).fill(0) as number[];
  let price24hAgo: number | null = o.trades.length === 0 || o.trades[0].time >= o.now - 86_400 ? o.startPrice : null;
  for (const t of o.trades) {
    if (t.time <= o.now - 86_400) price24hAgo = t.priceAfter;
    price = t.priceAfter;
    if (price > ath) { ath = price; athAt = t.time; }
    if (price < atl) { atl = price; atlAt = t.time; }
    const age = o.now - t.time;
    if (age < 86_400) volume24h += Number(t.currency) / unit;
    const bucket = hours - 1 - Math.floor(age / (86_400 / hours));
    if (bucket >= 0 && bucket < hours) bars[bucket] += Number(t.currency) / unit;
  }
  if (o.priceNow !== undefined && o.priceNow > 0) { price = o.priceNow; if (price > ath) { ath = price; athAt = o.now; } if (price < atl) { atl = price; atlAt = o.now; } }
  return {
    mcap: price * o.supply, ath: ath * o.supply, atl: atl * o.supply, athAt, atlAt, volume24h, volumeBars: bars,
    lastTrade: o.trades.length ? o.trades[o.trades.length - 1].time : null, trades: o.trades.length,
    change24h: o.partial ? null : price24hAgo ? price / price24hAgo - 1 : null,
    ...(o.partial ? { partial: true } : {}),
  };
}

/** Where the current value sits between the all-time low and high, 0..1 (1 when they're equal). */
export const athPosition = (s: Pick<CoinStats, "mcap" | "ath" | "atl">) => (s.ath > s.atl ? Math.min(1, Math.max(0, (s.mcap - s.atl) / (s.ath - s.atl))) : 1);
