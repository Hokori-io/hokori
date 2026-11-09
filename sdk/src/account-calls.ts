/** Decode the two standard account __execute__ layouts without searching arbitrary calldata for matching felts.
 * Counts, lengths, legacy offsets and the entire payload must agree; unknown/ambiguous layouts aren't evidence. */
export type AccountCall = { target: bigint; selector: bigint; args: bigint[] };
const FIELD = (1n << 251n) + 17n * (1n << 192n) + 1n;

export function felt(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) throw new Error("invalid felt");
  const n = BigInt(value);
  if (n >= FIELD) throw new Error("felt out of range");
  return n;
}

const same = (a: AccountCall[], b: AccountCall[]) => a.length === b.length && a.every((c, i) =>
  c.target === b[i].target && c.selector === b[i].selector && c.args.length === b[i].args.length && c.args.every((v, j) => v === b[i].args[j]));
export const sameCalls = same;

export function decodeAccountCalls(values: string[]): AccountCall[] | null {
  try {
    const cd = values.map(felt), size = cd.length;
    if (!size || cd[0] > BigInt(Math.floor((size - 1) / 3))) return null;
    const count = Number(cd[0]);
    function current(): AccountCall[] | null {
      const calls: AccountCall[] = [];
      let pos = 1;
      for (let i = 0; i < count; i++) {
        if (pos + 3 > size) return null;
        const [target, selector, length] = cd.slice(pos, pos + 3);
        pos += 3;
        if (length > BigInt(size - pos)) return null;
        calls.push({ target, selector, args: cd.slice(pos, pos + Number(length)) });
        pos += Number(length);
      }
      return pos === size ? calls : null;
    }
    function legacy(): AccountCall[] | null {
      const start = 1 + count * 4;
      if (start >= size || cd[start] !== BigInt(size - start - 1)) return null;
      const body = cd.slice(start + 1), calls: AccountCall[] = [];
      let pos = 0;
      for (let i = 0; i < count; i++) {
        const [target, selector, offset, length] = cd.slice(1 + i * 4, 5 + i * 4);
        // Canonical legacy encoding: contiguous argument segments, with no aliases, gaps or trailing data.
        if (offset !== BigInt(pos) || length > BigInt(body.length - pos)) return null;
        calls.push({ target, selector, args: body.slice(pos, pos + Number(length)) });
        pos += Number(length);
      }
      return pos === body.length ? calls : null;
    }
    const a = current(), b = legacy();
    if (a && b) return same(a, b) ? a : null;
    return a ?? b;
  } catch { return null; }
}

/** Fingerprints saved before and after this fix pair [target, selector] with that call's arguments. */
export function fingerprintCalls(fingerprint: string[][]): AccountCall[] | null {
  if (!Array.isArray(fingerprint) || !fingerprint.length || fingerprint.length % 2) return null;
  try {
    const calls: AccountCall[] = [];
    for (let i = 0; i < fingerprint.length; i += 2) {
      const header = fingerprint[i], args = fingerprint[i + 1];
      if (!Array.isArray(header) || header.length !== 2 || !Array.isArray(args)) return null;
      calls.push({ target: felt(header[0]), selector: felt(header[1]), args: args.map(felt) });
    }
    return calls;
  } catch { return null; }
}
