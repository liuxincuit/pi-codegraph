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
		enabled.size === 0
			? `- ${HIDDEN_TOOLS_NOTE}`
			: "- 以上细粒度工具已通过 `extraTools` 配置开启。",
	);
	lines.push(
		"- 反模式：不要先用 grep 或 Read；不要用 grep 重复验证 codegraph 输出（基于 AST，比 grep 更准确）；不要手工重建调用流程。",
		'- "Already sent earlier in this conversation"：该提示表示内容已在会话上下文中——不要重新获取或 Read。',
		'- 过期提示：如果工具输出包含 "⚠️ Some files referenced below were edited since the last index sync"，只直接读取其中被标记的文件。',
		"- 多项目 / Monorepo：传入 `path` 查询任意已建索引的子项目目录。",
		"- 项目没有 `.codegraph/` 时，在该项目使用内置工具；是否建索引由用户决定——必要时建议 /codegraph-init。",
	);
	return lines.join("\n");
}

// ── 配置：细粒度工具 opt-in（docs/adr/0003）───────────────────────────
// 全局配置在 ~/.pi/agent/extensions/pi-codegraph/config.json，项目配置在
// .pi/extensions/pi-codegraph/config.json（覆盖全局，仅对受信任项目生效）。
// 结构为扁平 JSON：{ "extraTools": ["node", "impact"] }。pi 没有第三方
// 扩展配置 API，故由扩展自行读取这两个文件。
type CgConfig = { extraTools?: string[] | "all" };

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

	// 细粒度工具为 opt-in：仅当配置开启时才注册，保证默认工具列表精简（见
	// docs/adr/0003）。`registeredExtraTools` 防止同一进程内重复注册；
	// `enabledExtraTools` 同时驱动活动工具集与注入的提示内容。
	const registeredExtraTools = new Set<string>();
	let enabledExtraTools = new Set<string>();

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

	function applyExtraTools(pi: ExtensionAPI, cfg: CgConfig, ctx: ExtensionContext) {
		enabledExtraTools = resolveExtraTools(cfg, ctx);
		for (const def of cliTools) {
			if (enabledExtraTools.has(def.name) && !registeredExtraTools.has(def.name)) {
				registerCliTool(pi, def);
				registeredExtraTools.add(def.name);
			}
		}
		// 将活动工具集与配置对齐：此前已注册但当前未启用的工具（例如切换项目后）
		// 不得再出现在系统提示中。
		const active = new Set(pi.getActiveTools());
		const extraNames = new Set(cliTools.map((d) => d.name));
		let changed = false;
		for (const name of extraNames) {
			if (enabledExtraTools.has(name) && !active.has(name)) {
				active.add(name);
				changed = true;
			} else if (!enabledExtraTools.has(name) && active.has(name)) {
				active.delete(name);
				changed = true;
			}
		}
		if (changed) pi.setActiveTools([...active]);
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

	// ── resources_discover: contribute the skill only when the CLI exists ──
	pi.on("resources_discover", async () => {
		return {
			skillPaths: [fileURLToPath(new URL("../skills/codegraph/SKILL.md", import.meta.url))],
		};
	});

	// ── session_start：opt-in 工具 + 增量同步 + 上下文提示 ───────────────
	pi.on("session_start", async (event, ctx) => {
		const cfg = await loadCgConfig(ctx);
		applyExtraTools(pi, cfg, ctx);
		const indexed = await isIndexed(ctx.cwd);
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

		// Inject the agent playbook once per process when the project IS
		// indexed (upstream does this via MCP initialize instructions). Skip
		// "reload": extensions rebind in place and the message would duplicate.
		if (event.reason !== "reload" && indexed) {
			pi.sendMessage(
				{ customType: "codegraph-context", content: buildIndexHint(enabledExtraTools), display: false },
				{ triggerTurn: false },
			);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus("codegraph", undefined);
		}
	});
}
