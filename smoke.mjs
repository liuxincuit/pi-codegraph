// 冒烟测试：对 mock pi 运行编译后的扩展。
// 两个场景：
//   1. codegraph CLI 缺失 → 扩展不得注入任何内容（无工具、无命令、
//      resources_discover），仅有一次性的安装提示。
//   2. codegraph CLI 存在（PATH 上的真实二进制）→ 完整功能：
//      默认仅注册 codegraph_explore；细粒度工具通过 extraTools 配置
//      opt-in（见 docs/adr/0003）。CLI 不可用时自动跳过。
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

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
	// 真实 pi 语义：只有 defaultActive !== false 的工具在注册时自动进入活动集。
	let activeTools = [];
	const activeCalls = [];
	return {
		pi: {
			exec: execFn,
			registerTool: (t) => {
				tools.set(t.name, t);
				if (t.defaultActive !== false) activeTools.push(t.name);
			},
			registerCommand: (n, c) => commands.set(n, c),
			on: (e, h) => handlers.set(e, h),
			sendMessage: (m) => sent.push(m),
			getActiveTools: () => [...activeTools],
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
	if (handlers.has("tool_result")) fail("CLI 缺失时不应注册路径发现处理器");
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
	// 新注册的工具在 pi 中默认未激活（defaultActive: false），由 setToolsEnabled()
	// 按 gate 加回活动集，因此此处不再断言 setActiveTools 的调用时机。
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

	// ── 路径发现 + inject 配置（docs/adr/0004）──────────────────────────
	{
		// 隔离全局配置目录，避免真实用户配置影响 gate 判定。
		const prevDir = process.env.PI_CODING_AGENT_DIR;
		const fakeAgent = path.resolve(".smoke-agent-empty");
		rmSync(fakeAgent, { recursive: true, force: true });
		process.env.PI_CODING_AGENT_DIR = fakeAgent;

		const discRoot = path.resolve(".smoke-disc");
		rmSync(discRoot, { recursive: true, force: true });
		const aDir = path.join(discRoot, "a");
		mkdirSync(aDir, { recursive: true });
		for (const name of ["b", "c"]) {
			mkdirSync(path.join(discRoot, name, ".codegraph"), { recursive: true });
			writeFileSync(path.join(discRoot, name, ".codegraph", "codegraph.db"), "dummy-db");
		}
		writeFileSync(path.join(discRoot, "b", "x.ts"), "export const x = 1;\n");

		const notifyCalls = [];
		const dctx = (cwd) => ({
			cwd,
			hasUI: true,
			isProjectTrusted: () => true,
			ui: {
				notify: (m, l) => notifyCalls.push({ m, l }),
				setStatus: () => {},
			},
		});
		const ev = (input, extra = {}) => ({
			type: "tool_result",
			toolCallId: "t1",
			input,
			content: [{ type: "text", text: "file body" }],
			isError: false,
			details: undefined,
			...extra,
		});

		// 1. 未索引、无配置：工具注册但不声明给模型，也不注入任何提示。
		const { pi: dpi, handlers: dh, sent: dsent, activeCalls: dActive } = makePi(exec);
		await loadExtension(dpi);
		await dh.get("session_start")({ reason: "start" }, dctx(aDir));
		if (dActive.length !== 0) fail(`未索引且无配置时不应改动活动集，实际：${JSON.stringify(dActive)}`);
		if (dsent.some((m) => m.customType === "codegraph-context")) {
			fail("未索引且无配置时不应注入 codegraph 提示");
		}

		// 2. 探索到 ../b → 注入发现提示 + 懒激活工具 + TUI 通知。
		const first = await dh.get("tool_result")(
			ev({ path: "../b/x.ts" }, { structuredContent: { ok: true } }),
			dctx(aDir),
		);
		const firstText = (first?.content ?? []).map((c) => c.text).join("\n");
		if (!firstText.includes("发现 CodeGraph 索引")) fail("发现索引目录时应注入提示");
		if (!firstText.includes(path.join(discRoot, "b"))) fail("发现提示应标明索引目录");
		if (!firstText.includes("file body")) fail("注入不得丢弃原始工具输出");
		if (first?.structuredContent?.ok !== true) {
			fail("注入必须回传 structuredContent，否则结构化输出会丢失");
		}
		if (notifyCalls.filter((n) => n.m.includes("发现 CodeGraph 索引")).length !== 1) {
			fail(`发现时应恰好一次 TUI 通知，实际：${JSON.stringify(notifyCalls)}`);
		}
		if (!(dActive.at(-1) ?? []).includes("codegraph_explore")) {
			fail(`发现索引目录后应启用 codegraph 工具，实际：${JSON.stringify(dActive.at(-1))}`);
		}

		// 3. 同一索引目录只提示一次。
		if ((await dh.get("tool_result")(ev({ path: "../b/x.ts" }), dctx(aDir))) !== undefined) {
			fail("同一索引目录不应重复注入");
		}
		if (notifyCalls.length !== 1) fail(`重复探索不应重复通知，实际 ${notifyCalls.length} 次`);

		// 4. 未命中索引的路径 / 出错的结果 / 无 path 参数的工具 → 不触发。
		if ((await dh.get("tool_result")(ev({ path: "x.ts" }), dctx(aDir))) !== undefined) {
			fail("cwd 内未索引的路径不应注入");
		}
		if ((await dh.get("tool_result")(ev({ path: "../c/y.ts" }, { isError: true }), dctx(aDir))) !== undefined) {
			fail("出错的工具结果不应触发发现");
		}
		if ((await dh.get("tool_result")(ev({ command: "ls ../b" }), dctx(aDir))) !== undefined) {
			fail("无路径参数的工具不应触发发现");
		}
		console.log("Discovery: lazy activation + one-shot injection OK");

		// 5. inject: "always" → 工作目录未建索引也声明工具，并注入未建索引版提示。
		const forcedDir = path.resolve(".smoke-force");
		rmSync(forcedDir, { recursive: true, force: true });
		mkdirSync(path.join(forcedDir, ".pi", "extensions", "pi-codegraph"), { recursive: true });
		writeFileSync(
			path.join(forcedDir, ".pi", "extensions", "pi-codegraph", "config.json"),
			JSON.stringify({ inject: "always" }),
		);
		const { pi: fpi, handlers: fh, sent: fsent, activeCalls: fActive } = makePi(exec);
		await loadExtension(fpi);
		await fh.get("session_start")({ reason: "start" }, dctx(forcedDir));
		if (!(fActive.at(-1) ?? []).includes("codegraph_explore")) {
			fail(`inject: always 时应声明 codegraph_explore，实际：${JSON.stringify(fActive.at(-1))}`);
		}
		const fHint = [...fsent].reverse().find((m) => m.customType === "codegraph-context")?.content ?? "";
		if (!fHint.includes("本工作目录未建索引")) fail(`inject: always 时应注入未建索引版提示：${fHint}`);
		console.log("Config inject: always OK");

		rmSync(discRoot, { recursive: true, force: true });
		rmSync(forcedDir, { recursive: true, force: true });
		rmSync(fakeAgent, { recursive: true, force: true });
		process.env.PI_CODING_AGENT_DIR = prevDir;
	}

	rmSync(tmpTestDir, { recursive: true, force: true });
	rmSync(optin, { recursive: true, force: true });
	rmSync(fakeGlobalDir, { recursive: true, force: true });
	console.log("session_start & session_shutdown OK");
}

rmSync(".smoke-build", { recursive: true, force: true });
console.log("SMOKE PASS");