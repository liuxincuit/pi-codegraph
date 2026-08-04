// Smoke test: run the compiled extension against a mock pi + real codegraph CLI.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import codegraphExtension from "./.smoke-build/codegraph.js";

const exec = (command, args, options = {}) =>
	new Promise((resolve) => {
		const proc = execFile(command, args, { timeout: options.timeout }, (err, stdout, stderr) => {
			resolve({ stdout: String(stdout), stderr: String(stderr), code: err ? (err.code ?? 1) : 0, killed: Boolean(err?.killed) });
		});
		if (options.signal) options.signal.addEventListener("abort", () => proc.kill());
	});

const tools = new Map();
const commands = new Map();
const handlers = new Map();
const pi = {
	exec,
	registerTool: (t) => tools.set(t.name, t),
	registerCommand: (n, c) => commands.set(n, c),
	on: (e, h) => handlers.set(e, h),
	sendMessage: () => {},
};
codegraphExtension(pi);

const ctx = (cwd) => ({ cwd, hasUI: false, ui: { notify: () => {} } });
const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };

// Scenario A: unindexed project → upstream "not initialized" passthrough.
const repoRoot = process.cwd();
const explore = tools.get("codegraph_explore") ?? fail("tool not registered");
const a = await explore.execute("1", { query: "anything", path: repoRoot }, undefined, undefined, ctx(repoRoot));
if (!a.content[0].text.includes("no .codegraph/ index exists")) fail("A: unexpected output: " + a.content[0].text);
console.log("A unindexed-passthrough OK");

// Scenario B: init a tiny project via /codegraph-init, then explore it.
const tmp = "/tmp/cg-smoke";
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
writeFileSync(`${tmp}/greet.ts`, 'export function greet(name: string): string {\n\treturn `hello ${name}`;\n}\n');
writeFileSync(`${tmp}/main.ts`, 'import { greet } from "./greet";\nexport function main(): void {\n\tconsole.log(greet("world"));\n}\n');

const init = commands.get("codegraph-init") ?? fail("init not registered");
await init.handler("", ctx(tmp));
const st = await pi.exec("codegraph", ["status", tmp], {});
if (st.code !== 0 || !st.stdout.includes("Files")) fail("B: init did not produce an index: " + st.stdout + st.stderr);
console.log("B init OK");

const b = await explore.execute("2", { query: "greet" }, undefined, undefined, ctx(tmp));
if (b.content[0].text.includes("no .codegraph/ index")) fail("B: explore ignored ctx.cwd default: " + b.content[0].text.slice(0, 200));
console.log("B explore-default-cwd OK");

const c = await explore.execute("3", { query: "greet", path: tmp }, undefined, undefined, ctx("/nonexistent"));
if (c.code === 0) fail("unreachable");
if (!c.content[0].text.includes("greet")) fail("B: explore output missing symbol: " + c.content[0].text.slice(0, 200));
console.log("B explore OK — output head:", c.content[0].text.split("\n")[0]);

// session_start: sync fires without throwing on indexed + unindexed projects.
const onStart = handlers.get("session_start") ?? fail("session_start not registered");
await onStart({}, ctx(tmp));
await onStart({}, ctx(repoRoot));
console.log("session_start OK");

rmSync(".smoke-build", { recursive: true, force: true });
rmSync(tmp, { recursive: true, force: true });
console.log("SMOKE PASS");
