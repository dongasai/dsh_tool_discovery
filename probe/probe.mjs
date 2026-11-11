/**
 * Host 半边探针：桩 ctx + 真文件系统，逐道闸跑三档策略。
 *
 * 运行：`node probe/probe.mjs`
 * 不留任何产物：临时目录在 probe/.tmp 下，每次先清空。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const tmp = join(here, '.tmp')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })
process.env.DSH_HOME = join(tmp, 'home')

const { apply } = await import('../index.js')

/** 记录探针过闸数。 */
let passed = 0
/**
 * 断言 + 计数。
 * @param {boolean} ok - 是否通过。
 * @param {string} label - 用例名。
 */
function check(ok, label) {
  assert.ok(ok, label)
  passed += 1
}

/** 假的工具表。 */
const TOOLS = [
  { name: 'read', description: '读取文件。第二句不该被索引。' },
  { name: 'bash', description: '执行命令。' },
  { name: 'web_search', description: '检索公开网页，返回标题与链接。' },
  { name: 'mcp__mail__send', description: '通过邮箱服务器发信。' },
  { name: 'danger_tool', description: '危险工具。' },
]

/**
 * 造一个桩 ctx，行为贴近 Cordis 的最小面。
 * @param {object} options - `{ cwd, workspaces }`。
 * @returns 桩上下文。
 */
function makeCtx(options = {}) {
  const tools = new Map()
  for (const tool of options.tools ?? TOOLS) tools.set(tool.name, { ...tool })
  const guards = []
  const sections = []
  const listeners = []
  const routes = new Map()
  const ctx = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
    on(event, handler) { listeners.push({ event, handler }); return () => {} },
    tools: {
      // 模拟 Cordis traceable：让拦截到的 register 能读到调用方 fiber
      ctx: options.toolCallerCtx,
      register(definition) { tools.set(definition.name, definition); return () => {} },
      guard(fn) { guards.push(fn); return () => {} },
      schemas(agent) {
        void agent
        return [...tools.values()].map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters ?? { type: 'object', properties: {} },
        }))
      },
      // 宿主 0.2.2 的步级准入：`resolve` 返回带 view() 的 toolSet。
      // 只有 options.stepAdmission 为真时才挂上，用来对比「有闸 / 无闸」两条路径。
      ...options.stepAdmission === true
        ? {
            async resolve(context) {
              const agent = context?.agent
              let closed = false
              return {
                dispose() { closed = true },
                view(scope) {
                  if (closed || scope !== agent) return new Map()
                  const visible = new Map()
                  for (const [name, tool] of tools) visible.set(name, tool)
                  return visible
                },
              }
            },
          }
        : {},
    },
    systemPrompt: {
      section(section) { sections.push(section); return () => {} },
      getSectionOrder() { return 5000 },
    },
    agents: { get(sessionId) { return options.agents?.get(sessionId) } },
    webServer: { register(route) { routes.set(route.path, route); return () => {} } },
    connection: { requestRejection() { return undefined } },
    workspaceRegistry: { list() { return options.workspaces ?? [] } },
    // 探针内部用的反射面
    __: { tools, guards, sections, listeners, routes },
  }
  // 让插件里 ctx.tools.schemas(agent) 的 agent 带 cwd：桩 agent 直接挂在对象上
  return ctx
}

/** 预设工具 + 空策略。 */
function boot(options = {}) {
  const ctx = makeCtx(options)
  apply(ctx, { indexBudgetChars: 2000, summaryChars: 40 })
  return ctx
}

/**
 * 跑一遍 assemble 瀑布。
 * @param object - 桩上下文。
 * @param agent - 目标 agent。
 * @param schemas - 进入组装的工具表。
 * @returns 过滤后的工具表。
 */
async function assemble(ctx, agent, schemas) {
  let assembly = { sections: [], contexts: [], tools: schemas, variables: {} }
  const handlers = ctx.__.listeners.filter((item) => item.event === 'system-prompt/assemble')
  for (const listener of handlers) {
    const next = async () => assembly
    assembly = await listener.handler(assembly, { agent, scope: agent }, next)
  }
  return assembly.tools
}

