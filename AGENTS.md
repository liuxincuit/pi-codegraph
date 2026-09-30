# Repository Guidelines

本仓库是 pi（`@earendil-works/pi-coding-agent`）的 CodeGraph 集成插件：通过 `codegraph_explore` 工具和若干 `/codegraph-*` 命令，让 agent 能查询 CodeGraph 索引（符号源码与调用路径）。fork 自 `izhimu/pi-codegraph`。

## 项目结构与模块组织

```
extensions/codegraph.ts   # 唯一扩展源码：pi ExtensionAPI 集成（工具/命令/session 钩子）
skills/codegraph/SKILL.md # agent 使用指南：何时调用 codegraph_explore
docs/adr/                 # 设计决策记录（改架构前先读）
CONTEXT.md                # 领域术语表（编写时遵守其用词约定）
smoke.mjs                 # 冒烟测试脚本
package.json              # pi 包清单；files 白名单决定发布内容
```

## 构建、测试与开发命令

```bash
npm install          # 安装依赖（peer: @earendil-works/pi-coding-agent）
npm run typecheck    # tsc --noEmit，类型检查
npm run smoke        # 编译扩展并对 mock pi 运行冒烟测试（需 codegraph CLI 在 PATH）
pi -e ./extensions/codegraph.ts   # 不安装直接试运行扩展
```

`npm run smoke` 前置条件：`npm i -g @colbymchenry/codegraph`。

## 编码风格与命名约定

- TypeScript ESM（`"type": "module"`），target ES2022、strict 模式。
- **Tab 缩进**、单引号、行尾分号；无 lint/prettier 配置，与现有代码保持一致。
- agent 可见标识均为小写 kebab-case：工具 `codegraph_explore` 除外（沿用上游命名）、命令 `/codegraph-init`、`/codegraph-sync` 等。
- 不得在代码中硬编码密钥或本机路径；文档使用 `path` 等相对表述。
- **注释、文档一律使用中文**（代码标识符、工具名等除外）；涉及上游/索引输出的原文引用（如 "Already sent earlier in this conversation"）可保留原文并附中文说明。

## 测试指南

- 无单元测试框架。验证 = `npm run typecheck` + `npm run smoke`。
- smoke 覆盖两态：CLI 缺失（断言不注入任何工具/命令/技能、仅一次安装提示）与 CLI 存在（mock pi + 真实 CLI 验证未索引直通、命令注册、session 状态流转；CLI 不可用则该场景自动跳过）。
- 涉及 CLI 调用、session 钩子或注入逻辑的改动，必须保证 smoke 全绿。
- 冒烟脚本与场景位于 `smoke.mjs`，新增命令/钩子时同步补充场景。

## 提交与 PR 指南

- 遵循 Conventional Commits（历史使用 `feat`/`fix`/`chore`，可选 scope，如 `feat(extensions):`），message 用英文、祈使句。
- **只暂存本次改动涉及的文件**，不得夹带未跟踪文件（如 `.pi/`、`node_modules/`）或他人改动。
- PR 描述说明改动动机与影响面，涉及 agent 行为时附对话/调用示例；先经 `npm run typecheck`。

## Agent 协作说明

- 本文件会被 pi 作为项目指令自动加载；改动 `skills/codegraph/SKILL.md` 或 `extensions/codegraph.ts` 前，先读 `docs/adr/0001`（CLI 桥接）与 `docs/adr/0002`（手动索引）。
- 描述性文字遵循 `CONTEXT.md` 术语（"项目/索引/查询/同步"），避免歧义词。

## 项目约定（由 retrospective 管理）

- **涉及工具暴露/激活的改动，验证不能只靠 `typecheck` + `smoke`**：例外的是真实 pi 跑四种场景——工作目录未索引、已索引、`inject: "always"`、跨目录发现——并从 session JSONL 断言第一条 system 消息的 `toolsAdded`（声明给模型的工具）与 `sections.skills`（注入的技能）符合预期（2026-09-30，背景见 `docs/adr/0004`）。
- **devDependency 必须与本地实际运行的 pi 对齐**（当前 `^0.99.1`）：pi 包以 peer `*` 声明时本地可能装的是旧版，`defaultActive` / `ToolResultEvent.structuredContent` 这类新 API 在旧类型里不存在，会逼出 cast 或直接编译不过（2026-09-30 实测：本地 0.83.0 vs 运行时 0.99.1）。
