---
name: codegraph
description: 通过 codegraph_explore 工具查询项目的 CodeGraph 索引（符号源码、调用路径、影响范围）。当回答结构化代码问题——X 如何工作、X 在哪里、谁调用 Y、修改某处会影响什么——且项目存在 .codegraph/ 索引时使用。
---

# CodeGraph

`codegraph_explore` 工具从项目的 CodeGraph 索引（`.codegraph/`，由 `codegraph` CLI 建立与维护）回答结构化代码问题。**当项目存在 `.codegraph/` 索引时**，应优先使用它而不是 grep/read。

## 默认工具

- `codegraph_explore` — 一次调用完成广泛探索：相关符号的源码 + 调用路径。可以点名端点符号（`mutateElement renderScene`）以跨越动态分派跳转揭示调用路径。参数：`query`（符号名或自然语言问题）、可选 `maxFiles`（限制返回源码行数）。

绝大多数结构化问题只需 `codegraph_explore` 即可解决。该工具始终注册。

## 细粒度工具（可选开启）

以下细粒度工具**默认隐藏**，以保持工具列表精简。它们只有在用户通过配置 `extraTools` 开启后才会注册；开启之前调用会报 "tool not found"。除非能在 `Available tools` 中看到它们，否则不要调用。

- `codegraph_query` — 定位符号：位置 + 签名，不含源码。
- `codegraph_node` — 单个已知符号的逐字源码 + 调用/被调轨迹，可链式追踪调用图。
- `codegraph_callers` / `codegraph_callees` — 谁调用了某符号 / 某符号调用了什么。
- `codegraph_impact` — 修改某符号的影响范围；编辑前调用。
- `codegraph_files` — 已建索引的文件树（tree/flat/grouped 按语言分组）与符号数量。

开启方式：在 `~/.pi/agent/extensions/pi-codegraph/config.json`（全局）或 `.pi/extensions/pi-codegraph/config.json`（项目，覆盖全局）中配置：

```json
{ "extraTools": ["query", "node", "impact"] }
```

短名（`node`、`impact`）与完整工具名（`codegraph_node`）均可，`"extraTools": "all"` 开启全部。配置在下一个会话生效（`/reload` 或重启 pi）。如果反复需要某个隐藏工具，可以向用户建议此配置。

## 如何查询

- `codegraph_explore` 接受 `path` 参数：要查询的项目目录，默认为当前工作目录。在 monorepo 中，传入包含 `.codegraph/` 的子项目目录。

## 反模式与指导

- **信任 AST 结果。** 不要用 grep 重复验证 codegraph 输出。
- **Already sent earlier in this conversation。** 当出现该提示时，内容已在会话上下文中——回看上下文，不要重新获取或 Read。
- **过期提示。** 如果输出警告 `⚠️ Some files referenced below were edited since the last index sync`，只直接读取其中被标记的文件；其余内容仍然新鲜。
- **无索引不可用。** 如果输出提示项目未建索引，本会话内停止对该项目调用 `codegraph_explore`，改用内置工具。是否建索引由用户决定——适当时建议用户运行 `/codegraph-init`。