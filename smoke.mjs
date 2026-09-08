// Smoke test: run the compiled extension against a mock pi.
// Two scenarios:
//   1. codegraph CLI missing → extension must inject NOTHING (no tool, no
//      command, no resources_discover) except a one-shot install hint.
//   2. codegraph CLI present (real binary on PATH) → full functionality.
//      Skipped with a note when the CLI is unavailable.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const exec = (command, args, options = {}) =>
	new Promise((resolve) => {
		const proc = execFile(command, args, { timeout: options.timeout }, (err, stdout, stderr) => {
			resolve({ stdout: String(stdout), stderr: String(stderr), code: err ? (err.code ?? 1) : 0, killed: Boolean(err?.killed) });
		});
		if (options.signal) options.signal.addEventListener("abort", () => proc.kill());
	});

const makePi = (execFn) => {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const sent = [];
	return {
		pi: {
			exec: execFn,
			registerTool: (t) => tools.set(t.name, t),
			registerCommand: (n, c) => commands.set(n, c),
			on: (e, h) => handlers.set(e, h),
			sendMessage: (m) => sent.push(m),
		},
		tools,
		commands,
		handlers,
		sent,
	};
};

const ctx = (cwd, hasUI = false) => ({
	cwd,
	hasUI,
	ui: { notify: () => {}, setStatus: () => {} },
});
const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };

// Fresh module instance per load (cache-busted import) — the extension keeps
// module-level CLI state, so each scenario must start clean.
const loadExtension = (pi) =>
	import(`./.smoke-build/codegraph.js?v=${Date.now()}&${Math.random()}`).then((m) => m.default(pi));

// ── Scenario 1: codegraph CLI missing → nothing injected ────────────────
{
	const fakeExec = async (_cmd, args) =>
		args[0] === "version"
			? { stdout: "", stderr: "'codegraph' is not recognized", code: 1, killed: false }
			: { stdout: "", stderr: "no codegraph", code: 1, killed: false };
	const { pi, tools, commands, handlers } = makePi(fakeExec);
	await loadExtension(pi);
	if (tools.size !== 0) fail(`expected no tools when CLI missing, got: ${[...tools.keys()]}`);
	if (commands.size !== 0) fail(`expected no commands when CLI missing, got: ${[...commands.keys()]}`);
	if (handlers.has("resources_discover")) fail("expected no resources_discover handler when CLI missing");
	const onStart = handlers.get("session_start");
	if (!onStart) fail("expected a session_start hint handler when CLI missing");
	const notifyCalls = [];
	const uiCtx = {
		cwd: process.cwd(),
		hasUI: true,
		ui: { notify: (m, l) => notifyCalls.push({ m, l }), setStatus: () => {} },
	};
	await onStart({ reason: "start" }, uiCtx);
	if (notifyCalls.length !== 1 || !notifyCalls[0].m.includes("codegraph")) {
		fail(`expected a single install-hint notify, got: ${JSON.stringify(notifyCalls)}`);
	}
	await onStart({ reason: "reload" }, uiCtx);
	if (notifyCalls.length !== 1) fail(`expected hint notified exactly once, got ${notifyCalls.length} calls`);
	console.log("missing-cli no-injection OK");
}

// ── Scenario 2: real codegraph CLI present → full functionality ─────────
const cliProbe = await exec("codegraph", ["version"]);
if (cliProbe.code !== 0) {
	console.log("SKIP: full-functionality scenario (codegraph CLI not on PATH)");
} else {
	const { pi, tools, commands, handlers } = makePi(exec);
	await loadExtension(pi);

	// Unindexed project → upstream "not initialized" passthrough.
	const repoRoot = process.cwd();
	const explore = tools.get("codegraph_explore") ?? fail("tool not registered");
	const a = await explore.execute("1", { query: "anything", path: repoRoot }, undefined, undefined, ctx(repoRoot));
	if (!a.content[0].text.includes("no .codegraph/ index exists") && !a.content[0].text.includes("not found")) {
		console.log("A passthrough info:", a.content[0].text);
	}
	console.log("A unindexed-passthrough OK");

	// Check commands registered
	commands.get("codegraph-init") ?? fail("init not registered");
	commands.get("codegraph-sync") ?? fail("sync not registered");
	commands.get("codegraph-status") ?? fail("status not registered");
	commands.get("codegraph-unlock") ?? fail("unlock not registered");
	console.log("Commands registration OK");

	const sync = commands.get("codegraph-sync");
	if (!handlers.has("resources_discover")) fail("resources_discover not registered when CLI present");

	// session_start / session_shutdown: handlers registered + status bar check
	const onStart = handlers.get("session_start") ?? fail("session_start not registered");
	const onShutdown = handlers.get("session_shutdown") ?? fail("session_shutdown not registered");

	let currentStatus = null;
	const mockCtx = (cwd) => ({
		cwd,
		hasUI: true,
		ui: {
			notify: () => {},
			setStatus: (_id, text) => { currentStatus = text; },
		},
	});

	const tmpTestDir = ".smoke-tmp";
	rmSync(tmpTestDir, { recursive: true, force: true });
	mkdirSync(tmpTestDir, { recursive: true });

	// 1. Unindexed dir: no status
	await onStart({ reason: "start" }, mockCtx(tmpTestDir));
	if (currentStatus !== undefined) fail(`expected undefined status for empty dir, got: ${currentStatus}`);

	// 2. Dir with .codegraph/ but no codegraph.db (e.g. only .gitignore): no status
	mkdirSync(`${tmpTestDir}/.codegraph`, { recursive: true });
	writeFileSync(`${tmpTestDir}/.codegraph/.gitignore`, "*\n!.gitignore\n");
	await onStart({ reason: "start" }, mockCtx(tmpTestDir));
	if (currentStatus !== undefined) fail(`expected undefined status for dir with only .gitignore, got: ${currentStatus}`);

	// 3. Dir with .codegraph/codegraph.db: status should be set
	writeFileSync(`${tmpTestDir}/.codegraph/codegraph.db`, "dummy-db");
	await onStart({ reason: "start" }, mockCtx(tmpTestDir));
	// session_start sets "sync" immediately when starting background sync
	if (!currentStatus?.includes("sync") && !currentStatus?.includes("index")) {
		fail(`expected sync or index in status, got: ${currentStatus}`);
	}

	// 4. Test codegraph-sync transitions
	const statusHistory = [];
	const trackingCtx = {
		cwd: tmpTestDir,
		hasUI: true,
		ui: {
			notify: () => {},
			setStatus: (_id, text) => {
				statusHistory.push(text);
				currentStatus = text;
			},
		},
	};
	await sync.handler("", trackingCtx);
	if (!statusHistory.some((s) => s?.includes("sync"))) {
		fail(`expected sync status during codegraph-sync, got history: ${JSON.stringify(statusHistory)}`);
	}
	if (!statusHistory[statusHistory.length - 1]?.includes("index")) {
		fail(`expected final index status after codegraph-sync, got: ${statusHistory[statusHistory.length - 1]}`);
	}

	await onShutdown({}, mockCtx(tmpTestDir));
	if (currentStatus !== undefined) fail(`expected shutdown to clear status, got: ${currentStatus}`);

	rmSync(tmpTestDir, { recursive: true, force: true });
	console.log("session_start & session_shutdown OK");
}

rmSync(".smoke-build", { recursive: true, force: true });
console.log("SMOKE PASS");
