// A coin's metadata document: built by the creator, stored permanently (Arweave), and committed by its SHA-256 in the
// launch. Deterministic: the same inputs give the same bytes (fixed key order, no whitespace), so the committed hash can
// be recomputed. Reading it back is untrusted input: the download is capped while it streams, time-limited, and
// checked byte for byte against the committed hash before anything from it is used. SHA-256 is the platform's own
// (WebCrypto: browsers, Node, workers). The fee vault is authoritative for payees; labels here are display text.

export const METADATA_SCHEMA = "hokori-coin/1";
export const MAX_METADATA_BYTES = 64 * 1024;

/** What a page shows from a coin's checked metadata. `image` is a gateway URL; `payeeLabels` by address. */
export type CoinMeta = { name: string; symbol: string; description: string; image: string | null; links: Record<string, string>; payeeLabels: Record<string, string> };

const hex = (v: unknown) => "0x" + BigInt(v as bigint).toString(16).padStart(64, "0");

/** SHA-256 of `bytes`, as a number (what a launch commits). */
export async function sha256Of(bytes: Uint8Array): Promise<bigint> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return BigInt("0x" + Array.from(digest, b => b.toString(16).padStart(2, "0")).join(""));
}

/** The metadata document for a launch, its bytes and their SHA-256. `links` holds full URLs (website, x, telegram);
 *  `imageId` is the image's Arweave transaction ID. */
export async function coinMetadata(o: {
  name: string; symbol: string; description: string; imageId: string; imageType: string;
  links: { website?: string; x?: string; telegram?: string };
  payees: { address: string; bps: number; name?: string }[]; chainId: string;
}): Promise<{ json: string; bytes: Uint8Array; sha256: bigint }> {
  const links: Record<string, string> = {};
  if (o.links.website) links.website = o.links.website;
  if (o.links.x) links.x = o.links.x;
  if (o.links.telegram) links.telegram = o.links.telegram;
  const doc = {
    schema: METADATA_SCHEMA,
    chain: `starknet:${o.chainId}`,
    name: o.name.trim(),
    symbol: o.symbol.trim(),
    description: o.description.trim(),
    image: `ar://${o.imageId}`,
    image_type: o.imageType,
    links,
    payees: o.payees.map(p => (p.name ? { address: p.address, share_bps: p.bps, label: p.name } : { address: p.address, share_bps: p.bps })),
  };
  const json = JSON.stringify(doc);
  const bytes = new TextEncoder().encode(json);
  return { json, bytes, sha256: await sha256Of(bytes) };
}

/** The body, read up to `max` bytes and no further (the read is cancelled once over); null if it's larger. Every
 *  chunk waits no longer than `signal` allows, whether or not the fetch itself honours it. */
async function readCapped(r: Response, max: number, signal: AbortSignal): Promise<Uint8Array | null> {
  if (Number(r.headers.get("content-length") ?? 0) > max) { await r.body?.cancel().catch(() => {}); return null; }
  if (!r.body) { const b = new Uint8Array(await r.arrayBuffer()); return b.length > max ? null : b; }
  const reader = r.body.getReader(), chunks: Uint8Array[] = [];
  const aborted = new Promise<never>((_, reject) => {
    // Reject before cancelling: the cancel ends the pending read as "done", which would otherwise win the race and
    // pass a cut-off body on as if it were complete.
    const stop = () => { reject(signal.reason ?? new Error("timed out")); reader.cancel().catch(() => {}); };
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  });
  aborted.catch(() => {});
  let total = 0;
  for (;;) {
    const { done, value } = await Promise.race([reader.read(), aborted]);
    if (done) break;
    total += value.length;
    if (total > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** A coin's metadata from the link its launch committed, checked against the committed SHA-256 (`sha`). Untrusted
 *  input: the download is capped at MAX_METADATA_BYTES while it streams and must finish within `timeoutMs`, headers
 *  and body. `gateway` serves ar:// links (e.g. "https://arweave.net/"). Never throws: a problem is returned. */
export async function fetchMetadata(uri: string, sha: bigint, { gateway, fetcher = fetch, timeoutMs = 10_000 }: { gateway: string; fetcher?: typeof fetch; timeoutMs?: number }):
  Promise<{ meta: CoinMeta | null; problem: string | null }> {
  const base = gateway.replace(/\/?$/, "/");
  const url = uri.startsWith("ar://") ? `${base}${uri.slice(5)}` : uri.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${uri.slice(7)}` : null;
  if (!url) return { meta: null, problem: "Unknown metadata link." };
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const r = await fetcher(url, { cache: "force-cache", signal });
    if (!r.ok) { await r.body?.cancel().catch(() => {}); return { meta: null, problem: `The metadata isn't available from the gateway yet (${r.status}).` }; }
    const bytes = await readCapped(r, MAX_METADATA_BYTES, signal);
    if (!bytes) return { meta: null, problem: "The metadata file is too large." };
    if (await sha256Of(bytes) !== sha) return { meta: null, problem: "The gateway served a file that doesn't match the coin's committed fingerprint. Nothing from it is shown." };
    const doc = JSON.parse(new TextDecoder().decode(bytes));
    const image = typeof doc.image === "string" && doc.image.startsWith("ar://") ? `${base}${doc.image.slice(5)}` : null;
    const payeeLabels: Record<string, string> = {};
    for (const p of Array.isArray(doc.payees) ? doc.payees : []) if (p?.label && p?.address) payeeLabels[hex(p.address)] = String(p.label).slice(0, 40);
    return { meta: { name: String(doc.name ?? ""), symbol: String(doc.symbol ?? ""), description: String(doc.description ?? ""), image, links: doc.links ?? {}, payeeLabels }, problem: null };
  } catch { return { meta: null, problem: "The metadata couldn't be read." }; }
}
