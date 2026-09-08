// 冒烟测试：对 mock pi 运行编译后的扩展。
// 两个场景：
//   1. codegraph CLI 缺失 → 扩展不得注入任何内容（无工具、无命令、
//      resources_discover），仅有一次性的安装提示。
//   2. codegraph CLI 存在（PATH 上的真实二进制）→ 完整功能：
//      默认仅注册 codegraph_explore；细粒度工具通过 extraTools 配置
//      opt-in（见 docs/adr/0003）。CLI 不可用时自动跳过。
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
	let activeTools = null; // null = 从未设置；getActiveTools 回退为全部已注册工具
	const activeCalls = [];
	return {
		pi: {
			exec: execFn,
			registerTool: (t) => tools.set(t.name, t),
			registerCommand: (n, c) => commands.set(n, c),
			on: (e, h) => handlers.set(e, h),
			sendMessage: (m) => sent.push(m),
			getActiveTools: () => activeTools ?? [...tools.keys()],
			setActiveTools: (names) => {
				activeTools = [...names];
				activeCalls.push([...names]);
			},
		},
		tools,
		commands,
		handlers,
		sent,
		activeCalls,
	};
};

const ctx = (cwd, hasUI = false) => ({
	cwd,
	hasUI,
	isProjectTrusted: () => true,
	ui: { notify: () => {}, setStatus: () => {} },
});
const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };

// 每次加载都使用全新的模块实例（带缓存破坏参数的 import）——扩展保留模块级
// CLI 状态，每个场景必须从干净状态开始。
const loadExtension = (pi) =>
	import(`./.smoke-build/codegraph.js?v=${Date.now()}&${Math.random()}`).then((m) => m.default(pi));

const lastHint = (sent) => {
	const entry =
		[...sent].reverse().find((m) => m.customType === "codegraph-context" && m.display === false) ??
		fail("未发送 codegraph-context 提示");
	return entry.content;
};

// ── 场景 1：codegraph CLI 缺失 → 不注入任何内容 ────────────────────────
{
	const fakeExec = async (_cmd, args) =>
		args[0] === "version"
			? { stdout: "", stderr: "'codegraph' is not recognized", code: 1, killed: false }
			: { stdout: "", stderr: "no codegraph", code: 1, killed: false };
	const { pi, tools, commands, handlers } = makePi(fakeExec);
	await loadExtension(pi);
	if (tools.size !== 0) fail(`CLI 缺失时不应注册任何工具，实际为：${[...tools.keys()]}`);
	if (commands.size !== 0) fail(`CLI 缺失时不应注册任何命令，实际为：${[...commands.keys()]}`);
	if (handlers.has("resources_discover")) fail("CLI 缺失时不应注册 resources_discover 处理器");
	const onStart = handlers.get("session_start");
	if (!onStart) fail("CLI 缺失时仍应注册 session_start 提示处理器");
	const notifyCalls = [];
	const uiCtx = {
		cwd: process.cwd(),
		hasUI: true,
		isProjectTrusted: () => true,
		ui: { notify: (m, l) => notifyCalls.push({ m, l }), setStatus: () => {} },
	};
	await onStart({ reason: "start" }, uiCtx);
	if (notifyCalls.length !== 1 || !notifyCalls[0].m.includes("codegraph")) {
		fail(`应恰好弹出一条安装提示，实际为：${JSON.stringify(notifyCalls)}`);
	}
	await onStart({ reason: "reload" }, uiCtx);
	if (notifyCalls.length !== 1) fail(`安装提示应只弹一次，实际 ${notifyCalls.length} 次`);
	console.log("missing-cli no-injection OK");
}

// ── 场景 2：真实 codegraph CLI 存在 → 完整功能 ──────────────────────────
// npm 全局安装的二进制在 Windows 上是 .cmd 包装；execFile 无法解析它们，
// 因此像扩展的 execCg 一样通过 cmd.exe 探测。
const probe = async () =>
	process.platform === "win32"
		? exec("cmd.exe", ["/d", "/s", "/c", "codegraph", "version"])
		: exec("codegraph", ["version"]);
