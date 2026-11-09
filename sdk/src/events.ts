/**
 * Reading Starknet events completely. A block range only counts as read once every page of it has been: the
 * continuation token is followed to the end, and a failure on any page fails the whole read, so callers keep their
 * cursor and read the same range again. Never a silent cut-off: past `maxPages` the read throws instead (the market-data
 * service then reads a smaller range; a browser leaves a history that large to the service).
 */
export type ChainEvent = { keys: string[]; data: string[]; block_number?: number; block_hash?: string; transaction_hash: string; from_address?: string };
export type EventFilter = {
  address?: string; keys: string[][]; chunk_size: number; continuation_token?: string;
  from_block: { block_number: number }; to_block: { block_number: number } | "latest";
};
export type EventSource = { getEvents(filter: EventFilter): Promise<{ events: ChainEvent[]; continuation_token?: string }> };

export class HistoryTooLargeError extends Error {}

/** Every event in blocks `from`..`to` matching `keys`: from one contract, or chain-wide when `address` is left out. */
export async function allEvents(provider: EventSource, f: { address?: string; keys: string[][]; from: number; to: number | "latest" },
  { chunk = 500, maxPages = 2_000 }: { chunk?: number; maxPages?: number } = {}): Promise<ChainEvent[]> {
  const out: ChainEvent[] = [];
  let token: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= maxPages) throw new HistoryTooLargeError(`more than ${(maxPages * chunk).toLocaleString("en-US")} events in blocks ${f.from} to ${f.to}; read a smaller range`);
    const r = await provider.getEvents({ ...(f.address === undefined ? {} : { address: f.address }), keys: f.keys, from_block: { block_number: f.from },
      to_block: f.to === "latest" ? "latest" : { block_number: f.to }, chunk_size: chunk, continuation_token: token });
    out.push(...r.events);
    if (!r.continuation_token) return out;
    token = r.continuation_token;
  }
}
