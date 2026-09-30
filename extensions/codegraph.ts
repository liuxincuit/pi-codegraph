// pi-codegraph — pi extension
//
// CodeGraph support for pi: codegraph_explore tool, /codegraph-init,
// /codegraph-sync, /codegraph-status, and /codegraph-unlock commands.
//
// Bridges to CodeGraph by executing the CLI (see docs/adr/0001). Requires the
// codegraph CLI on PATH: npm i -g @colbymchenry/codegraph
// Upstream: https://github.com/colbymchenry/codegraph

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { TSchema, Type } from "typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL_HINT =
	"未检测到 codegraph CLI（PATH 中无 codegraph 命令），本插件未注入任何工具、命令或技能。" +
	"安装：npm i -g @colbymchenry/codegraph，然后 /reload 或重启 pi 生效。";

// Whole-process dedup for the missing-CLI hint: extensions re-run per session and
// per subagent (separate jiti module copies), so gate on globalThis.
const MISSING_CLI_HINTED = Symbol.for("pi-codegraph.missing-cli-hinted");

// Result of `codegraph version` this session — null until first check.
let cliAvailable: boolean | null = null;

async function execCg(
	pi: ExtensionAPI,
	args: string[],
	options: { signal?: AbortSignal; timeout?: number; cwd?: string } = {},
) {
	if (process.platform === "win32") {
		return await pi.exec("cmd.exe", ["/d", "/s", "/c", "codegraph", ...args], options);
	}
	return await pi.exec("codegraph", args, options);
}

