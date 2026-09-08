// pi-codegraph — pi extension
//
// CodeGraph support for pi: codegraph_explore tool, /codegraph-init,
// /codegraph-sync, /codegraph-status, and /codegraph-unlock commands.
//
// Bridges to CodeGraph by executing the CLI (see docs/adr/0001). Requires the
// codegraph CLI on PATH: npm i -g @colbymchenry/codegraph
// Upstream: https://github.com/colbymchenry/codegraph

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

// Modeled on upstream's MCP SERVER_INSTRUCTIONS (src/mcp/server-instructions.ts):
// lead the agent to the codegraph_* tools BEFORE grep/read, plus anti-patterns and staleness handling.
const INDEX_HINT = `# CodeGraph — this project is indexed

A \`.codegraph/\` index exists here: SQLite knowledge graph of every symbol, edge, and file (30+ languages). It answers structural code questions with verbatim, line-numbered source (treat codegraph output as already Read — safe to Edit from).

- For structural questions (how does X work / where is X / who calls Y / what breaks if I change Z), use the codegraph_* tools INSTEAD of grep + read — usually ONE call answers the whole question.
- Choose the right tool:
  - \`codegraph_query\` — locate a symbol: locations + signatures only.
  - \`codegraph_node\` — one symbol's source + caller/callee trail (chain it to follow a call graph).
  - \`codegraph_callers\` — who calls a symbol. \`codegraph_callees\` — what a symbol calls.
  - \`codegraph_impact\` — blast radius of changing a symbol (call before editing).
  - \`codegraph_files\` — indexed file tree (tree/flat/grouped by language).
  - \`codegraph_explore\` — broad questions: relevant symbols' source + call paths in one shot. Name endpoint symbols (e.g. \`mutateElement renderScene\`) to surface paths across dynamic-dispatch hops.
- Anti-patterns: don't grep or Read first; don't re-verify codegraph output with grep (AST-derived, more accurate than grep); don't reconstruct a flow by hand.
- "Already sent earlier in this conversation": pointer means content is already in context — do not re-fetch or Read.
- Staleness: if tool output contains "⚠️ Some files referenced below were edited since the last index sync", read only those flagged files directly.
- Multi-project / Monorepo: pass \`path\` to query any indexed sub-project directory.
- If a project has no \`.codegraph/\`, use built-in tools there; indexing is the user's decision — suggest /codegraph-init if it comes up.`;

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
			"PRIMARY tool for code questions — call it BEFORE grep/read when the project has a .codegraph/ index. " +
			"One query returns the relevant symbols' verbatim line-numbered source plus the call paths between them and a blast-radius summary. " +
			"If the project is not indexed the output says so: continue with built-in tools and suggest the user run /codegraph-init.",
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
					description: "Project path to query; defaults to the current working directory",
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
				description: "Project path to query; defaults to the current working directory",
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

	for (const tool of cliTools) {
		registerCliTool(pi, tool);
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

	// ── session_start: incremental sync + context hint ────────────────────
	pi.on("session_start", async (event, ctx) => {
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
				{ customType: "codegraph-context", content: INDEX_HINT, display: false },
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
