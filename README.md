# pi-codegraph

> 本仓库 fork 自 [izhimu/pi-codegraph](https://github.com/izhimu/pi-codegraph)，原作者版权信息见 [LICENSE](LICENSE)。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![pi extension](https://img.shields.io/badge/pi-extension-green.svg)](https://github.com/earendil-works/pi)

为 [pi](https://github.com/earendil-works/pi) 提供 [CodeGraph](https://github.com/colbymchenry/codegraph) 支持：智能体将获得一个 `codegraph_explore` 工具——一次查询即可返回相关符号逐字、带行号的源码，以及它们之间的调用路径。

## 环境要求

`PATH` 中需要存在 `codegraph` CLI：

```bash
npm i -g @colbymchenry/codegraph
```

未检测到 CLI 时，插件**不会注入任何工具、命令或技能**（`codegraph_explore`、`/codegraph-*`、CodeGraph 技能均不加载），仅在会话开始时弹出一条安装提示；安装后 `/reload` 或重启 pi 即恢复全部功能。

## 安装

### npm（推荐）

```bash
pi install @liuxincuit/pi-codegraph
```

### 从 Git 安装

```bash
# 全局安装
pi install git:github.com/liuxincuit/pi-codegraph

# 项目本地安装（通过 .pi/settings.json 与团队共享）
pi install git:github.com/liuxincuit/pi-codegraph -l
```

### 从本地路径安装

```bash
pi install /path/to/pi-codegraph
```

### 快速测试（无需安装）

```bash
pi -e ./extensions/codegraph.ts
```

## 功能一览

- **`codegraph_*` 工具集** — 面向智能体的代码智能工具，均支持 `path` 参数查询其他已建索引的项目：
  - `codegraph_explore` — 一揽子探索：相关符号逐字源码 + 调用路径 + 影响范围（`maxFiles` 限制返回行数）
  - `codegraph_query` — 按名称搜索符号（位置 + 签名，可选 `kind`/`limit` 过滤）
  - `codegraph_node` — 单个符号的源码 + 调用轨迹，可链式追踪调用图
  - `codegraph_callers` / `codegraph_callees` — 谁调用了它 / 它调用了谁（`limit`）
  - `codegraph_impact` — 修改符号的影响半径（`depth`）
  - `codegraph_files` — 从索引查看文件结构（tree/flat/grouped，`pattern`、`maxDepth`）
- **`/codegraph-init [path]`** — 为项目建立索引（`codegraph init`）。
- **`/codegraph-sync [path]`** — 手动同步自上次索引以来的改动（`codegraph sync`）。
- **`/codegraph-status [path]`** — 查看索引状态与统计信息（`codegraph status`）。
- **`/codegraph-unlock [path]`** — 守护进程崩溃后释放过期的数据库锁（`codegraph unlock`）。
- **会话开始时自动同步** — 每个会话自动执行一次 `codegraph sync -q`，确保索引反映你最近的编辑。

## 使用方法

像往常一样提出结构性问题即可——项目建立索引后，智能体会优先调用 `codegraph_explore`：

- "会话加载是如何工作的？"
- "如果我修改 `ExtensionRunner.emit`，会破坏什么？"

在新项目中第一次使用 pi 时，请先手动建立一次索引：

```
/codegraph-init
```

索引构建始终由你显式触发——智能体自身不会运行 `codegraph init`（见 `docs/adr/0002`）。

## 工作原理

pi 原生不支持 MCP，因此本扩展通过执行 CLI 来桥接 CodeGraph——`codegraph explore` 产生与 `codegraph_explore` MCP 工具相同的输出（见 `docs/adr/0001`）。每次工具调用仅需一次 `pi.exec`：没有守护进程、没有 JSON-RPC，没有可泄漏或需要恢复的状态。

`skills/codegraph/` 下的 `SKILL.md` 会被 pi 的技能系统自动发现，用于指导智能体在何种情况下优先使用该工具而非 grep/read。

## 项目结构

```
pi-codegraph/
├── extensions/
│   └── codegraph.ts      # pi ExtensionAPI 集成
├── skills/
│   └── codegraph/
│       └── SKILL.md      # codegraph_explore 的智能体使用指南
├── docs/adr/             # 设计决策记录
├── CONTEXT.md            # 领域术语表
├── package.json          # pi 包清单
├── tsconfig.json
├── LICENSE
└── README.md
```

## 开发

```bash
npm install
npm run typecheck
```

## 贡献

欢迎提交贡献！请：

1. Fork 本仓库
2. 新建功能分支（`git checkout -b feat/amazing-feature`）
3. 提交改动（`git commit -m 'feat: add amazing feature'`）
4. 推送到分支（`git push origin feat/amazing-feature`）
5. 发起 Pull Request

## License

[MIT](LICENSE) © [liuxincuit](https://github.com/liuxincuit)，fork 自 [izhimu/pi-codegraph](https://github.com/izhimu/pi-codegraph)。
