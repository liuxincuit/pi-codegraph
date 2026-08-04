// pi-codegraph — pi extension
//
// CodeGraph support for pi: codegraph_explore tool, /codegraph-init and
// /codegraph-status commands, index sync on session start.
//
// Bridges to CodeGraph by executing the CLI (see docs/adr/0001). Requires the
// codegraph CLI on PATH: npm i -g @colbymchenry/codegraph
// Upstream: https://github.com/colbymchenry/codegraph

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const INSTALL_HINT =
	"codegraph CLI not found on PATH. Install: npm i -g @colbymchenry/codegraph";

// Result of `codegraph version` this session — null until first check.
let cliAvailable: boolean | null = null;
let notifiedMissing = false;

async function ensureCli(pi: ExtensionAPI): Promise<boolean> {
	if (cliAvailable !== null) return cliAvailable;
	try {
		const result = await pi.exec("codegraph", ["version"], { timeout: 10_000 });
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
		}),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			if (!(await ensureCli(pi))) return textResult(INSTALL_HINT);
			const cwd = params.path ?? ctx.cwd;
			const result = await pi.exec("codegraph", ["explore", params.query, "-p", cwd], {
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
		handler: async (_args, ctx) => {
			if (!(await ensureCli(pi))) {
				if (ctx.hasUI) ctx.ui.notify(INSTALL_HINT, "error");
				return;
			}
			if (ctx.hasUI) {
				ctx.ui.notify(`Indexing ${ctx.cwd} — can take minutes on a large repo…`, "info");
			}
			const result = await pi.exec("codegraph", ["init", ctx.cwd], { timeout: 1_800_000 });
			const out = outputOf(result);
			if (ctx.hasUI) {
				ctx.ui.notify(
					result.code === 0 ? "CodeGraph index built." : `codegraph init failed (exit ${result.code})`,
					result.code === 0 ? "info" : "error",
				);
			}
			pi.sendMessage(
				{ customType: "codegraph-init", content: out, display: true },
				{ triggerTurn: false },
			);
		},
	});

	// ── /codegraph-status ──────────────────────────────────────────────────
	pi.registerCommand("codegraph-status", {
		description: "Show CodeGraph index status and statistics",
		handler: async (_args, ctx) => {
			if (!(await ensureCli(pi))) {
				if (ctx.hasUI) ctx.ui.notify(INSTALL_HINT, "error");
				return;
			}
			const result = await pi.exec("codegraph", ["status", ctx.cwd], { timeout: 30_000 });
			const out = outputOf(result);
			if (ctx.hasUI) ctx.ui.notify(out, result.code === 0 ? "info" : "warning");
			pi.sendMessage(
				{ customType: "codegraph-status", content: out, display: true },
				{ triggerTurn: false },
			);
		},
	});

	// ── session_start: CLI check + incremental sync ────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		if (!(await ensureCli(pi))) {
			if (ctx.hasUI && !notifiedMissing) {
				notifiedMissing = true;
				ctx.ui.notify(INSTALL_HINT, "warning");
			}
			return;
		}
		// Incremental sync; near-zero cost when nothing changed. Exits quietly
		// when the project has no index — indexing stays the user's decision
		// (docs/adr/0002).
		void pi.exec("codegraph", ["sync", "-q", ctx.cwd], { timeout: 300_000 }).catch(() => {});
	});
}