async function ensureCli(pi: ExtensionAPI): Promise<boolean> {
	if (cliAvailable !== null) return cliAvailable;
	try {
		const result = await execCg(pi, ["version"], { timeout: 10_000 });
		cliAvailable = result.code === 0;
	} catch {
		cliAvailable = false;
	}
	return cliAvailable;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function outputOf(result: { stdout: string; stderr: string; code: number }): string {
	return (result.stdout + result.stderr).trim() || `exit ${result.code}`;
}

async function isIndexed(cwd: string): Promise<boolean> {
	try {
		await fs.access(path.join(cwd, ".codegraph", "codegraph.db"));
		return true;
	} catch {
		return false;
	}
}

// ── 路径发现（docs/adr/0004）──────────────────────────────────────────
// 工具的输入里带路径时，向上查找最近的已建索引目录；找到即向模型注入提示。

// 只认工具输入里的路径参数：内置 read/edit/write/ls/grep/find 与 codegraph 工具都用
// `path`，codegraph_files 另有 `dir`。bash 没有路径参数，不解析命令字符串。
function inputPathOf(input: Record<string, unknown>): string | undefined {
	for (const key of ["path", "dir"]) {
		const value = input[key];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return undefined;
}

// 向上最多查这么多层，避免在无关路径上走出长链。
const INDEX_WALK_LIMIT = 10;

/**
 * 从目标路径（文件或目录）向上找最近的已建索引目录，找不到返回 null。
 * 判据与状态栏一致（`.codegraph/codegraph.db` 存在）；缓存以目录为键，
 * 途中命中缓存即提前结束，负结果也写回缓存。
 */
async function findIndexRoot(
	target: string,
	cwd: string,
	cache: Map<string, string | null>,
): Promise<string | null> {
	let dir = path.resolve(cwd, target);
	try {
		if (!(await fs.stat(dir)).isDirectory()) dir = path.dirname(dir);
	} catch {
		// 不存在的路径（如 read 失败）按父目录继续。
		dir = path.dirname(dir);
	}

	const visited: string[] = [];
	for (let depth = 0; depth < INDEX_WALK_LIMIT; depth++) {
		const known = cache.get(dir);
		if (known !== undefined) {
			for (const seen of visited) cache.set(seen, known);
			return known;
		}
		visited.push(dir);
		if (await isIndexed(dir)) {
			for (const seen of visited) cache.set(seen, dir);
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	for (const seen of visited) cache.set(seen, null);
	return null;
}

/** 发现提示：只描述当下确实可用的工具，避免宣传调不到的工具（docs/adr/0003）。 */
function discoveryReminder(root: string, activated: boolean): string {
	const lines = [
		"<system-reminder>",
		`发现 CodeGraph 索引：${root}（该目录含 \`.codegraph/\`）`,
		`对它的结构性问题（X 如何工作 / X 在哪里 / 谁调用 Y / 修改 Z 会破坏什么）用 ` +
			`\`codegraph_explore(query="…", path=${JSON.stringify(root)})\`，优先于 grep + read。`,
	];
	if (activated) lines.push("codegraph 工具已在本次发现中启用，现在即可调用。");
	lines.push("</system-reminder>");
	return `\n${lines.join("\n")}\n`;
}

type StatusState = "index" | "sync" | "init" | boolean | undefined;

function updateStatusBar(ctx: ExtensionContext, state: StatusState) {
	if (!ctx.hasUI) return;
	const label = state === true ? "index" : state === false ? undefined : state;
	if (label) {
		const text = ctx.ui.theme?.fg
			? `${ctx.ui.theme.fg("accent", "⬡")} ${label}`
			: `⬡ ${label}`;
		ctx.ui.setStatus("codegraph", text);
	} else {
		ctx.ui.setStatus("codegraph", undefined);
	}
}

// 仿照上游 MCP SERVER_INSTRUCTIONS（src/mcp/server-instructions.ts）编写：引导智能体
// 在 grep/read 之前优先使用 codegraph 工具，并给出反模式与过期处理。提示内容按实际
// 启用的工具集生成：未开启的工具绝不被宣传（见 docs/adr/0003），避免智能体调用
// 不存在的工具。
const EXPLORE_HINT_LINE =
	"`codegraph_explore` — 一次调用完成广泛探索：相关符号的源码 + 调用路径。" +
	"可以点名端点符号（如 `mutateElement renderScene`）以跨越动态分派跳转揭示调用路径。";

const EXTRA_TOOL_HINT_LINES: Record<string, string> = {
	codegraph_query: "`codegraph_query` — 定位符号：位置 + 签名，不含源码。",
	codegraph_node:
		"`codegraph_node` — 单个符号的源码 + 调用/被调轨迹（可链式追踪调用图）。",
	codegraph_callers: "`codegraph_callers` — 谁调用了某符号。",
	codegraph_callees: "`codegraph_callees` — 某符号调用了什么。",
	codegraph_impact: "`codegraph_impact` — 修改某符号的影响范围（编辑前调用）。",
	codegraph_files: "`codegraph_files` — 已建索引的文件树（tree/flat/grouped 按语言分组）。",
};

const HIDDEN_TOOLS_NOTE =
	"细粒度工具（`codegraph_query` `codegraph_node` `codegraph_callers` `codegraph_callees` " +
	"`codegraph_impact` `codegraph_files`）默认隐藏以保持工具列表精简，只有用户通过配置开启后才会注册" +
	"（全局 `~/.pi/agent/extensions/pi-codegraph/config.json` 或项目 `.pi/extensions/pi-codegraph/config.json` 的 " +
	"`extraTools`）——当前会话请勿调用它们。";

function buildIndexHint(enabled: Set<string>): string {
	const lines = [
		"# CodeGraph — 本项目已建立索引",
		"",
		"这里存在 `.codegraph/` 索引：项目每个符号、边、文件构成的 SQLite 知识图谱（支持 30+ 语言）。" +
			"它可以回答结构性问题，并给出逐字、带行号的源码（把 codegraph 输出视为已经 Read 过的内容，可直接据此编辑）。",
		"",
		"- 对于结构性问题（X 如何工作 / X 在哪里 / 谁调用 Y / 修改 Z 会破坏什么），应使用 codegraph 工具" +
			"而不是 grep + read——通常一次调用即可完整回答。",
		`- ${EXPLORE_HINT_LINE}`,
	];
	for (const name of Object.keys(EXTRA_TOOL_HINT_LINES)) {
		if (enabled.has(name)) lines.push(`- ${EXTRA_TOOL_HINT_LINES[name]}`);
	}
	lines.push(
		"- 反模式：不要先用 grep 或 Read；不要用 grep 重复验证 codegraph 输出（基于 AST，比 grep 更准确）；不要手工重建调用流程。",
		'- "Already sent earlier in this conversation"：该提示表示内容已在会话上下文中——不要重新获取或 Read。',
		'- 过期提示：如果工具输出包含 "⚠️ Some files referenced below were edited since the last index sync"，只直接读取其中被标记的文件。',
		"- 多项目 / Monorepo：传入 `path` 查询任意已建索引的子项目目录。",
		"- 项目没有 `.codegraph/` 时，在该项目使用内置工具；是否建索引由用户决定——必要时建议 /codegraph-init。",
		extraToolsNote(enabled),
	);
	return lines.join("\n");
}

function extraToolsNote(enabled: Set<string>): string {
	return enabled.size === 0
		? `- ${HIDDEN_TOOLS_NOTE}`
		: "- 以上细粒度工具已通过 `extraTools` 配置开启。";
}

// 工具被配置强制声明、但工作目录没有索引时的提示（`inject: "always"`）。同样按实际
// 可用的工具集生成：绝不宣传调不到的工具（docs/adr/0003）。
function buildUnindexedHint(enabled: Set<string>): string {
	return [
		"# CodeGraph — 本工作目录未建索引",
		"",
		"当前工作目录没有 `.codegraph/` 索引，不要对它调用 codegraph 工具——改用内置工具。" +
			"本会话的 codegraph 工具已经可用：对任何存在 `.codegraph/` 的目录，传入 `path` 参数查询" +
			'（例如 `codegraph_explore(query="…", path="/b")`），monorepo 里尤其有用。',
		"- 给当前项目建索引由用户决定——不要自行运行 `codegraph init`，必要时建议 /codegraph-init。",
		extraToolsNote(enabled),
	].join("\n");
}

// ── 配置：细粒度工具 opt-in（docs/adr/0003）───────────────────────────
// 全局配置在 ~/.pi/agent/extensions/pi-codegraph/config.json，项目配置在
// .pi/extensions/pi-codegraph/config.json（覆盖全局，仅对受信任项目生效）。
// 结构为扁平 JSON：{ "extraTools": ["node", "impact"], "inject": "always" }。
// pi 没有第三方扩展配置 API，故由扩展自行读取这两个文件。
// `inject` 控制工具可用性（docs/adr/0004）："auto"（默认）只在工作目录已建索引、
// 或本会话探索发现索引目录时声明工具；"always" 无条件声明。
type CgConfig = { extraTools?: string[] | "all"; inject?: "auto" | "always" };

const CONFIG_REL_PATH = path.join("extensions", "pi-codegraph", "config.json");

async function readConfigFile<T>(file: string): Promise<T | undefined> {
	try {
		const raw = await fs.readFile(file, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

async function loadCgConfig(ctx: ExtensionContext): Promise<CgConfig> {
	const global = await readConfigFile<CgConfig>(path.join(getAgentDir(), CONFIG_REL_PATH));
	let project: CgConfig | undefined;
	if (ctx.isProjectTrusted()) {
		project = await readConfigFile<CgConfig>(path.join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_REL_PATH));
	}
	return { ...(global ?? {}), ...(project ?? {}) };
}

// When the CLI is absent, register nothing but a one-shot hint handler: no
// tools, no commands, no resources_discover (so no skill injection), no sync.
export function registerMissingCliHint(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if ((globalThis as Record<symbol, boolean>)[MISSING_CLI_HINTED]) return;
		(globalThis as Record<symbol, boolean>)[MISSING_CLI_HINTED] = true;
		if (ctx.hasUI) ctx.ui.notify(INSTALL_HINT, "warning");
	});
}

export default async function codegraphExtension(pi: ExtensionAPI) {
	if (!(await ensureCli(pi))) {
		registerMissingCliHint(pi);
		return;
	}
	// ── codegraph_explore tool ─────────────────────────────────────────────
	pi.registerTool({
		name: "codegraph_explore",
		label: "CodeGraph Explore",
		description:
			"Broad code exploration in one shot: relevant symbols' verbatim line-numbered source, call paths between them, and a blast-radius summary.",
		promptSnippet:
			"codegraph_explore: symbol source + call paths in one shot from the project's CodeGraph index",
		promptGuidelines: [
			"For structural code questions (how does X work, where is X, what breaks if I change X), prefer codegraph_explore over grep when the project has a .codegraph/ index.",
			"Indexing is the user's decision — never run codegraph init yourself; suggest /codegraph-init instead.",
		],
		// 注册 ≠ 声明给模型：活动集由 setToolsEnabled() 按 gate 决定（docs/adr/0004）。
		defaultActive: false,
		parameters: Type.Object({
			query: Type.String({
				description: "Symbol names or a natural-language question about the code",
			}),
			path: Type.Optional(
				Type.String({
					description: "Project path (default: cwd)",
				}),
			),
			maxFiles: Type.Optional(
				Type.Integer({
					description: "Maximum number of files to include source from",
				}),
			),
		}),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			if (!(await ensureCli(pi))) return textResult(INSTALL_HINT);
			const cwd = params.path ?? ctx.cwd;
			const args = ["explore", params.query, "-p", cwd];
			if (typeof params.maxFiles === "number" && params.maxFiles > 0) {
				args.push("--max-files", String(params.maxFiles));
			}
			const result = await execCg(pi, args, {
				signal,
				timeout: 120_000,
			});
			if (result.killed) return textResult("codegraph explore timed out (120s)");
			// Non-zero exits carry upstream's agent-friendly guidance (e.g. the
			// "not initialized" message) — pass it through verbatim.
			if (result.code !== 0) return textResult(outputOf(result));
			return textResult(result.stdout.trim());
		},
	});

	// ── codegraph_* fine-grained tools (CLI parity with the MCP tools) ────
	// Each maps 1:1 to a codegraph CLI subcommand; `path` selects the project,
	// defaults to the session cwd (same convention as codegraph_explore).
	const projectPath = () =>
		Type.Optional(
			Type.String({
				description: "Project path (default: cwd)",
			}),
		);

	type CliToolDef = {
		name: string;
		label: string;
		description: string;
		snippet: string;
		guidelines: string[];
		subcommand: string;
		parameters: TSchema;
		positional?: (p: Record<string, unknown>) => string[];
		flags?: (p: Record<string, unknown>) => string[];
		timeout?: number;
	};

	function registerCliTool(pi: ExtensionAPI, def: CliToolDef) {
		pi.registerTool({
			name: def.name,
			label: def.label,
			description: def.description,
			promptSnippet: def.snippet,
			promptGuidelines: def.guidelines,
			defaultActive: false,
			parameters: def.parameters,
			execute: async (_toolCallId, params: Record<string, unknown>, signal, _onUpdate, ctx) => {
				const cwd = (params.path as string | undefined) ?? ctx.cwd;
				const args = [
					def.subcommand,
					...(def.positional?.(params) ?? []),
					"-p",
					cwd,
					...(def.flags?.(params) ?? []),
				];
				const result = await execCg(pi, args, {
					signal,
					timeout: def.timeout ?? 60_000,
				});
				if (result.killed) return textResult(`codegraph ${def.subcommand} timed out`);
				// Non-zero exits carry upstream's agent-friendly guidance — pass it through.
				if (result.code !== 0) return textResult(outputOf(result));
				return textResult(result.stdout.trim());
			},
		});
	}

	const cliTools: CliToolDef[] = [
		{
			name: "codegraph_query",
			label: "CodeGraph Query",
			description:
				"Search symbols by name. Returns locations and signatures only (no source). Use to locate where a symbol is declared.",
			snippet: "codegraph_query: symbol locations + signatures by name",
			guidelines: [
				"To locate where a symbol is declared (kind, file, line), use codegraph_query before grep.",
			],
			subcommand: "query",
			parameters: Type.Object({
				search: Type.String({ description: "Symbol name or partial name to search" }),
				kind: Type.Optional(
					Type.String({
						description:
							"Filter by node kind: function, method, class, interface, type, variable, route, component",
					}),
				),
				limit: Type.Optional(Type.Integer({ description: "Maximum results (default 10)" })),
				path: projectPath(),
			}),
			positional: (p) => [p.search as string],
			flags: (p) => [
				...(p.kind ? ["--kind", p.kind as string] : []),
				...(typeof p.limit === "number" && p.limit > 0 ? ["--limit", String(p.limit)] : []),
			],
		},
		{
			name: "codegraph_node",
			label: "CodeGraph Node",
			description:
				"One symbol's source plus its caller/callee trail. Chain it to follow a call graph across files.",
			snippet: "codegraph_node: a symbol's source + caller/callee trail",
			guidelines: [
				"To deep-dive one known symbol (verbatim source + who it calls / is called by), use codegraph_node.",
			],
			subcommand: "node",
			parameters: Type.Object({
				name: Type.String({ description: "Symbol name to inspect" }),
				path: projectPath(),
			}),
			positional: (p) => [p.name as string],
		},
		{
			name: "codegraph_callers",
			label: "CodeGraph Callers",
			description: "Find all functions or methods that call a specific symbol.",
			snippet: "codegraph_callers: who calls a symbol",
			guidelines: [
				"To find what calls a symbol (reverse dependencies), use codegraph_callers.",
			],
			subcommand: "callers",
			parameters: Type.Object({
				symbol: Type.String({ description: "Symbol name whose callers to find" }),
				limit: Type.Optional(Type.Integer({ description: "Maximum results (default 20)" })),
				path: projectPath(),
			}),
			positional: (p) => [p.symbol as string],
			flags: (p) => [
				...(typeof p.limit === "number" && p.limit > 0 ? ["--limit", String(p.limit)] : []),
			],
		},
		{
			name: "codegraph_callees",
			label: "CodeGraph Callees",
			description: "Find all functions or methods that a specific symbol calls.",
			snippet: "codegraph_callees: what a symbol calls",
			guidelines: [
				"To find what a symbol calls (its outgoing edges), use codegraph_callees.",
			],
			subcommand: "callees",
			parameters: Type.Object({
				symbol: Type.String({ description: "Symbol name whose callees to find" }),
				limit: Type.Optional(Type.Integer({ description: "Maximum results (default 20)" })),
				path: projectPath(),
			}),
			positional: (p) => [p.symbol as string],
			flags: (p) => [
				...(typeof p.limit === "number" && p.limit > 0 ? ["--limit", String(p.limit)] : []),
			],
		},
		{
			name: "codegraph_impact",
			label: "CodeGraph Impact",
			description: "Analyze what code is affected by changing a symbol (blast radius).",
			snippet: "codegraph_impact: blast radius of changing a symbol",
			guidelines: [
				"Before editing a symbol, use codegraph_impact to see what depends on it.",
			],
			subcommand: "impact",
			parameters: Type.Object({
				symbol: Type.String({ description: "Symbol name to analyze impact of changing" }),
				depth: Type.Optional(Type.Integer({ description: "Traversal depth (default 2)" })),
				path: projectPath(),
			}),
			positional: (p) => [p.symbol as string],
			flags: (p) => [
				...(typeof p.depth === "number" && p.depth > 0 ? ["--depth", String(p.depth)] : []),
			],
		},
		{
			name: "codegraph_files",
			label: "CodeGraph Files",
			description:
				"Show the indexed project's file structure (tree, flat, or grouped by language), with per-file symbol counts.",
			snippet: "codegraph_files: indexed file tree with symbol counts",
			guidelines: [
				"To get a structured view of the project files, use codegraph_files.",
			],
			subcommand: "files",
			parameters: Type.Object({
				dir: Type.Optional(Type.String({ description: "Subdirectory within the project to show" })),
				pattern: Type.Optional(Type.String({ description: "Glob pattern to filter files" })),
				format: Type.Optional(
					Type.Union([Type.Literal("tree"), Type.Literal("flat"), Type.Literal("grouped")]),
				),
				maxDepth: Type.Optional(Type.Integer({ description: "Maximum directory depth for tree format" })),
				path: projectPath(),
			}),
			positional: (p) => (p.dir ? [p.dir as string] : []),
			flags: (p) => [
				...(p.pattern ? ["--pattern", p.pattern as string] : []),
				...(p.format ? ["--format", p.format as string] : []),
				...(typeof p.maxDepth === "number" && p.maxDepth > 0
					? ["--max-depth", String(p.maxDepth)]
					: []),
			],
		},
	];

	// 细粒度工具为 opt-in：仅当配置开启时才注册，保证注册表精简（见 docs/adr/0003）。
	// `registeredExtraTools` 防止同一进程内重复注册；`enabledExtraTools` 与
	// `toolsEnabled` 一起驱动活动集与注入的提示内容。
	const registeredExtraTools = new Set<string>();
	let enabledExtraTools = new Set<string>();

	// 本会话 codegraph 工具是否声明给模型（docs/adr/0004）：session_start 判定初始值，
	// 路径发现与 /codegraph-init 成功后可以把它从 false 翻到 true。
	let toolsEnabled = false;

	// 路径发现的会话级状态：已提示过的索引根、目录→索引根的查找缓存。
	const discoveredRoots = new Set<string>();
	const indexRootCache = new Map<string, string | null>();

	const extraToolKey = (def: CliToolDef) => def.name.replace(/^codegraph_/, "");

	function resolveExtraTools(cfg: CgConfig, ctx: ExtensionContext): Set<string> {
		const enabled = new Set<string>();
		const wanted = cfg.extraTools ?? [];
		const names = wanted === "all" ? cliTools.map((d) => d.name) : wanted;
		for (const item of names) {
			const key = typeof item === "string" ? item.trim() : "";
			const def = cliTools.find((d) => d.name === key || extraToolKey(d) === key);
			if (def) {
				enabled.add(def.name);
			} else if (key && ctx.hasUI) {
				ctx.ui.notify(`codegraph: unknown extra tool "${item}" (ignored)`, "warning");
			}
		}
		return enabled;
	}

	/**
	 * 按 gate 对齐活动集：explore 加配置开启的细粒度工具。
	 * 活动集每变一次 pi 都要重建系统提示，因此只在真的变化时调用 setActiveTools。
	 */
	function setToolsEnabled(enabled: boolean) {
		toolsEnabled = enabled;
		const wanted = new Set(["codegraph_explore", ...enabledExtraTools]);
		const active = new Set(pi.getActiveTools());
		let changed = false;
		for (const name of new Set(["codegraph_explore", ...registeredExtraTools])) {
			const want = enabled && wanted.has(name);
			if (want && !active.has(name)) {
				active.add(name);
				changed = true;
			} else if (!want && active.has(name)) {
				active.delete(name);
				changed = true;
			}
		}
		if (changed) pi.setActiveTools([...active]);
	}

	/** 注册配置开启的细粒度工具（注册与 gate 无关），然后按 gate 对齐活动集。 */
	function applyExtraTools(cfg: CgConfig, ctx: ExtensionContext, enabled: boolean) {
		enabledExtraTools = resolveExtraTools(cfg, ctx);
		for (const def of cliTools) {
			if (enabledExtraTools.has(def.name) && !registeredExtraTools.has(def.name)) {
				registerCliTool(pi, def);
				registeredExtraTools.add(def.name);
			}
		}
		setToolsEnabled(enabled);
	}

	/** 工作目录刚建好索引（/codegraph-init 成功）时，补上活动集与索引提示。 */
	async function enableIfIndexedNow(ctx: ExtensionContext) {
		if (toolsEnabled || !(await isIndexed(ctx.cwd))) return;
		const root = path.resolve(ctx.cwd);
		indexRootCache.set(root, root);
		setToolsEnabled(true);
		pi.sendMessage(
			{ customType: "codegraph-context", content: buildIndexHint(enabledExtraTools), display: false },
			{ triggerTurn: false },
		);
	}

	// ── /codegraph-init ────────────────────────────────────────────────────
	pi.registerCommand("codegraph-init", {
		description: "Build the CodeGraph index for the current project (codegraph init)",
		handler: async (args, ctx) => {
			if (!(await ensureCli(pi))) {
				if (ctx.hasUI) ctx.ui.notify(INSTALL_HINT, "error");
				return;
			}
			const target = args?.trim() || ctx.cwd;
			if (ctx.hasUI) {
				ctx.ui.notify(`Indexing ${target} — can take minutes on a large repo…`, "info");
			}
			updateStatusBar(ctx, "init");
			try {
				const result = await execCg(pi, ["init", target], { timeout: 1_800_000 });
				const out = outputOf(result);
				const success = result.code === 0;
				if (ctx.hasUI) {
					ctx.ui.notify(
						success ? "CodeGraph index built." : `codegraph init failed (exit ${result.code})`,
						success ? "info" : "error",
					);
				}
				pi.sendMessage(
					{ customType: "codegraph-init", content: out, display: true },
					{ triggerTurn: false },
				);
				if (success) await enableIfIndexedNow(ctx);
			} finally {
				updateStatusBar(ctx, await isIndexed(ctx.cwd));
			}
		},
	});

	// ── /codegraph-sync ────────────────────────────────────────────────────
	pi.registerCommand("codegraph-sync", {
		description: "Sync CodeGraph changes since last index (codegraph sync)",
		handler: async (args, ctx) => {
			if (!(await ensureCli(pi))) {
				if (ctx.hasUI) ctx.ui.notify(INSTALL_HINT, "error");
				return;
			}
			const target = args?.trim() || ctx.cwd;
			if (ctx.hasUI) {
				ctx.ui.notify(`Syncing CodeGraph for ${target}…`, "info");
			}
			updateStatusBar(ctx, "sync");
			try {
				const result = await execCg(pi, ["sync", target], { timeout: 300_000 });
				const out = outputOf(result);
				if (ctx.hasUI) {
					ctx.ui.notify(out, result.code === 0 ? "info" : "warning");
				}
				pi.sendMessage(
					{ customType: "codegraph-sync", content: out, display: true },
					{ triggerTurn: false },
				);
			} finally {
				updateStatusBar(ctx, await isIndexed(ctx.cwd));
			}
		},
	});

	// ── /codegraph-status ──────────────────────────────────────────────────
	pi.registerCommand("codegraph-status", {
		description: "Show CodeGraph index status and statistics",
		handler: async (args, ctx) => {
			if (!(await ensureCli(pi))) {
				if (ctx.hasUI) ctx.ui.notify(INSTALL_HINT, "error");
				return;
			}
			const target = args?.trim() || ctx.cwd;
			const result = await execCg(pi, ["status", target], { timeout: 30_000 });
			const out = outputOf(result);
			if (ctx.hasUI) ctx.ui.notify(out, result.code === 0 ? "info" : "warning");
			updateStatusBar(ctx, await isIndexed(ctx.cwd));
			pi.sendMessage(
				{ customType: "codegraph-status", content: out, display: true },
				{ triggerTurn: false },
			);
		},
	});

	// ── /codegraph-unlock ──────────────────────────────────────────────────
	pi.registerCommand("codegraph-unlock", {
		description: "Release stale CodeGraph database lock (codegraph unlock)",
		handler: async (args, ctx) => {
			if (!(await ensureCli(pi))) {
				if (ctx.hasUI) ctx.ui.notify(INSTALL_HINT, "error");
				return;
			}
			const target = args?.trim() || ctx.cwd;
			const result = await execCg(pi, ["unlock", target], { timeout: 10_000 });
			const out = outputOf(result);
			if (ctx.hasUI) ctx.ui.notify(out, result.code === 0 ? "info" : "warning");
			pi.sendMessage(
				{ customType: "codegraph-unlock", content: out, display: true },
				{ triggerTurn: false },
			);
		},
	});

	// ── resources_discover: contribute the skill only when the tools are usable ──
	pi.on("resources_discover", async (event, ctx) => {
		const cfg = await loadCgConfig(ctx);
		if (!(await isIndexed(event.cwd)) && cfg.inject !== "always") return undefined;
		return {
			skillPaths: [fileURLToPath(new URL("../skills/codegraph/SKILL.md", import.meta.url))],
		};
	});

	// ── session_start：gate 判定 + 增量同步 + 上下文提示 ────────────────
	pi.on("session_start", async (event, ctx) => {
		const cfg = await loadCgConfig(ctx);
		const indexed = await isIndexed(ctx.cwd);
		const root = path.resolve(ctx.cwd);

		// 发现状态按会话重置；cwd 自身的结果先写进缓存，让常见路径一次命中。
		discoveredRoots.clear();
		indexRootCache.clear();
		indexRootCache.set(root, indexed ? root : null);

		// gate：工作目录已建索引，或用户配置强制声明（docs/adr/0004）。
		applyExtraTools(cfg, ctx, indexed || cfg.inject === "always");

		if (indexed) {
			updateStatusBar(ctx, "sync");
			// Incremental sync; near-zero cost when nothing changed.
			void execCg(pi, ["sync", "-q", ctx.cwd], { timeout: 300_000 })
				.catch(() => {})
				.finally(async () => {
					updateStatusBar(ctx, await isIndexed(ctx.cwd));
				});
		} else {
			updateStatusBar(ctx, false);
		}

		// Inject the agent playbook when the tools are declared to the model.
		// Skip "reload": extensions rebind in place and the message would duplicate.
		if (event.reason !== "reload" && toolsEnabled) {
			pi.sendMessage(
				{
					customType: "codegraph-context",
					content: indexed ? buildIndexHint(enabledExtraTools) : buildUnindexedHint(enabledExtraTools),
					display: false,
				},
				{ triggerTurn: false },
			);
		}
	});

	// ── 路径发现：探索到其他已建索引目录时注入提示（docs/adr/0004）───────
	// CLI 不可用时本处理器根本不会注册，因此这里不再重复检查 CLI。
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return undefined;
		const target = inputPathOf(event.input);
		if (!target) return undefined;

		const root = await findIndexRoot(target, ctx.cwd, indexRootCache);
		if (!root || root === path.resolve(ctx.cwd) || discoveredRoots.has(root)) return undefined;
		discoveredRoots.add(root);

		// 工具尚未声明给模型时顺手启用：setActiveTools 在下一个 turn 生效，而模型正是
		// 在下一个 turn 才读到这条注入，两者对齐。
		const activated = !toolsEnabled;
		if (activated) setToolsEnabled(true);
		if (ctx.hasUI) ctx.ui.notify(`发现 CodeGraph 索引: ${root}`, "info");

		return {
			content: [
				...(event.content ?? []),
				{ type: "text" as const, text: discoveryReminder(root, activated) },
			],
			// pi 的契约：只替换 content 而不回传 structuredContent 会丢掉结构化输出。
			...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
			details: event.details,
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus("codegraph", undefined);
		}
	});
}
