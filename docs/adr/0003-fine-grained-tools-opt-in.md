# 细粒度工具默认为 opt-in，不注册

扩展注册七个工具：`codegraph_explore` 加六个细粒度工具（`codegraph_query`、`codegraph_node`、`codegraph_callers`、`codegraph_callees`、`codegraph_impact`、`codegraph_files`）。v0.1.1 无条件全部注册；自 v0.1.3 起默认只注册 `codegraph_explore`。

工具过多会给大模型带来负担：每个工具都会增加系统提示条目，且大量近似的工具列表会让模型的选择更困难、更容易出错。`codegraph_explore` 单独就能覆盖绝大多数结构化问题（一次调用返回符号源码 + 调用路径；参见 CONTEXT.md——Explore 是唯一的查询操作）。细粒度工具是它更廉价的狭窄变体，适用于模型已经确切知道要查哪个符号的场景。

决策：六个细粒度工具**默认不注册**，除非用户通过配置开启。配置为 `extraTools`，写在 `~/.pi/agent/extensions/pi-codegraph/config.json`（全局）和/或 `.pi/extensions/pi-codegraph/config.json`（项目，覆盖全局，仅对受信任项目生效——`ctx.isProjectTrusted()`）。取值用短名（`node`、`impact`）或完整工具名（`codegraph_node`），或字面量 `"all"`。pi 没有第三方配置 API，扩展自行读取并合并这两个 JSON 文件。配置在下一个会话开始时生效。

后果：

- 默认系统提示绝不会宣传不存在的工具：注入的索引提示（`buildIndexHint`）按实际启用的工具集生成，SKILL.md 也将细粒度工具标注为 opt-in。
- 注册是进程级的，且没有注销 API。跨项目切换时，前一个项目开启过的工具会残留；因此 `session_start` 还会用 `pi.setActiveTools` 将活动工具集与当前配置对齐，使未开启的工具不出现在系统提示中。
- 未注册的工具若被模型误调用，会得到 pi 的 "tool not found"——可接受的失败，SKILL.md 已指导智能体先查看 `Available tools`。