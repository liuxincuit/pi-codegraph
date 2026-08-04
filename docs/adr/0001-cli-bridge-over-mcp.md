# Bridge to CodeGraph via the CLI, not MCP

The extension talks to CodeGraph by executing the `codegraph` CLI per tool call (`pi.exec`), even though CodeGraph's primary interface is an MCP server — and pi has no native MCP support.

The CLI has full parity with the MCP tools (`codegraph explore` produces the same output as the `codegraph_explore` MCP tool), so a stdio JSON-RPC client, process lifecycle management, and crash recovery would buy only per-call latency (~200–500ms of Node startup), which is irrelevant against LLM turn times. `pi.exec` is stateless: no daemon, no connection to leak, nothing to recover.

Consequence: without the MCP daemon's file watcher, the index does not auto-update. Mitigated by running `codegraph sync -q` on session start; results can still lag mid-session edits, which CodeGraph's own guidance already tolerates ("Index lags file writes").