const cliProbe = await probe();
if (cliProbe.code !== 0) {
	console.log("SKIP: full-functionality scenario (codegraph CLI not on PATH)");
} else {
	const { pi, tools, commands, handlers, sent, activeCalls } = makePi(exec);
	await loadExtension(pi);

	// 未索引项目 → 透传上游 "not initialized" 提示。
	const repoRoot = process.cwd();
	const explore = tools.get("codegraph_explore") ?? fail("工具未注册");
	const a = await explore.execute("1", { query: "anything", path: repoRoot }, undefined, undefined, ctx(repoRoot));
	if (!a.content[0].text.includes("no .codegraph/ index exists") && !a.content[0].text.includes("not found")) {
		console.log("A passthrough info:", a.content[0].text);
	}
	console.log("A unindexed-passthrough OK");

	// 检查命令注册
	commands.get("codegraph-init") ?? fail("init 未注册");
	commands.get("codegraph-sync") ?? fail("sync 未注册");
	commands.get("codegraph-status") ?? fail("status 未注册");
	commands.get("codegraph-unlock") ?? fail("unlock 未注册");
	console.log("Commands registration OK");

	// 默认：只注册 codegraph_explore。
	if (!tools.has("codegraph_explore")) fail("codegraph_explore 未注册");
	if (tools.size !== 1) {
		fail(`默认应只注册 codegraph_explore，实际为：${[...tools.keys()]}`);
	}
	if (!handlers.has("resources_discover")) fail("CLI 存在时未注册 resources_discover");
	console.log("Default tools registration (explore only) OK");

	// ── 配置驱动的 opt-in 工具 ──────────────────────────────────────────
	// 隔离全局配置目录（getAgentDir 遵循 PI_CODING_AGENT_DIR），避免真实的
	// ~/.pi/agent/extensions/pi-codegraph/config.json 泄漏进来。
	const fakeGlobalDir = ".smoke-global";
	rmSync(fakeGlobalDir, { recursive: true, force: true });
	mkdirSync(`${fakeGlobalDir}/extensions/pi-codegraph`, { recursive: true });
	const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = fakeGlobalDir;

	const optin = ".smoke-optin";
	rmSync(optin, { recursive: true, force: true });
	mkdirSync(`${optin}/.pi/extensions/pi-codegraph`, { recursive: true });
	mkdirSync(`${optin}/.codegraph`, { recursive: true });
	writeFileSync(`${optin}/.codegraph/codegraph.db`, "dummy-db"); // 已索引 → 提示会被注入
	const uiCtx = (cwd) => ({
		cwd,
		hasUI: true,
		isProjectTrusted: () => true,
		ui: { notify: () => {}, setStatus: () => {} },
	});

	// 1. 无配置 → 仍只有 explore；提示不宣传任何细粒度工具。
	await handlers.get("session_start")({ reason: "start" }, uiCtx(optin));
	if (!tools.has("codegraph_explore") || tools.size !== 1) {
		fail(`无配置时应只有 explore，实际为：${[...tools.keys()]}`);
	}
	if (!lastHint(sent).includes("默认隐藏")) fail("默认提示必须说明细粒度工具默认隐藏");
	if (lastHint(sent).includes("`codegraph_node` —")) fail("默认提示不得宣传隐藏工具");
	console.log("Opt-in: no-config default OK");

	// 2. 配置开启 node+impact（另给一个未知名 → 警告并忽略）。
	const notifyCalls = [];
	const notifyCtx = {
		cwd: optin,
		hasUI: true,
		isProjectTrusted: () => true,
		ui: { notify: (m, l) => notifyCalls.push({ m, l }), setStatus: () => {} },
	};
	writeFileSync(`${optin}/.pi/extensions/pi-codegraph/config.json`, JSON.stringify({ extraTools: ["node", "impact", "bogus"] }));
	await handlers.get("session_start")({ reason: "start" }, notifyCtx);
	for (const name of ["codegraph_node", "codegraph_impact"]) {
		if (!tools.has(name)) fail(`配置后工具未注册：${name}`);
	}
	if (tools.has("codegraph_query")) fail("未配置的 codegraph_query 必须保持未注册");
	const hint2 = lastHint(sent);
	if (!hint2.includes("`codegraph_node` —") || !hint2.includes("`codegraph_impact` —")) {
		fail("提示必须宣传已开启的工具");
	}
	if (hint2.includes("`codegraph_callers` —")) fail("提示不得宣传未开启的工具");
	if (hint2.includes("默认隐藏")) fail("有工具开启时提示不得再说默认隐藏");
	if (!notifyCalls.some((n) => n.m.includes("bogus"))) fail("未知工具名应弹出警告");
	// 新注册的工具在 pi 中默认即为活动；setActiveTools 只在需要剔除已注册
	// 工具时才会被调用（见步骤 4）。
	// 3. "all" 开启全部细粒度工具。
	writeFileSync(`${optin}/.pi/extensions/pi-codegraph/config.json`, JSON.stringify({ extraTools: "all" }));
	await handlers.get("session_start")({ reason: "start" }, uiCtx(optin));
	for (const name of ["codegraph_query", "codegraph_node", "codegraph_callers", "codegraph_callees", "codegraph_impact", "codegraph_files"]) {
		if (!tools.has(name)) fail(`extraTools=all 时工具未注册：${name}`);
	}
	console.log("Opt-in: config-driven registration OK");

	// 4. 移除配置 → 工具仍注册（无注销 API），但活动集必须剔除它们，
	//    使其离开系统提示。
	rmSync(`${optin}/.pi/extensions/pi-codegraph/config.json`, { force: true });
	await handlers.get("session_start")({ reason: "start" }, uiCtx(optin));
	const lastActive2 = activeCalls[activeCalls.length - 1];
	if (lastActive2.some((n) => n.startsWith("codegraph_") && n !== "codegraph_explore")) {
		fail(`细粒度工具应从活动集剔除，实际为：${lastActive2}`);
	}
	if (!lastActive2.includes("codegraph_explore")) fail("explore 必须保持活动");
	if (!lastHint(sent).includes("默认隐藏")) fail("关闭后提示必须恢复默认隐藏说明");
	// 5. 同一项目重新开启：工具仍在注册表中，活动集对齐应把重新开启的
	//    工具加回去。
	writeFileSync(`${optin}/.pi/extensions/pi-codegraph/config.json`, JSON.stringify({ extraTools: ["node"] }));
	await handlers.get("session_start")({ reason: "start" }, uiCtx(optin));
	const lastActive3 = activeCalls[activeCalls.length - 1];
	if (!lastActive3.includes("codegraph_explore") || !lastActive3.includes("codegraph_node")) {
		fail(`explore+node 应回到活动集，实际为：${lastActive3}`);
	}
	if (lastActive3.includes("codegraph_query")) fail("query 必须留在活动集之外");
	// 6. 全局配置（fake agent 目录下的 extensions/pi-codegraph/config.json）。
	writeFileSync(`${fakeGlobalDir}/extensions/pi-codegraph/config.json`, JSON.stringify({ extraTools: ["files"] }));
	await handlers.get("session_start")({ reason: "start" }, uiCtx(optin));
	if (!tools.has("codegraph_files")) fail("全局配置应注册 codegraph_files");
	console.log("Opt-in: re-enable / global config OK");

	process.env.PI_CODING_AGENT_DIR = prevAgentDir;

	// ── session_start / session_shutdown：状态栏流转 ─────────────────────
	const onShutdown = handlers.get("session_shutdown") ?? fail("session_shutdown 未注册");

	let currentStatus = null;
	const mockCtx = (cwd) => ({
		cwd,
		hasUI: true,
		isProjectTrusted: () => true,
		ui: {
			notify: () => {},
			setStatus: (_id, text) => { currentStatus = text; },
		},
	});

	const tmpTestDir = ".smoke-tmp";
	rmSync(tmpTestDir, { recursive: true, force: true });
	mkdirSync(tmpTestDir, { recursive: true });

	// 1. 未索引目录：无状态
	await handlers.get("session_start")({ reason: "start" }, mockCtx(tmpTestDir));
	if (currentStatus !== undefined) fail(`空目录应无状态，实际为：${currentStatus}`);

	// 2. 只有 .codegraph/ 目录但没有 codegraph.db（如仅有 .gitignore）：无状态
	mkdirSync(`${tmpTestDir}/.codegraph`, { recursive: true });
	writeFileSync(`${tmpTestDir}/.codegraph/.gitignore`, "*\n!.gitignore\n");
	await handlers.get("session_start")({ reason: "start" }, mockCtx(tmpTestDir));
	if (currentStatus !== undefined) fail(`仅有 .gitignore 的目录应无状态，实际为：${currentStatus}`);

	// 3. 有 .codegraph/codegraph.db：应设置状态
	writeFileSync(`${tmpTestDir}/.codegraph/codegraph.db`, "dummy-db");
	await handlers.get("session_start")({ reason: "start" }, mockCtx(tmpTestDir));
	// session_start 启动后台同步时立即设置 "sync"
	if (!currentStatus?.includes("sync") && !currentStatus?.includes("index")) {
		fail(`应显示 sync 或 index 状态，实际为：${currentStatus}`);
	}

	// 4. 测试 codegraph-sync 的状态流转
	const statusHistory = [];
	const trackingCtx = {
		cwd: tmpTestDir,
		hasUI: true,
		isProjectTrusted: () => true,
		ui: {
			notify: () => {},
			setStatus: (_id, text) => {
				statusHistory.push(text);
				currentStatus = text;
			},
		},
	};
	await commands.get("codegraph-sync").handler("", trackingCtx);
	if (!statusHistory.some((s) => s?.includes("sync"))) {
		fail(`codegraph-sync 应出现 sync 状态，历史：${JSON.stringify(statusHistory)}`);
	}
	if (!statusHistory[statusHistory.length - 1]?.includes("index")) {
		fail(`codegraph-sync 结束后应为 index 状态，实际为：${statusHistory[statusHistory.length - 1]}`);
	}

	await onShutdown({}, mockCtx(tmpTestDir));
	if (currentStatus !== undefined) fail(`shutdown 应清除状态，实际为：${currentStatus}`);

	rmSync(tmpTestDir, { recursive: true, force: true });
	rmSync(optin, { recursive: true, force: true });
	rmSync(fakeGlobalDir, { recursive: true, force: true });
	console.log("session_start & session_shutdown OK");
}

rmSync(".smoke-build", { recursive: true, force: true });
console.log("SMOKE PASS");