// Checks that @hokoridotio/sdk works as an installed package, as it would from npm, WITHOUT publishing anything: builds
// it into JavaScript with type declarations (tsconfig.build.json), packs a tarball whose exports point at the build,
// checks what the tarball contains (the build, the README and package.json; nothing else), installs it into an empty
// project in a temporary folder, and uses it there from plain Node and from a strict TypeScript project.
//   node scripts/pack-check.mjs        (from sdk/)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SDK = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
// npm and tsc are .cmd scripts on Windows, which only start through the shell; node itself doesn't need it.
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", shell: process.platform === "win32" && cmd !== process.execPath, stdio: ["ignore", "pipe", "pipe"] });
const tsc = join(SDK, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const work = mkdtempSync(join(tmpdir(), "hokori-sdk-pack-"));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`); };

try {
  // 1. The build.
  rmSync(join(SDK, "dist"), { recursive: true, force: true });
  run(tsc, ["-p", "tsconfig.build.json"], SDK);
  check("builds into JavaScript with declarations", readFileSync(join(SDK, "dist", "index.js"), "utf8").includes('from "./math.js"'));

  // 2. The package as it would be published: exports pointing at the build.
  const stage = join(work, "stage");
  mkdirSync(stage);
  cpSync(join(SDK, "dist"), join(stage, "dist"), { recursive: true });
  cpSync(join(SDK, "README.md"), join(stage, "README.md"));
  if (existsSync(join(SDK, "LICENSE"))) cpSync(join(SDK, "LICENSE"), join(stage, "LICENSE"));   // the public copy has one
  const pkg = JSON.parse(readFileSync(join(SDK, "package.json"), "utf8"));
  delete pkg.scripts; delete pkg.devDependencies;
  Object.assign(pkg, { files: ["dist", "README.md"], types: "./dist/index.d.ts", exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } } });
  writeFileSync(join(stage, "package.json"), JSON.stringify(pkg, null, 2));
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", work], stage))[0];
  const files = packed.files.map(f => f.path).sort();
  const stray = files.filter(f => !(f === "package.json" || f === "README.md" || f === "LICENSE" || /^dist\/[a-z-]+\.(js|d\.ts)$/.test(f)));
  check("the tarball holds only the build, the README and package.json", stray.length === 0, `${files.length} files, ${(packed.size / 1024).toFixed(0)} KB${stray.length ? `; unexpected: ${stray.join(", ")}` : ""}`);
  check("no dependencies", !pkg.dependencies && !pkg.peerDependencies);
  check("still private: npm refuses to publish it", pkg.private === true);

  // 3. Installed into an empty project, used from plain Node.
  const app = join(work, "app");
  mkdirSync(app);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "sdk-consumer", private: true, type: "module" }));
  run("npm", ["install", "--no-audit", "--no-fund", join(work, packed.filename)], app);
  writeFileSync(join(app, "use.mjs"), `
import { ONE, NETWORKS, createHokori, curveParams, factoryFigures, initialState, quoteBuy, streamBlocks } from "@hokoridotio/sdk";
const f = factoryFigures(curveParams({ v0: 24351405875677720337915n, t0: 1_073_000_000n * ONE, curve_tokens: 793_100_000n * ONE, min_trade: 10n ** 12n, fee_bps: 90n, grad_fee_bps: 100n }));
const q = quoteBuy(initialState(f.params), f.params, 100n * ONE);
console.log(JSON.stringify({ raises: String(f.seed.real / ONE), out: String(q.out), sepolia: NETWORKS.sepolia.chainId, client: typeof createHokori, stream: typeof streamBlocks }));
`);
  const used = JSON.parse(run(process.execPath, ["use.mjs"], app));
  check("works from plain Node once installed", used.raises === "69000" && BigInt(used.out) > 0n && used.client === "function" && used.stream === "function", `69K curve: 100 STRK buys ${used.out} base units`);

  // 4. Used from a strict TypeScript project (node16 resolution, as most bots use).
  writeFileSync(join(app, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "node16", moduleResolution: "node16", strict: true, noEmit: true, skipLibCheck: false, lib: ["ES2022", "DOM"] }, include: ["use.ts"] }));
  writeFileSync(join(app, "use.ts"), `
import { createHokori, type CoinOnChain, type HokoriProvider, type TradeQuote } from "@hokoridotio/sdk";
export async function buy(provider: HokoriProvider, token: string): Promise<TradeQuote> {
  const hokori = createHokori({ network: "sepolia", provider });
  const coin: CoinOnChain = await hokori.coin(token);
  return hokori.quote(coin, { side: "buy", amount: 10n ** 18n, slippageBps: 100 });
}
`);
  let typed = "";
  try { run(tsc, ["-p", "tsconfig.json"], app); } catch (e) { typed = String(e.stdout || e.message).slice(0, 600); }
  check("its types check in a strict TypeScript project", typed === "", typed);
} catch (e) {
  check("the check completed", false, String(e?.stderr || e?.message || e).slice(0, 600));
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(join(SDK, "dist"), { recursive: true, force: true });
}
console.log(`\n${results.filter(Boolean).length}/${results.length} package checks passed (nothing was published)`);
process.exitCode = results.every(Boolean) ? 0 : 1;
