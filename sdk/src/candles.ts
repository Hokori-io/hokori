/**
 * Candles for the coin chart, from price points (the spot price after each trade, read from the trade events' own
 * reserves: q/t on the curve, y/x in the pool). Each candle opens where the previous one closed, so the chart is
 * continuous like the curve itself. Pure; display only (floating point is fine here, never for amounts).
 */
export type PricePoint = { time: number; price: number; volume: number };   // time: unix seconds; volume: STRK
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

export const INTERVALS = [
  { label: "1m", seconds: 60 }, { label: "5m", seconds: 300 }, { label: "15m", seconds: 900 },
  { label: "1h", seconds: 3600 }, { label: "4h", seconds: 14_400 }, { label: "1d", seconds: 86_400 },
] as const;

/** `points` in time order; `start` is the price before the first point (e.g. the curve's launch price). */
export function buildCandles(points: PricePoint[], intervalSeconds: number, start?: number): Candle[] {
  const out: Candle[] = [];
  let prev = start ?? points[0]?.price;
  for (const p of points) {
    const time = Math.floor(p.time / intervalSeconds) * intervalSeconds;
    let c = out[out.length - 1];
    if (!c || c.time !== time) {
      if (c && time < c.time) throw new Error("price points out of order");
      c = { time, open: prev!, high: prev!, low: prev!, close: prev!, volume: 0 };
      out.push(c);
    }
    c.high = Math.max(c.high, p.price);
    c.low = Math.min(c.low, p.price);
    c.close = p.price;
    c.volume += p.volume;
    prev = p.price;
  }
  return out;
}

/** The chart's smallest interval. Every interval is a whole number of minutes, so minute candles build them all. */
export const MINUTE = 60;

/** Minute candles from a coin's trades, in time order: the price after each trade (currency per token) and the
 *  currency it moved, in whole units of a currency with `currencyDecimals` (18, STRK's, by default). `startPrice` is
 *  the curve's launch price, where the first candle opens. The market-data service publishes these;
 *  without it, a page builds them from the trades it read itself. */
export function minuteCandles(trades: { time: number; priceAfter: number; currency: bigint }[], startPrice: number, currencyDecimals = 18): Candle[] {
  const unit = 10 ** currencyDecimals;
  return buildCandles(trades.map(t => ({ time: t.time, price: t.priceAfter, volume: Number(t.currency) / unit })), MINUTE, startPrice);
}

/** Candles of `intervalSeconds` (a whole number of minutes) from minute candles. Opens, highs, lows and closes are
 *  exactly what buildCandles makes from the trades themselves; volumes are the same sums, added in another order. */
export function aggregateCandles(minute: Candle[], intervalSeconds: number): Candle[] {
  if (intervalSeconds % MINUTE !== 0) throw new Error("candle intervals are whole minutes");
  const out: Candle[] = [];
  for (const m of minute) {
    const time = Math.floor(m.time / intervalSeconds) * intervalSeconds;
    const c = out[out.length - 1];
    if (c && c.time === time) { c.high = Math.max(c.high, m.high); c.low = Math.min(c.low, m.low); c.close = m.close; c.volume += m.volume; }
    else out.push({ ...m, time });
  }
  return out;
}

/** Prices times `k` (STRK per token to market cap: k is the supply in whole tokens). */
export const scaleCandles = (cs: Candle[], k: number): Candle[] =>
  cs.map(c => ({ ...c, open: c.open * k, high: c.high * k, low: c.low * k, close: c.close * k }));

/** A candle as the service publishes it, to keep its files small: [time, open, high, low, close, volume]. */
export type CandleRow = [number, number, number, number, number, number];
export const candleRow = (c: Candle): CandleRow => [c.time, c.open, c.high, c.low, c.close, c.volume];
/** Reads a published row back; throws on anything that isn't six finite numbers on a minute boundary. */
export function candleOf(r: unknown): Candle {
  if (!Array.isArray(r) || r.length !== 6 || !r.every(v => typeof v === "number" && Number.isFinite(v)) || r[0] % MINUTE !== 0) throw new Error("invalid candle");
  return { time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] };
}

/** A figure at a glance (market caps, volumes, liquidity, the chart's axis): three significant digits with K, M or B,
 *  trailing zeros dropped: 35.1K, 351K, 1.24M, 56.3, 0.413. Below 0.001: "<0.001". */
export function compact(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a < 0.001) return v < 0 ? ">-0.001" : "<0.001";
  const UNITS = ["", "K", "M", "B", "T"];
  let i = 0, x = v;
  while (Math.abs(x) >= 1_000 && i < UNITS.length - 1) { x /= 1_000; i++; }
  let r = Number(x.toPrecision(3));
  if (Math.abs(r) >= 1_000 && i < UNITS.length - 1) { r = Number((r / 1_000).toPrecision(3)); i++; }   // 999.96K is 1M
  return `${r}${UNITS[i]}`;
}
