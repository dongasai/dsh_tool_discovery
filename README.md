# 工具发现（@dongasai/dsh-tool-discovery）

把「模型默认能看到并直接调用哪些工具」变成一份**可管理的策略**，其余工具退化成提示词里的一行索引，由模型用 `tool_find` 按需发现、激活。

- **三档**：默认（完整 schema）/ 可发现（只有一行索引）/ 屏蔽（不可见、不可调用）。
- **两层策略**：全局管理面板管所有工作区的底；工作区管理面板按目录覆盖，且只能加屏蔽、不能解全局屏蔽。
- **渐进发现**：可发现工具在系统提示词里只占「名字 — 一句话」，激活后才进模型声明，和 skill 的渐进披露同一套路数。

与 `dsh-tool-activator` 的区别：activator 是「先声明（延迟加载）、后激活」，配置是 profile 全局一份；本插件先把可用工具管起来（三档 + 工作区覆盖），再让模型按意图检索。

## 装法

作为本地 bundle 装进 profile：

```bash
cd ~/.dsh/profiles/web
# package.json: dependencies 加 "@dongasai/dsh-tool-discovery": "link:/data/ai/dsh/dsh_tool_discovery"
#              dsh.profile.bundles 加 "@dongasai/dsh-tool-discovery"
ln -s /data/ai/dsh/dsh_tool_discovery node_modules/@dongasai/dsh-tool-discovery
```

Host 半边（`index.js`）改完要重启 `dsh web`；浏览器半边（`client.js`）刷新页面即新。

## 两个管理面板

打开右侧栏的「更多」→ 指南卡片：

| 面板 | 页签 | 管什么 | 写到哪 |
| --- | --- | --- | --- |
| 工具·全局 | `tool-discovery-global` | 默认档名单、全局屏蔽、索引预算 | `$DSH_HOME/tool-discovery/global.json` |
| 工具·工作区 | `tool-discovery-workspace` | 当前会话所在工作区的追加默认 / 追加屏蔽 | `<workspace>/.dsh/tool-policy.json` |

面板每行一个工具，点「默认 / 可发现 / 屏蔽」改档，按「保存」落盘。工具表由 Host 半边按 全局 → 工作区 → 会话激活 合成后给出，所以看到的就是生效结果。

「工具·工作区」页签正文由右侧栏槽位传入当前会话 id（`sidebar.right.pane.tab` 的 `sessionId` prop），**只管理当前会话所在工作区**，不提供工作区切换下拉；没有会话上下文时只读显示全局合成结果且保存被拒。

## 配置（`cordis.patch.yml`）

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `defaultTools` | 12 个常用工具 | 全局默认档；磁盘上的 `global.json` 会覆盖它 |
| `blockedTools` | `[]` | 全局屏蔽 |
| `indexBudgetChars` | `4000` | 索引段落的字符预算（超了先截摘要，再截行，最后只报数量） |
| `summaryChars` | `80` | 一行摘要的字符上限 |
| `workspacePolicyFile` | `.dsh/tool-policy.json` | 工作区策略文件的相对路径 |

## 策略三层

1. **屏蔽**：全局 ∪ 工作区，工作区只能加；
2. **默认**：会话激活 ∪ 工作区 `default` ∪ 全局 `defaultTools`；
3. **其余**：一律 `discoverable`。

工作区靠会话 `header.cwd` 识别；没有工作区（比如没有会话）时只看全局层。

## tool_find

| 参数 | 说明 |
| --- | --- |
| `query` | 名字片段或自然语言意图（「发信」「定时提醒」） |
| `name` | 精确名，优先于 `query` |
| `activate` | `true` 时把命中工具加载进本会话 |
| `limit` | 返回条数，默认 10、上限 20 |

匹配顺序：精确名 ＞ 前缀 ＞ 名字包含 ＞ 摘要包含 ＞ 说明包含。屏蔽工具永远不出现。

## 实现要点

| 环节 | 用的官方面 |
| --- | --- |
| 视图过滤 | `system-prompt/assemble` 瀑布，删掉非默认档的 schema |
| 索引注入 | `ctx.systemPrompt.section()`，`order` 取 `TOOLS_SDK` 前 1 |
| 执行拒绝 | `ctx.tools.guard()`，只拦屏蔽档 |
| 工具表 | `ctx.tools.schemas(agent)` |
| 工作区 | `ctx.workspaceRegistry.list()` + `session.header.cwd` |
| 面板数据 | `ctx.webServer.register` 两条路由，先过 `ctx.connection.requestRejection` |

三处**失败开放**：组装瀑布、guard、索引段落出错时都保持原样，宁可多给工具也不让一轮请求失败。

## 已知边界

- **激活只在内存**：会话恢复后激活集合丢失（v0.1 未做 session projection 持久化）。
- **PTC 模式**：模型只看到 `run_code`，索引与激活语义未适配；目前只保证 native 模式。
- **中途激活改请求头**：激活后下一轮才进声明；没做 `defer_loading` + `tool_addition`，所以会重算一次请求头。
- **与 activator 打架**：两者都改工具声明，同时开启是双重伪装，建议二选一。
- **工作区面板只跟当前会话走**：不再有工作区下拉；目标工作区由会话 cwd 解析（`workspaceRegistry` 只做校验兜底）。没有会话上下文时面板只读且保存被拒。

## 探针

```bash
node probe/probe.mjs
```

桩 ctx + 真文件系统，覆盖：默认档过滤、索引生成与截断、`tool_find` 检索与激活、屏蔽 guard、工作区覆盖、全局文件覆盖、两条面板路由、工具来源自动感知。当前 41 项断言。
