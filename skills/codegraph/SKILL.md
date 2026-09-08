---
name: codegraph
description: Query the project's CodeGraph index (symbol source, call paths, blast radius) via the codegraph_* tools. Use when answering structural code questions — how X works, where X is, who calls Y, what a change affects — in a project that has a .codegraph/ index.
---

# CodeGraph

The `codegraph_*` tools answer structural code questions from the project's CodeGraph index (`.codegraph/`), built and maintained by the `codegraph` CLI. Prefer them over grep/read for structural exploration **when the project has a `.codegraph/` index**.

## Picking a tool

- `codegraph_query` — locate a symbol: locations + signatures only. Start here when you don't know where something is declared.
- `codegraph_node` — one known symbol's verbatim source + caller/callee trail. Chain it to follow a call graph across files.
- `codegraph_callers` / `codegraph_callees` — who calls a symbol / what a symbol calls.
- `codegraph_impact` — blast radius of changing a symbol; call before editing.
- `codegraph_files` — indexed file tree (tree/flat/grouped by language) with symbol counts.
- `codegraph_explore` — broad questions: relevant symbols' source + call paths in one shot. Name endpoint symbols (`mutateElement renderScene`) to surface paths across dynamic-dispatch hops.

## How to query

- Every tool accepts `path`: the project to query. Defaults to the current working directory. In a monorepo, pass the sub-project directory that contains `.codegraph/`.
- `codegraph_query`: `search` (symbol name or partial), optional `kind` (function, method, class, ...) and `limit`.
- `codegraph_explore`: `query` (symbol names or natural language) and optional `maxFiles` to cap source lines returned.

## Anti-patterns & Guidance

- **Trust AST results.** Don't re-verify codegraph output with grep.
- **Already sent earlier in this conversation.** When this pointer appears, the lines are already in your session context — scroll back instead of re-fetching or reading the file.
- **Staleness banner.** If output warns `⚠️ Some files referenced below were edited since the last index sync`, read only those specific files directly; other files in the response remain fresh.
- **No index, no tool.** If output says the project isn't indexed, stop calling `codegraph_*` for that project this session and use built-in tools. Indexing is the user's decision — suggest the user run `/codegraph-init` if appropriate.