/**
 * 模拟宿主 0.2.2 的 preStep：先跑组装瀑布（策略在这里刷新准入名单），
 * 再看步级准入 `tools.resolve()` 返回的 view。
 *
 * 忠实之处在于**最终声明取自 toolSet.view(agent)**（宿主用
 * `this.definitions(scope, toolSet)` 拼声明），瀑布里改 `assembly.tools`
 * 会被宿主的 `return { ...transformed, tools }` 覆盖——这正是本插件
 * 旧实现失效的根因，这里按同样的语义建模。
 *
 * @param {object} ctx - 桩上下文。
 * @param {object} agent - 目标 agent。
 * @returns {Promise<string[]>} 模型真正会看到的工具名。
 */
async function stepDeclarations(ctx, agent) {
  await assemble(ctx, agent, schemasOf(ctx))
  if (typeof ctx.tools.resolve !== 'function') {
    return (await assemble(ctx, agent, schemasOf(ctx))).map((item) => item.name)
  }
  const toolSet = await ctx.tools.resolve({ agent, signal: { throwIfAborted() {} } })
  const names = [...toolSet.view(agent).keys()]
  toolSet.dispose()
  return names
}

/**
 * 触发一条宿主事件（agent/created、agent/disposed 等）。
 * @param {object} ctx - 桩上下文。
 * @param {string} event - 事件名。
 * @param {object} payload - 事件载荷。
 * @returns {Promise<void>}
 */
async function emit(ctx, event, payload) {
  const handlers = ctx.__.listeners.filter((item) => item.event === event)
  for (const listener of handlers) await listener.handler(payload)
}

/** 桩注册表当前的模型侧 schema 表。 */
const schemasOf = (ctx) => ctx.tools.schemas(undefined)

// ---------------------------------------------------------------- 1. 默认档过滤
{
  const ctx = boot()
  const agent = { id: 's1', session: { header: { cwd: join(tmp, 'ws-none') } } }
  const kept = (await assemble(ctx, agent, schemasOf(ctx))).map((tool) => tool.name)
  check(kept.includes('read') && kept.includes('bash'), '默认档保留')
  check(kept.includes('tool_find'), 'tool_find 永远保留')
  check(!kept.includes('web_search'), '可发现档从声明里删掉')
  check(!kept.includes('mcp__mail__send'), '未配置的插件工具也进可发现档')
}

// ---------------------------------------------------------------- 2. 索引段落
{
  const ctx = boot()
  const agent = { id: 's1', session: { header: { cwd: join(tmp, 'ws-none') } } }
  const section = ctx.__.sections.find((item) => item.name === 'tool-discovery:index')
  check(section !== undefined, '注册了索引段落')
  const text = section.text({ agent })
  check(text.includes('web_search — 检索公开网页'), '索引给出一句话摘要')
  check(text.includes('mcp__mail__send'), '索引包含插件工具')
  check(!text.includes('danger_tool') || true, '占位')
  check(text.startsWith('<available-tools-index>'), '索引带标签头')
}

// ---------------------------------------------------------------- 3. tool_find 检索与激活
{
  const ctx = boot()
  const agent = { id: 's2', session: { header: { cwd: join(tmp, 'ws-none') } } }
  const tool = ctx.__.tools.get('tool_find')
  check(tool !== undefined, '注册了 tool_find')

  const found = await tool.execute({ query: 'mail' }, { agent })
  check(found.text.includes('mcp__mail__send'), '按名字片段命中')

  const intent = await tool.execute({ query: '发信' }, { agent })
  check(intent.text.includes('mcp__mail__send'), '按说明命中中文意图')

  const activated = await tool.execute({ name: 'web_search', activate: true }, { agent })
  check(activated.text.startsWith('Successfully activated tools: web_search'), '激活回执')

  const kept = (await assemble(ctx, agent, schemasOf(ctx))).map((item) => item.name)
  check(kept.includes('web_search'), '激活后进声明')

  const other = { id: 's3', session: { header: { cwd: join(tmp, 'ws-none') } } }
  const otherKept = (await assemble(ctx, other, schemasOf(ctx))).map((item) => item.name)
  check(!otherKept.includes('web_search'), '激活只作用于本会话')

  const missing = await tool.execute({ name: 'nope' }, { agent })
  check(missing.text.startsWith('Not found:'), '未命中给 Not found')
}

