// streamBlocks against a scripted service: blocks arrive in order and resume after a reconnect, and a refusal's
// Retry-After is honoured before the next attempt (a 429 when an address has too many connections; a 503 when full).
import { test } from "node:test";
import assert from "node:assert/strict";
import { streamBlocks } from "../src/index.ts";

const block = n => JSON.stringify({ block: n, hash: `0x${n.toString(16)}`, time: 1_700_000_000 + n, launches: [], trades: [], graduations: [] });
/** A response whose body is these server-sent events, then ends (the client reconnects). */
const events = lines => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(lines.join(""))); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });

test("blocks in order; after the connection ends, it resumes from the last block, without repeats", async () => {
  const asked = [], got = [];
  let s;
  const done = new Promise(resolve => {
    const answers = [
      () => events([`id: 1:0x1\nevent: block\ndata: ${block(1)}\n\n`, `id: 2:0x2\nevent: block\ndata: ${block(2)}\n\n`]),
      () => events([`id: 2:0x2\nevent: block\ndata: ${block(2)}\n\n`, `id: 3:0x3\nevent: block\ndata: ${block(3)}\n\n`]),
    ];
    s = streamBlocks({ url: "https://data.test/", retryMs: 5, onBlock: b => { got.push(b.block); if (b.block === 3) resolve(); },
      fetcher: async url => { asked.push(String(url)); const a = answers.shift(); return a ? a() : new Response(null, { status: 503 }); } });
  });
  await done; s.close();
  assert.deepEqual(got, [1, 2, 3]);
  assert.equal(asked[0], "https://data.test/stream");
  assert.equal(asked[1], "https://data.test/stream?from=2%3A0x2");
  assert.equal(s.last, "3:0x3");
});

test("a 429's Retry-After is waited out, even when the backoff is shorter", async () => {
  const at = [];
  let s;
  const done = new Promise(resolve => {
    s = streamBlocks({ url: "https://data.test", retryMs: 5, onBlock: () => resolve(),
      fetcher: async () => {
        at.push(Date.now());
        return at.length === 1 ? new Response(null, { status: 429, headers: { "retry-after": "1" } }) : events([`id: 1:0x1\nevent: block\ndata: ${block(1)}\n\n`]);
      } });
  });
  await done; s.close();
  assert.equal(at.length, 2);
  assert.ok(at[1] - at[0] >= 950, `waited ${at[1] - at[0]} ms after the 429, not the 5 ms backoff`);
});
