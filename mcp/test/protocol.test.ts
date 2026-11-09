// The MCP server's protocol (server.ts), without a chain: version negotiation, the tool list, a tool's answer and its
// failure (an error the agent reads, not a protocol error), notifications, unknown methods and bad input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { PROTOCOL_VERSIONS, handle, serve } from "../server.ts";
import type { Tool } from "../tools.ts";

const tools: Tool[] = [
  { name: "echo", description: "echoes", inputSchema: { type: "object" }, run: async a => ({ got: a, big: 12345678901234567890n }) },
  { name: "broken", description: "fails", inputSchema: { type: "object" }, run: async () => { throw new Error("That's below the smallest trade the curve takes."); } },
];

test("initialize: the client's protocol version if this server speaks it, else the newest; tools only", async () => {
  const r = await handle(tools, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }) as { result: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(r.result.protocolVersion, "2025-03-26");
  assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
  assert.match(r.result.instructions, /never sign or send/);
  const newer = await handle(tools, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } }) as { result: { protocolVersion: string } };
  assert.equal(newer.result.protocolVersion, PROTOCOL_VERSIONS[0]);
});

test("tools: listed with their schemas; a call answers in text (bigints as strings); a failure is the tool's answer", async () => {
  const list = await handle(tools, { jsonrpc: "2.0", id: 3, method: "tools/list" }) as { result: { tools: { name: string }[] } };
  assert.deepEqual(list.result.tools.map(t => t.name), ["echo", "broken"]);
  const ok = await handle(tools, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo", arguments: { x: 1 } } }) as { result: { content: { text: string }[]; isError?: boolean } };
  assert.deepEqual(JSON.parse(ok.result.content[0].text), { got: { x: 1 }, big: "12345678901234567890" });
  assert.equal(ok.result.isError, undefined);
  const bad = await handle(tools, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "broken", arguments: {} } }) as { result: { content: { text: string }[]; isError: boolean } };
  assert.equal(bad.result.isError, true); assert.match(bad.result.content[0].text, /smallest trade/);
  const unknown = await handle(tools, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } }) as { error: { code: number } };
  assert.equal(unknown.error.code, -32602);
});

test("notifications get no answer; unknown methods and malformed lines get JSON-RPC errors, over stdio", async () => {
  assert.equal(await handle(tools, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const input = new PassThrough(), output = new PassThrough(), lines: string[] = [];
  output.on("data", d => lines.push(...String(d).split("\n").filter(Boolean)));
  const rl = serve(tools, input as never, output as never);
  input.write('{"jsonrpc":"2.0","id":7,"method":"ping"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\nnot json\n{"jsonrpc":"2.0","id":8,"method":"resources/list"}\n');
  // A bare null (or any line that isn't an object) is an invalid request, not a crash.
  input.write('null\n[1,2]\n42\n{"jsonrpc":"2.0","id":9,"method":"ping"}\n');
  for (let i = 0; i < 100 && lines.length < 7; i++) await new Promise(r => setTimeout(r, 10));
  rl.close();
  // Requests are answered as they finish (a slow tool call never holds up a ping): matched by id, as JSON-RPC does.
  const all = lines.map(l => JSON.parse(l)), got = new Map(all.filter(m => m.id !== null).map(m => [m.id, m]));
  assert.deepEqual(got.get(7).result, {}); assert.equal(got.get(8).error.code, -32601); assert.deepEqual(got.get(9).result, {}, "still serving");
  const errors = all.filter(m => m.id === null).map(m => m.error.code).sort((x, y) => x - y);
  assert.deepEqual(errors, [-32700, -32600, -32600, -32600], "the bad line and the three non-objects each get an error");
});
