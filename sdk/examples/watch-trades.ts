// Follows Hokori's live stream and reports launches, graduations and large trades: to the console, and to a Telegram
// chat when TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set in the environment (never put the token in code or chat).
// It resumes where it stopped: the resume point is kept in a small file.
//
//   node examples/watch-trades.ts --data https://data.hokori.io [--min-strk 500] [--state watch-state.txt]
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { formatUnits, parseUnits, streamBlocks } from "@hokoridotio/sdk";

const { values: a } = parseArgs({ options: { data: { type: "string" }, "min-strk": { type: "string", default: "500" }, state: { type: "string", default: "watch-state.txt" } } });
if (!a.data) { console.error("usage: --data <market-data service URL>"); process.exit(2); }
const big = parseUnits(a["min-strk"]!);
let from: string | undefined;
try { from = readFileSync(a.state!, "utf8").trim() || undefined; } catch { /* first run: start at the newest block */ }

const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
async function say(text: string) {
  console.log(text);
  if (!token || !chat) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) }).catch(e => console.error(`Telegram: ${e}`));
}

const stream = streamBlocks({
  url: a.data, from,
  onBlock(b) {
    for (const l of b.launches) void say(`New coin: ${l.name} ($${l.symbol}) ${l.token}`);
    for (const g of b.graduations) void say(`Graduated to its Ekubo pool: ${g.token}`);
    for (const t of b.trades) if (t.currency >= big) void say(`${t.side === "buy" ? "Buy" : "Sell"} of ${formatUnits(t.currency, 18, 2)} STRK in ${t.token}`);
    writeFileSync(a.state!, stream.last ?? "");
  },
  onRollback: block => console.log(`the chain replaced blocks after ${block}: what follows replaces anything reported since`),
  onError: e => console.error(`stream: ${e instanceof Error ? e.message : e} (reconnecting)`),
});
process.on("SIGINT", () => { stream.close(); process.exit(0); });