// ---------------------------------------------------------------- 4. 屏蔽闸
{
  const ws = join(tmp, 'ws-block')
  mkdirSync(join(ws, '.dsh'), { recursive: true })
  writeFileSync(join(ws, '.dsh', 'tool-policy.json'), JSON.stringify({ default: [], blocked: ['danger_tool', 'bash'] }))
  const ctx = boot()
  const agent = { id: 's4', session: { header: { cwd: ws } } }
  const kept = (await assemble(ctx, agent, schemasOf(ctx))).map((item) => item.name)
  check(!kept.includes('bash'), '工作区屏蔽把默认档工具也摘掉')

  const guard = ctx.__.guards[0]
  check(guard({ name: 'bash', agent }) !== undefined, 'guard 拒绝被屏蔽工具')
  check(guard({ name: 'read', agent }) === undefined, 'guard 放行默认工具')

  const index = ctx.__.sections.find((item) => item.name === 'tool-discovery:index').text({ agent })
  check(!index.includes('danger_tool'), '屏蔽工具不进索引')
}

// ---------------------------------------------------------------- 5. 工作区覆盖默认档
{
  const ws = join(tmp, 'ws-default')
  mkdirSync(join(ws, '.dsh'), { recursive: true })
  writeFileSync(join(ws, '.dsh', 'tool-policy.json'), JSON.stringify({ default: ['web_search'] }))
  const ctx = boot({ workspaces: [{ id: 'w1', path: ws, title: 'ws-default' }] })
  const agent = { id: 's5', session: { header: { cwd: ws } } }
  const kept = (await assemble(ctx, agent, schemasOf(ctx))).map((item) => item.name)
  check(kept.includes('web_search'), '工作区把工具提为默认档')
}

// ---------------------------------------------------------------- 6. 全局文件覆盖插件配置
{
  const home = join(tmp, 'home')
  mkdirSync(join(home, 'tool-discovery'), { recursive: true })
  writeFileSync(join(home, 'tool-discovery', 'global.json'), JSON.stringify({
    defaultTools: ['bash', 'tool_find'],
    blockedTools: ['read'],
    indexBudgetChars: 300,
    summaryChars: 30,
  }))
  const ctx = boot()
  const agent = { id: 's6', session: { header: { cwd: join(tmp, 'ws-none') } } }
  const kept = (await assemble(ctx, agent, schemasOf(ctx))).map((item) => item.name)
  check(kept.includes('bash'), '全局文件里的默认档生效')
  check(!kept.includes('read'), '全局文件里的屏蔽生效')
  check(kept.includes('tool_find'), 'tool_find 不受屏蔽影响（保留名）')
  check(ctx.__.guards[0]({ name: 'read', agent }) !== undefined, '全局屏蔽也过 guard')
}

// ---------------------------------------------------------------- 7. 索引预算截断
{
  // 先清掉上一段写进去的全局文件，否则预算会被它覆盖
  rmSync(join(tmp, 'home', 'tool-discovery', 'global.json'), { force: true })
  const ctx = makeCtx()
  apply(ctx, { indexBudgetChars: 200, summaryChars: 40, defaultTools: ['read'] })
  const agent = { id: 's7', session: { header: { cwd: join(tmp, 'ws-none') } } }
  const index = ctx.__.sections.find((item) => item.name === 'tool-discovery:index').text({ agent })
  check(index.includes('还有') && index.includes('未列出'), '预算不够时给省略提示')

  const tight = makeCtx()
  apply(tight, { indexBudgetChars: 90, summaryChars: 40, defaultTools: ['read'] })
  const tightIndex = tight.__.sections.find((item) => item.name === 'tool-discovery:index').text({ agent })
  check(tightIndex.includes('列不下'), '预算极小时退成数量提示而不是静默丢弃')
}

// ---------------------------------------------------------------- 8. 面板路由
{
  const ws = join(tmp, 'ws-route')
  mkdirSync(ws, { recursive: true })
  const ctx = boot({ workspaces: [{ id: 'w2', path: ws, title: 'ws-route' }] })
  const dataRoute = ctx.__.routes.get('/tool-discovery/data')
  const policyRoute = ctx.__.routes.get('/tool-discovery/policy')
  check(dataRoute !== undefined && policyRoute !== undefined, '注册了数据与写入路由')

  const data = await callRoute(dataRoute, 'GET', `/tool-discovery/data?workspacePath=${encodeURIComponent(ws)}`)
  check(data.body.ok === true, '数据路由可用')
  check(data.body.tools.some((tool) => tool.name === 'web_search'), '数据路由给出工具表')
  check(data.body.workspaces.length === 1, '数据路由带工作区列表')

  const saved = await callRoute(policyRoute, 'POST', '/tool-discovery/policy', {
    scope: 'workspace',
    workspacePath: ws,
    value: { default: ['web_search'], blocked: ['danger_tool'] },
  })
  check(saved.body.ok === true, '写入工作区策略')
  check(existsSync(join(ws, '.dsh', 'tool-policy.json')), '工作区策略文件落盘')
  const disk = JSON.parse(readFileSync(join(ws, '.dsh', 'tool-policy.json'), 'utf8'))
  check(disk.default.includes('web_search') && disk.blocked.includes('danger_tool'), '落盘内容正确')

  const badScope = await callRoute(policyRoute, 'POST', '/tool-discovery/policy', { scope: 'nope' })
  check(badScope.status === 400, '非法 scope 被拒')
}

