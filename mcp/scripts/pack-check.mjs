// Checks that the MCP server works as an installed npm package, WITHOUT publishing anything: builds the SDK and the
// server into JavaScript, packs both as they would be published (the server's package depends on the SDK's version,
// not on the folder beside it), installs the two tarballs into an empty project in a temporary folder, and runs the
// installed `hokori-mcp` command there: it must answer an MCP client over stdio.
//   node scripts/pack-check.mjs        (from mcp/, after npm ci in sdk/ and mcp/)
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MCP = fileURLToPath(new URL("..", import.meta.url)), SDK = join(MCP, "..", "sdk");
const win = process.platform === "win32";
// npm and tsc are .cmd scripts on Windows, which only start through the shell; node itself doesn't need it.
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", shell: win && cmd !== process.execPath, stdio: ["ignore", "pipe", "pipe"] });
const tsc = join(MCP, "node_modules", ".bin", win ? "tsc.cmd" : "tsc");
const work = mkdtempSync(join(tmpdir(), "hokori-mcp-pack-"));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`); };
const json = path => JSON.parse(readFileSync(path, "utf8"));

/** Packs `dir`'s build as published: `files` and `exports`/`bin` as given, no scripts or devDependencies. */
function pack(dir, name, patch) {
  const stage = join(work, `stage-${name}`);
  mkdirSync(stage);
  cpSync(join(dir, "dist"), join(stage, "dist"), { recursive: true });
  cpSync(join(dir, "README.md"), join(stage, "README.md"));
  if (existsSync(join(dir, "LICENSE"))) cpSync(join(dir, "LICENSE"), join(stage, "LICENSE"));   // the public copy has one
  const pkg = json(join(dir, "package.json"));
  delete pkg.scripts; delete pkg.devDependencies;
  Object.assign(pkg, patch(pkg));
  writeFileSync(join(stage, "package.json"), JSON.stringify(pkg, null, 2));
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", work], stage))[0];
  return { pkg, packed, tarball: join(work, packed.filename) };
}

try {
  const sdkPkg = json(join(SDK, "package.json")), mcpPkg = json(join(MCP, "package.json"));
  const sdkSpec = mcpPkg.dependencies?.[sdkPkg.name];
  check("the server depends on the SDK beside it", sdkSpec === "file:../sdk", `${sdkPkg.name}: ${sdkSpec}`);

  // 1. Both builds.
  for (const dir of [SDK, MCP]) rmSync(join(dir, "dist"), { recursive: true, force: true });
  run(tsc, ["-p", "tsconfig.build.json"], SDK);
  run(tsc, ["-p", "tsconfig.build.json"], MCP);
  const server = readFileSync(join(MCP, "dist", "server.js"), "utf8");
  check("the server builds into JavaScript, starting as a program", server.startsWith("#!/usr/bin/env node") && server.includes('from "./tools.js"') && existsSync(join(MCP, "dist", "tools.js")));

  // 2. The packages as they would be published.
  const sdk = pack(SDK, "sdk", () => ({ files: ["dist", "README.md"], types: "./dist/index.d.ts", exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } } }));
  const mcp = pack(MCP, "mcp", pkg => ({ files: ["dist", "README.md"], bin: { "hokori-mcp": "./dist/server.js" },
    dependencies: { ...pkg.dependencies, [sdkPkg.name]: `^${sdkPkg.version}` } }));
  const files = mcp.packed.files.map(f => f.path).sort();
  const stray = files.filter(f => !["package.json", "README.md", "LICENSE", "dist/server.js", "dist/tools.js"].includes(f));
  check("the server's tarball holds only its build, the README, the licence and package.json", stray.length === 0, `${files.length} files, ${(mcp.packed.size / 1024).toFixed(0)} KB${stray.length ? `; unexpected: ${stray.join(", ")}` : ""}`);
  check("it depends on the SDK by version", mcp.pkg.dependencies[sdkPkg.name] === `^${sdkPkg.version}`, `${sdkPkg.name}@^${sdkPkg.version}`);
  check("both still private: npm refuses to publish them", sdk.pkg.private === true && mcp.pkg.private === true);

  // 3. Installed into an empty project, the SDK from its tarball (nothing from the registry under its name).
  const app = join(work, "app");
  mkdirSync(app);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "mcp-consumer", private: true, type: "module" }));
  run("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline", sdk.tarball, mcp.tarball], app);
  const installedSdk = json(join(app, "node_modules", ...sdkPkg.name.split("/"), "package.json"));
  check("the SDK it runs on is the one packed here", installedSdk.description === sdkPkg.description && installedSdk.version === sdkPkg.version);

  // 4. The installed command answers an MCP client: the handshake, then the tool list (no chain is read for either).
  const bin = join(app, "node_modules", ".bin", win ? "hokori-mcp.cmd" : "hokori-mcp");
  // The client then closes its end, as MCP clients do, and the server must exit by itself (on Windows the command is a
  // launcher, and stopping the launcher would leave the server running).
  const { answers, exited } = await new Promise((resolve, reject) => {
    const child = spawn(bin, [], { cwd: app, shell: win, env: { ...process.env, HOKORI_NETWORK: "sepolia" }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", lines = [];
    const timer = setTimeout(() => { child.stdin.end(); reject(new Error(`no answer and exit within 20 s; stderr: ${err.slice(0, 300)}`)); }, 20_000);
    child.stdout.on("data", d => {
      out += d;
      lines = out.split("\n").filter(Boolean);
      if (lines.length >= 2) child.stdin.end();
    });
    child.stderr.on("data", d => { err += d; });
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("exit", code => { clearTimeout(timer); resolve({ answers: lines.map(l => JSON.parse(l)), exited: code === 0 }); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pack-check", version: "0" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  });
  const tools = answers.find(a => a.id === 2)?.result?.tools?.map(t => t.name) ?? [];
  check("the installed hokori-mcp command answers over stdio", answers.find(a => a.id === 1)?.result?.protocolVersion === "2025-06-18" && tools.includes("quote_trade") && tools.includes("prepare_trade"),
    `tools: ${tools.join(", ")}`);
  check("it exits by itself when the client closes its input", exited);
} catch (e) {
  check("the check completed", false, String(e?.stderr || e?.message || e).slice(0, 600));
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  for (const dir of [SDK, MCP]) rmSync(join(dir, "dist"), { recursive: true, force: true });
}
console.log(`\n${results.filter(Boolean).length}/${results.length} package checks passed (nothing was published)`);
process.exitCode = results.every(Boolean) ? 0 : 1;
