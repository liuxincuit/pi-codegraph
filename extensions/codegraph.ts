// pi-codegraph — pi extension
//
// CodeGraph support for pi: codegraph_explore tool, /codegraph-init,
// /codegraph-sync, /codegraph-status, and /codegraph-unlock commands.
//
// Bridges to CodeGraph by executing the CLI (see docs/adr/0001). Requires the
// codegraph CLI on PATH: npm i -g @colbymchenry/codegraph
// Upstream: https://github.com/colbymchenry/codegraph

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const INSTALL_HINT =
	"codegraph CLI not found on PATH. Install: npm i -g @colbymchenry/codegraph";

// Result of `codegraph version` this session — null until first check.
let cliAvailable: boolean | null = null;
let notifiedMissing = false;

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
		await fs.access(path.join(cwd, ".codegraph"));
		return true;
	} catch {
		return false;
	}
}

function updateStatusBar(ctx: ExtensionContext, indexed: boolean) {
	if (!ctx.hasUI) return;
	if (indexed) {
		const text = ctx.ui.theme?.fg
			? `${ctx.ui.theme.fg("accent", "⬡")} index`
			: "⬡ index";
		ctx.ui.setStatus("codegraph", text);
	} else {
		ctx.ui.setStatus("codegraph", undefined);
	}
}

// Modeled on upstream's MCP SERVER_INSTRUCTIONS (src/mcp/server-instructions.ts):
// lead the agent to codegraph_explore BEFORE grep/read, plus anti-patterns and staleness handling.
const INDEX_HINT = `# CodeGraph — this project is indexed

A \`.codegraph/\` index exists here: SQLite knowledge graph of every symbol, edge, and file (30+ languages). ONE \`codegraph_explore\` call returns the relevant symbols' verbatim line-numbered source (treat it as already Read — safe to Edit from) PLUS call paths between them and a blast-radius summary of what depends on them.

- For structural questions (how does X work / where is X / who calls Y / what breaks if I change Z), call \`codegraph_explore\` INSTEAD of grep + read — usually ONE call answers the whole question.
- Call it BEFORE and WHILE writing or editing code: it puts the blast radius in view before you touch a symbol you can name.
- Flow tracing: name endpoint symbols (e.g. \`mutateElement renderScene\`) to surface the path across dynamic-dispatch hops.
- Anti-patterns: don't grep or Read first; don't re-verify codegraph output with grep (AST-derived, more accurate than grep); don't reconstruct a flow by hand.
- "Already sent earlier in this conversation": pointer means content is already in context — do not re-fetch or Read.
- Staleness: if tool output contains "⚠️ Some files referenced below were edited since the last index sync", read only those flagged files directly.
- Multi-project / Monorepo: pass \`path\` to query any indexed sub-project directory.
- If a project has no \`.codegraph/\`, use built-in tools there; indexing is the user's decision — suggest /codegraph-init if it comes up.`;

export default function codegraphExtension(pi: ExtensionAPI) {
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
			const result = await execCg(pi, ["init", target], { timeout: 1_800_000 });
			const out = outputOf(result);
			const success = result.code === 0;
			if (ctx.hasUI) {
				ctx.ui.notify(
					success ? "CodeGraph index built." : `codegraph init failed (exit ${result.code})`,
					success ? "info" : "error",
				);
			}
			updateStatusBar(ctx, success || (await isIndexed(ctx.cwd)));
			pi.sendMessage(
				{ customType: "codegraph-init", content: out, display: true },
				{ triggerTurn: false },
			);
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
			const result = await execCg(pi, ["sync", target], { timeout: 300_000 });
			const out = outputOf(result);
			if (ctx.hasUI) {
				ctx.ui.notify(out, result.code === 0 ? "info" : "warning");
			}
			updateStatusBar(ctx, await isIndexed(ctx.cwd));
			pi.sendMessage(
				{ customType: "codegraph-sync", content: out, display: true },
				{ triggerTurn: false },
			);
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
			updateStatusBar(ctx, result.code === 0);
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

	// ── session_start: CLI check + incremental sync + context hint ────────
	pi.on("session_start", async (event, ctx) => {
		if (!(await ensureCli(pi))) {
			if (ctx.hasUI && !notifiedMissing) {
				notifiedMissing = true;
				ctx.ui.notify(INSTALL_HINT, "warning");
			}
			return;
		}

		const indexed = await isIndexed(ctx.cwd);
		updateStatusBar(ctx, indexed);

		// Incremental sync; near-zero cost when nothing changed. Exits quietly
		// when the project has no index — indexing stays the user's decision
		// (docs/adr/0002).
		void execCg(pi, ["sync", "-q", ctx.cwd], { timeout: 300_000 }).catch(() => {});

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
