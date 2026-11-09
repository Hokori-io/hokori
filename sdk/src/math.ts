// Integer helpers with the contracts' exact rounding (contracts/src/math.cairo). Everything is BigInt base units;
// nothing here uses floating point. JavaScript BigInt has no width limit, so the contracts' 512-bit intermediates
// are exact here too.

export const BPS = 10_000n;
export const ONE = 10n ** 18n;   // one whole token, one whole STRK (both 18 decimals)

/** An integer as input: a bigint, a safe integer, or a decimal or 0x string. */
export type IntLike = bigint | number | string;

const big = (v: unknown, what?: string): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(v)) return BigInt(v);
  throw new TypeError(`${what ?? "value"}: expected an integer, got ${typeof v} ${String(v).slice(0, 40)}`);
};
/** Converts integer-like input (bigint, safe integer, decimal or 0x string) to a non-negative BigInt. */
export function uint(v: IntLike, what?: string): bigint {
  const x = big(v, what);
  if (x < 0n) throw new RangeError(`${what ?? "value"}: negative`);
  return x;
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new RangeError("math: division by zero");
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}
export const mulDiv = (a: bigint, b: bigint, c: bigint): bigint => {
  if (c === 0n) throw new RangeError("math: division by zero");
  return (a * b) / c;
};
export const mulDivUp = (a: bigint, b: bigint, c: bigint): bigint => {
  if (c === 0n) throw new RangeError("math: division by zero");
  const p = a * b;
  return p % c === 0n ? p / c : p / c + 1n;
};
/** A fee rounded up, in favour of the reserves: ceil(amount * bps / 10_000). */
export const feeUp = (amount: bigint, bps: IntLike): bigint => mulDivUp(amount, BigInt(bps), BPS);

/** Integer square root (floor), as Cairo's u256 sqrt. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("isqrt: negative");
  if (n < 2n) return n;
  // Newton's method from a power of two at or above the root: it decreases to floor(sqrt(n)) exactly, at any size (a
  // floating-point first guess is off by far more than one step for large numbers, which a step-by-one fix-up can't
  // close in any reasonable time).
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/**
 * A ratio as a decimal string with `places` decimals (rounded down), for display only: e.g. a price in STRK per
 * whole token, or a percentage. Never feed the result back into arithmetic.
 */
export function ratioToDecimal(num: bigint, den: bigint, places = 6): string {
  if (den === 0n) throw new RangeError("ratio: zero denominator");
  const neg = (num < 0n) !== (den < 0n) && num !== 0n;
  const n = num < 0n ? -num : num, d = den < 0n ? -den : den;
  const scale = 10n ** BigInt(places);
  const scaled = (n * scale) / d;
  const whole = scaled / scale, frac = (scaled % scale).toString().padStart(places, "0");
  return `${neg ? "-" : ""}${whole}${places ? "." + frac : ""}`;
}

/** Base units to a decimal string (18 decimals by default), rounded down. */
export const formatUnits = (amount: bigint, decimals = 18, places = 6): string => ratioToDecimal(amount, 10n ** BigInt(decimals), places);

/** A decimal string ("12.5") to base units (18 decimals by default). Refuses more decimals than the unit has. */
export function parseUnits(text: string, decimals = 18): bigint {
  const m = /^\s*(\d+)(?:\.(\d*))?\s*$/.exec(String(text));
  if (!m) throw new TypeError(`not a decimal amount: ${text}`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new RangeError(`more than ${decimals} decimals: ${text}`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}