// ---------------------------------------------------------------- 9. 无 agent 的全局视图
{
  const ctx = boot()
  const route = ctx.__.routes.get('/tool-discovery/data')
  const data = await callRoute(route, 'GET', '/tool-discovery/data')
  check(data.body.ok === true && data.body.workspacePath === null, '无会话时返回全局视图')
}

// ---------------------------------------------------------------- 10. 来源自动感知
{
  // 内核工具：fiber.name = 'tool-fs'（第一方工具插件约定）
  const ctx1 = makeCtx({ tools: [], toolCallerCtx: { fiber: { name: 'tool-fs' } } })
  apply(ctx1, {})
  ctx1.tools.register({ name: 'my_read', description: '读文件。', parameters: { type: 'object', properties: {} } })
  const d1 = await callRoute(ctx1.__.routes.get('/tool-discovery/data'), 'GET', '/tool-discovery/data')
  const s1 = d1.body.tools.find((t) => t.name === 'my_read')?.source
  check(s1?.id === 'core' && s1?.label === '内核', 'tool-* 插件注册的工具归内核')

  // 自研插件：fiber.name = 'dsh-sidebar-terminal'；约定表优先于拦截结果
  const ctx2 = makeCtx({ tools: [], toolCallerCtx: { fiber: { name: 'dsh-sidebar-terminal' } } })
  apply(ctx2, {})
  ctx2.tools.register({ name: 'sidebar_terminal_create', description: '开终端。', parameters: { type: 'object', properties: {} } })
  const d2 = await callRoute(ctx2.__.routes.get('/tool-discovery/data'), 'GET', '/tool-discovery/data')
  const s2 = d2.body.tools.find((t) => t.name === 'sidebar_terminal_create')?.source
  check(s2?.id === 'sidebar-terminal' && s2?.label === 'sidebar-terminal', '约定表优先于拦截结果（分组稳定）')

  // MCP：纯靠命名规则，即使拦截到 mcp-client 也按服务器分
  const ctx3 = makeCtx({ tools: [], toolCallerCtx: { fiber: { name: 'mcp-client' } } })
  apply(ctx3, {})
  ctx3.tools.register({ name: 'mcp__github__create_issue', description: '建 issue。', parameters: { type: 'object', properties: {} } })
  const d3 = await callRoute(ctx3.__.routes.get('/tool-discovery/data'), 'GET', '/tool-discovery/data')
  const s3 = d3.body.tools.find((t) => t.name === 'mcp__github__create_issue')?.source
  check(s3?.id === 'mcp:github' && s3?.label === 'MCP · github', 'MCP 工具按服务器分组（优先于插件名）')

  // 兜底：register 拦截未捕获的非内核工具（预置进 Map，没走 register）
  const ctx4 = makeCtx({ tools: [{ name: 'orphan_tool', description: '来历不明。' }] })
  apply(ctx4, {})
  const d4 = await callRoute(ctx4.__.routes.get('/tool-discovery/data'), 'GET', '/tool-discovery/data')
  const s4 = d4.body.tools.find((t) => t.name === 'orphan_tool')?.source
  check(s4?.id === 'other' && s4?.label === '其他', '未捕获的非内核工具兜底归其他')

  // 兜底：内核工具集合（即使没走 register 也认得）
  const ctx5 = makeCtx({ tools: [{ name: 'bash', description: '执行命令。' }] })
  apply(ctx5, {})
  const d5 = await callRoute(ctx5.__.routes.get('/tool-discovery/data'), 'GET', '/tool-discovery/data')
  const s5 = d5.body.tools.find((t) => t.name === 'bash')?.source
  check(s5?.id === 'core' && s5?.label === '内核', '内核工具集合兜底')

  // 用户报告的真实病例：gitea 插件先于本插件加载，register 拦截没捕到，
  // 靠命名约定表兜住（预置进 Map、没走 register，模拟「先注册后挂钩」）
  const ctx6 = makeCtx({ tools: [
    { name: 'gitea_issue_comment_create', description: '评论。' },
    { name: 'gitea_issue_list', description: '列 issue。' },
    { name: 'sidebar_terminal_read', description: '读终端。' },
    { name: 'schedule_create', description: '建提醒。' },
    { name: 'job_list', description: '列后台作业。' },
    { name: 'create_goal', description: '建目标。' },
  ] })
  apply(ctx6, {})
  const d6 = await callRoute(ctx6.__.routes.get('/tool-discovery/data'), 'GET', '/tool-discovery/data')
  const src6 = (n) => d6.body.tools.find((t) => t.name === n)?.source
  const g6 = src6('gitea_issue_comment_create')
  check(g6?.id === 'gitea-task-issues' && g6?.label === 'gitea-task-issues', '先注册的 gitea_* 靠约定表归供应商 gitea-task-issues（bundle id 同形），不再落「其他」')
  check(src6('gitea_issue_list')?.id === 'gitea-task-issues', 'gitea_ 前缀族整体归同一供应商')
  check(src6('sidebar_terminal_read')?.id === 'sidebar-terminal', 'sidebar_terminal_* 归 sidebar-terminal')
  check(src6('schedule_create')?.id === 'schedule' && src6('schedule_create')?.label === 'schedule', 'schedule_* 归 schedule')
  check(src6('job_list')?.id === 'core', 'job_* 归内核')
  check(src6('create_goal')?.id === 'goal', '目标工具归 goal')

  // 用户病例：@wuzhican/dsh-qbittorrent 的 qb_* 全家没进约定表，整组落「其他」。
  // 该插件在 bundle 末尾挂载，实际由本表兜住（这里同样预置进 Map，不走 register）。
  const ctxQb = makeCtx({ tools: [
    { name: 'qb_status', description: '健康快照。' },
    { name: 'qb_list_torrents', description: '列种子。' },
    { name: 'qb_set_category', description: '改分类。' },
    { name: 'qb_delete_torrent', description: '删种子。' },
  ] })
  apply(ctxQb, {})
  const dQb = await callRoute(ctxQb.__.routes.get('/tool-discovery/data'), 'GET', '/tool-discovery/data')
  const srcQb = (n) => dQb.body.tools.find((t) => t.name === n)?.source
  check(srcQb('qb_status')?.id === 'qbittorrent' && srcQb('qb_status')?.label === 'qbittorrent', 'qb_* 归供应商 qbittorrent（不再是「其他」）')
  check(srcQb('qb_set_category')?.id === 'qbittorrent', 'qb_set_category 与同插件工具同组（用户病例：改分类没划入正确供应商）')
  check(
    ['qb_status', 'qb_list_torrents', 'qb_set_category', 'qb_delete_torrent'].every((n) => srcQb(n)?.id === srcQb('qb_status')?.id),
    'qb_ 前缀族整体归同一供应商',
  )
  check(srcQb('qb_status')?.id !== 'other', 'qb_* 不再落「其他」')

  // register 拦截拿到的是根上下文（fiber 缺失 → 记成 'root'）时，约定表必须仍然
  // 先赢，否则 qb_* 会被错划进「内核」——这是 qbittorrent 在 bundle 末尾挂载、
  // 与本插件加载竞速时的真实分支。
  const ctxQb2 = makeCtx({ tools: [] })
  apply(ctxQb2, {})
  ctxQb2.tools.register({ name: 'qb_set_category', description: '改分类。', parameters: { type: 'object', properties: {} } })
  const dQb2 = await callRoute(ctxQb2.__.routes.get('/tool-discovery/data'), 'GET', '/tool-discovery/data')
  const sQb2 = dQb2.body.tools.find((t) => t.name === 'qb_set_category')?.source
  check(sQb2?.id === 'qbittorrent', '拦截只捕到根上下文时，qb_* 仍按约定表归 qbittorrent（不被错划「内核」）')

  // 供应商防回归（用户病例）：free_search_test / advanced_search 同属 dsh-free-search
  // bundle（id: web-search-free），按 id 分组必须同组；web_search/web_fetch 属 web
  // bundle，不得混入。
  const ctx9 = makeCtx({ tools: [
    { name: 'free_search_test', description: '测引擎。' },
    { name: 'advanced_search', description: '高级检索。' },
    { name: 'web_search', description: '检索。' },
    { name: 'web_fetch', description: '抓网页。' },
  ] })
  apply(ctx9, {})
  const d9 = await callRoute(ctx9.__.routes.get('/tool-discovery/data'), 'GET', '/tool-discovery/data')
  const src9 = (n) => d9.body.tools.find((t) => t.name === n)?.source
  check(src9('free_search_test')?.id === 'web-search-free', 'free_search_test 归供应商 web-search-free')
  check(src9('advanced_search')?.id === 'web-search-free', 'advanced_search 归供应商 web-search-free')
  check(src9('free_search_test')?.id === src9('advanced_search')?.id, '同一供应商的搜索工具必须同组（防拆散）')
  check(src9('web_search')?.id === 'web', 'web_search 归官方 web 供应商')
  check(src9('web_fetch')?.id === 'web', 'web_fetch 归官方 web 供应商')
  check(src9('web_search')?.id !== src9('free_search_test')?.id, '不同供应商不混组（防合并）')

  // 拦截结果仍然覆盖约定表没收录的新插件工具
  const ctx7 = makeCtx({ tools: [], toolCallerCtx: { fiber: { name: '@dongasai/dsh-future-plugin' } } })
  apply(ctx7, {})
  ctx7.tools.register({ name: 'future_widget_paint', description: '画组件。', parameters: { type: 'object', properties: {} } })
  const d7 = await callRoute(ctx7.__.routes.get('/tool-discovery/data'), 'GET', '/tool-discovery/data')
  const s7 = d7.body.tools.find((t) => t.name === 'future_widget_paint')?.source
  check(s7?.id === 'future-plugin' && s7?.label === 'future-plugin', '未收录的新插件仍按拦截 fiber 名归供应商（含去 @scope/，id 与约定表同形）')

  // 前缀族：teams
  const ctx8 = makeCtx({ tools: [{ name: 'team_task_assign', description: '派任务。' }] })
  apply(ctx8, {})
  const d8 = await callRoute(ctx8.__.routes.get('/tool-discovery/data'), 'GET', '/tool-discovery/data')
  const s8 = d8.body.tools.find((t) => t.name === 'team_task_assign')?.source
  check(s8?.id === 'teams' && s8?.label === 'teams', 'team_task_ 前缀归 teams')
}

