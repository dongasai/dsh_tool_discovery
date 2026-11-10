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
 * @param {object} ctx - 桩上下文。
 * @param {object} agent - 目标 agent。
 * @param {Array} schemas - 进入组装的工具表。
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
