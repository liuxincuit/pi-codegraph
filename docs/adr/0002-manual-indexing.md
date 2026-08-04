# Manual indexing; the agent never runs `codegraph init`

When a project has no `.codegraph/` index, the extension does **not** build one automatically — not even on the first `codegraph_explore` call. It passes through CodeGraph's own "not initialized" guidance and points the user at `/codegraph-init`.

Auto-init was considered (it would make the tool work out of the box) and rejected. CodeGraph upstream treats "indexing is the user's decision" as a design principle, stated verbatim in the CLI's not-initialized error, in the MCP server instructions, and in the installer comments: an agent that indexes on its own can build surprise indexes in directories that were never meant to be project roots (the classic case being a shell sitting in `$HOME`). The extension follows the same rule rather than carving out an exception.

Consequence: first use in a fresh project requires one explicit user action (`/codegraph-init`). This is deliberate friction, not a gap.