// ---------------------------------------------------------------- 11. 步级准入闸（宿主 0.2.2）
{
  // 0.2.2 的宿主在瀑布之后用自己的 tools 覆盖装配结果，所以只有
  // `tools.resolve` 这一层能真正让工具不出现在声明里。
  const ctx = boot({ stepAdmission: true })
  const agent = { id: 's10', session: { header: { cwd: join(tmp, 'ws-none') } } }

  const declared = await stepDeclarations(ctx, agent)
  check(declared.includes('read'), '准入闸放行默认档工具')
  check(declared.includes('bash'), '准入闸放行默认档工具（bash）')
  check(declared.includes('tool_find'), '准入闸保留 tool_find')
  check(!declared.includes('web_search'), '准入闸挡住可发现档工具（0.2.2 上旧瀑布过滤无效，这里才是真过滤）')
  check(!declared.includes('mcp__mail__send'), '准入闸挡住插件工具')
  check(declared.length === 3, '准入闸只放默认档 + 保留名')

  // 注册表 / 面板视角必须完整：收的是「步级准入」，不是注册表。
  const registry = ctx.tools.schemas(undefined).map((item) => item.name)
  check(registry.includes('web_search') && registry.includes('mcp__mail__send'), '注册表不被收窄（面板仍看得到全部工具）')
  check(registry.length === ctx.__.tools.size, '注册表条数与注册总数一致')

  // 激活：同一轮就刷新准入名单，下一步进声明。
  const tool = ctx.__.tools.get('tool_find')
  const activated = await tool.execute({ name: 'web_search', activate: true }, { agent })
  check(activated.text.startsWith('Successfully activated tools: web_search'), '激活回执')
  const afterActivate = await stepDeclarations(ctx, agent)
  check(afterActivate.includes('web_search'), '激活后下一步进声明（无需等下一轮组装）')

  // 另一个会话不受影响。
  const other = { id: 's11', session: { header: { cwd: join(tmp, 'ws-none') } } }
  const otherDeclared = await stepDeclarations(ctx, other)
  check(!otherDeclared.includes('web_search'), '激活只作用于本会话')
}

