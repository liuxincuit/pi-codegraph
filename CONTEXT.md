# pi-codegraph

A pi extension that gives the agent access to a CodeGraph index of the current project.

## Language

**Project**:
The directory the pi session runs in (`ctx.cwd`). The unit that CodeGraph indexes and the default scope of every query.
_Avoid_: workspace, repository, repo

**Index**:
The `.codegraph/` directory at the project root, holding the SQLite knowledge graph of the project's symbols, edges, and files. Built by `codegraph init`, updated by `codegraph sync`.
_Avoid_: database, cache, graph (ambiguous with the data structure)

**Explore**:
The single agent-facing query operation: a natural-language or symbol question answered with the relevant symbols' verbatim source plus the call paths between them.
_Avoid_: search, query, lookup

**Sync**:
An incremental update of the Index to match the files currently on disk. Cheap when nothing changed.
_Avoid_: refresh, rebuild (that's a full re-index)

**Gate**:
The per-session decision whether codegraph tools are declared to the model, recomputed on session start and turned on by Discovery: the Project is indexed, `inject` is `always`, or Discovery found an index.
_Avoid_: switch, toggle, mode, flag (ambiguous with pi flags)

**Discovery**:
Finding an Index that is not the Project's own: a tool touches a path under a directory containing `.codegraph/`, so that directory is surfaced to the agent (and to the user, as a TUI notification) and the tools become available for the rest of the session.
_Avoid_: scan, watch, auto-init (Discovery never builds an Index — see ADR-0002)
