// The market-data service's live stream (its /stream endpoint): Hokori's launches, trades and graduations, block by
// block, as they're indexed. It reconnects by itself and resumes after the last block received (by block and hash, so a
// block replaced while it was away is rolled back), and drops repeats. Display and discovery only: anything you sign
// starts from the chain (reads.ts). Works wherever fetch streams bodies (Node 18+, browsers, workers).
import type { Launch, Trade } from "./trades.ts";

export type StreamBlock = {
  block: number; hash: string; time: number;
  launches: (Launch & { launchTime: number })[];
  trades: (Trade & { token: string })[];
  graduations: { token: string; pool: string }[];
};
export type StreamHandlers = {
  /** A block's events, oldest block first, each block once. */
  onBlock(b: StreamBlock): void;
  /** The chain replaced blocks: drop everything after `block`; the stream then sends the new ones. */
  onRollback?(block: number): void;
  /** Where the service's index stands, after each of its cycles (also when nothing happened). */
  onHead?(h: { indexedBlock: number; headBlock?: number }): void;
  /** A connection failed or ended; the stream reconnects by itself after `retryMs` (doubling to 30 s), or after the
   *  service's own `Retry-After` when it is longer (a 429: too many connections from this address; a 503: full). */
  onError?(e: unknown): void;
};

const ADDRESS = /^0x[0-9a-f]{1,64}$/, AMOUNT = /^[0-9]{1,78}$/;
function blockOf(j: Record<string, unknown>): StreamBlock {
  const ok = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  if (!ok(j.block) || typeof j.hash !== "string" || !ok(j.time) || !Array.isArray(j.launches) || !Array.isArray(j.trades) || !Array.isArray(j.graduations))
    throw new Error("invalid stream block");
  const trades = (j.trades as Record<string, unknown>[]).map(t => {
    if (typeof t.token !== "string" || !ADDRESS.test(t.token) || typeof t.tokens !== "string" || !AMOUNT.test(t.tokens) || typeof t.currency !== "string"
      || !AMOUNT.test(t.currency) || !["curve", "pool"].includes(t.venue as string) || !["buy", "sell"].includes(t.side as string)) throw new Error("invalid stream trade");
    return { ...t, tokens: BigInt(t.tokens), currency: BigInt(t.currency) } as Trade & { token: string };
  });
  const launches = (j.launches as Record<string, unknown>[]).map(l => {
    if (typeof l.token !== "string" || !ADDRESS.test(l.token)) throw new Error("invalid stream launch");
    return { ...l, metadataSha256: BigInt(l.metadataSha256 as string), devTokens: BigInt(l.devTokens as string), launchFee: BigInt(l.launchFee as string) } as Launch & { launchTime: number };
  });
  return { block: j.block as number, hash: j.hash, time: j.time as number, launches, trades, graduations: j.graduations as StreamBlock["graduations"] };
}

/**
 * Follows `<url>/stream` from block `from` (exclusive; leave it out to start at the newest block). Returns `close()`,
 * and the resume point (`last`: "<block>:<hash>"), which you can store and pass as `from` next time.
 */
export function streamBlocks(o: StreamHandlers & { url: string; from?: number | string; fetcher?: typeof fetch; retryMs?: number }) {
  const fetcher = o.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const base = o.url.replace(/\/$/, "");
  let last: string | null = o.from === undefined ? null : String(o.from);
  let lastBlock = last === null ? -Infinity : Number(last.split(":")[0]);
  let closed = false, abort: AbortController | null = null, wait = o.retryMs ?? 1_000;

  function dispatch(event: string, data: string, id: string | null) {
    const j = JSON.parse(data) as Record<string, unknown>;
    if (event === "block") {
      const b = blockOf(j);
      if (b.block <= lastBlock) return;   // a repeat after a reconnect
      o.onBlock(b);
      lastBlock = b.block; last = id ?? String(b.block);
    } else if (event === "rollback") {
      const block = Number(j.block);
      if (!Number.isSafeInteger(block)) throw new Error("invalid rollback");
      o.onRollback?.(block);
      lastBlock = Math.min(lastBlock, block); last = String(block);
    } else if (event === "head") o.onHead?.(j as { indexedBlock: number; headBlock?: number });
  }

  async function connect() {
    abort = new AbortController();
    const r = await fetcher(`${base}/stream${last === null ? "" : `?from=${encodeURIComponent(last)}`}`, { headers: { accept: "text/event-stream" }, signal: abort.signal });
    if (!r.ok || !r.body) {
      // The service's Retry-After, in seconds (at most 5 minutes), is honoured when it asks for longer than the backoff.
      const after = Number(r.headers?.get?.("retry-after"));
      throw Object.assign(new Error(`the stream answered ${r.status}`), { retryAfterMs: Number.isFinite(after) && after > 0 ? Math.min(after, 300) * 1000 : 0 });
    }
    wait = o.retryMs ?? 1_000;   // connected: the next failure starts the backoff over
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error("the stream ended");
      buffer += value;
      let end: number;
      while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const chunk = buffer.slice(0, end);
        buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
        let event = "message", id: string | null = null;
        const data: string[] = [];
        for (const line of chunk.split(/\r?\n/)) {
          if (!line || line.startsWith(":")) continue;
          const at = line.indexOf(":"), field = at < 0 ? line : line.slice(0, at), v = at < 0 ? "" : line.slice(at + 1).replace(/^ /, "");
          if (field === "event") event = v; else if (field === "data") data.push(v); else if (field === "id") id = v;
        }
        if (data.length) dispatch(event, data.join("\n"), id);
      }
    }
  }

  void (async () => {
    while (!closed) {
      try { await connect(); }
      catch (e) {
        if (closed) break;
        o.onError?.(e);
        const asked = (e as { retryAfterMs?: number } | null)?.retryAfterMs ?? 0;
        await new Promise(r => setTimeout(r, Math.max(wait, asked)));
        wait = Math.min(wait * 2, 30_000);
      }
    }
  })();

  return {
    close() { closed = true; abort?.abort(); },
    get last() { return last; },
  };
}