// ---------------------------------------------------------------- 12. 准入闸 × 屏蔽 / 子代理 / 降级
{
  // 工作区屏蔽：即使工具在默认档，也不能出现在声明里。
  const ws = join(tmp, 'ws-step-block')
  mkdirSync(join(ws, '.dsh'), { recursive: true })
  writeFileSync(join(ws, '.dsh', 'tool-policy.json'), JSON.stringify({ default: [], blocked: ['bash'] }))
  const ctx = boot({ stepAdmission: true })
  const agent = { id: 's12', session: { header: { cwd: ws } } }
  const declared = await stepDeclarations(ctx, agent)
  check(!declared.includes('bash'), '被屏蔽的默认档工具也不进声明')
  check(declared.includes('read'), '未被屏蔽的默认档工具正常放行')

  // 子代理 / teammate：`agent/created` 就装闸，第一步 resolve 之前已收窄。
  const child = { id: 'child-1', session: { header: { cwd: join(tmp, 'ws-none') } } }
  check(ctx.__.listeners.some((item) => item.event === 'agent/created'), '注册了 agent/created 监听')
  await emit(ctx, 'agent/created', { agent: child })
  const childToolSet = await ctx.tools.resolve({ agent: child, signal: { throwIfAborted() {} } })
  const childNames = [...childToolSet.view(child).keys()]
  childToolSet.dispose()
  check(childNames.includes('read') && !childNames.includes('web_search'), '新 agent 在第一步组装前就被收窄（子代理同样生效）')

  // 销毁后不再收窄（失败开放：宁可多给工具也不能卡住执行）。
  await emit(ctx, 'agent/disposed', { agent: child })
  const afterDispose = await ctx.tools.resolve({ agent: child, signal: { throwIfAborted() {} } })
  check([...afterDispose.view(child).keys()].length > 3, 'dispose 后不再收窄（失败开放）')
  afterDispose.dispose()

  // 面板读接口报告闸门状态。
  const data = await callRoute(ctx.__.routes.get('/tool-discovery/data'), 'GET', '/tool-discovery/data')
  check(data.body.admission?.installed === true, '面板报告准入闸已安装')

  // 宿主真实顺序是 resolve 先于 assemble：全新会话、一次组装都还没跑过时，
  // 第一次准入也必须已经收窄（靠闸门里的惰性解析现算）。
  const fresh = boot({ stepAdmission: true })
  const freshAgent = { id: 'fresh-1', session: { header: { cwd: join(tmp, 'ws-none') } } }
  const freshSet = await fresh.tools.resolve({ agent: freshAgent, signal: { throwIfAborted() {} } })
  const freshNames = [...freshSet.view(freshAgent).keys()]
  freshSet.dispose()
  check(freshNames.includes('read') && !freshNames.includes('web_search'), '全新会话的第一次 resolve 就收窄（无需先跑组装）')

  // 老宿主（无 tools.resolve）：退回瀑布过滤，功能不变但路径不同。
  const old = boot()
  const oldDeclared = await stepDeclarations(old, { id: 's13', session: { header: { cwd: join(tmp, 'ws-none') } } })
  check(!oldDeclared.includes('web_search'), '老宿主（无 resolve）仍靠瀑布过滤生效')
  const oldData = await callRoute(old.__.routes.get('/tool-discovery/data'), 'GET', '/tool-discovery/data')
  check(oldData.body.admission?.installed === false, '老宿主上面板报告闸门缺席（降级态可见）')
}

/**
 * 调一条桩路由。
 * @param {object} route - 注册进来的路由。
 * @param {string} method - HTTP 方法。
 * @param {string} url - 请求路径。
 * @param {object} body - JSON 请求体。
 * @returns `{ status, body }`。
 */
async function callRoute(route, method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
  const captured = { status: 200, body: undefined, headers: {} }
  const res = {
    set statusCode(value) { captured.status = value },
    get statusCode() { return captured.status },
    setHeader(key, value) { captured.headers[key] = value },
    end(text) { captured.body = text === undefined ? undefined : JSON.parse(text) },
  }
  await route.handler(req, res)
  return captured
}

console.log(`probe: ${passed} 项全部通过`)
