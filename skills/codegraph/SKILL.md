---
name: codegraph
description: Query the project's CodeGraph index (symbol source + call paths) via the codegraph_explore tool. Use when answering structural code questions — how X works, where X is, what a change affects — in a project that has a .codegraph/ index.
---

# CodeGraph

The `codegraph_explore` tool answers structural code questions in one shot: the relevant symbols' verbatim line-numbered source, the call paths between them, and a blast-radius summary. It reads the project's CodeGraph index (`.codegraph/`), built and maintained by the `codegraph` CLI.

## When to use

- "How does X work?" / "Where is X?" / "What calls Y?" / "What breaks if I change Z?"
- Before an edit, to map the symbols you are about to touch.
- Prefer it over grep/read for these questions **when the project has a `.codegraph/` index**.

## How to query

- `query`: symbol names (`CodeGraph open`, `MCPSession`) or a natural-language question. Naming a file or symbol returns its current line-numbered source.
- `path`: optional project path. Defaults to the current working directory. In a monorepo, pass the sub-project that has the index.

## Boundaries

- **No index, no tool.** If the output says the project isn't indexed, stop calling `codegraph_explore` for that project this session and use the built-in tools. Indexing is the user's decision — never run `codegraph init` yourself; suggest the user run `/codegraph-init` if it comes up.
- **Freshness.** The index syncs at session start; mid-session edits can lag. For code written in the last few minutes, trust the editor/diff over the index.
- **Not a compiler.** Cross-file resolution is best-effort name matching. Correctness validation stays with the compiler, tests, and linters.
