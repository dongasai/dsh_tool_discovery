/**
 * @module @dongasai/dsh-tool-discovery
 *
 * **工具发现 —— Host 半边**：把模型直接看到的工具面收缩成「默认可用」一档，
 * 其余工具只在系统提示词里留一行索引（名字 + 一句话），由 `tool_find` 查到、
 * 激活后才进模型声明；另有一档「屏蔽」既不列索引也拒绝执行。
 *
 * ## 三档
 *
 * - `default`：完整 schema 进模型声明，可直接调用。
 * - `discoverable`：不进声明，只有一行索引；`tool_find` 命中后可激活。
 * - `blocked`：不进声明、不进索引、`tool_find` 不返回，执行被 guard 拒绝。
 *
 * ## 策略三层（高 → 低）
 *
 * 1. 屏蔽：全局 `blockedTools` ∪ 工作区 `blocked`（工作区只能加不能解）。
 * 2. 默认：会话激活 ∪ 工作区 `default` ∪ 全局 `defaultTools`。
 * 3. 其余：一律 `discoverable`。
 *
 * 全局策略有两份来源：插件配置（`cordis.patch.yml` 的 `config`）与
 * `$DSH_HOME/tool-discovery/global.json`（面板写入，覆盖配置）；工作区策略读
 * `<workspace>/<workspacePolicyFile>`。
 *
 * ## 三条实现约束
 *
 * 1. **视图过滤走 `system-prompt/assemble` 瀑布**：只删「模型能看到什么」，
 *    不动注册表；这样激活只需把名字从隐藏集里拿掉。
 * 2. **屏蔽必须再叠 guard**：瀑布改不了执行解析，否则模型照样能调。
 * 3. **策略读取是同步的**：guard 是同步函数，所以策略文件按 (mtime,size) 缓存后
 *    用 `readFileSync` 读——一次 statSyscall 换一致性，代价可忽略。
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'tool-discovery'

/** 硬依赖：工具表、提示词、agent 目录、路由载体、信任围栏、工作区登记。 */
export const inject = [
  'tools',
  'systemPrompt',
  'agents',
  'webServer',
  'connection',
  'workspaceRegistry',
]

/** 本插件自己注册的发现工具名。 */
const TOOL_FIND = 'tool_find'

/** 永远不进过滤的保留工具名（`run_code` 是 PTC 传输层，删掉整条链路就废了）。 */
const RESERVED = new Set([TOOL_FIND, 'run_code'])

/** 索引段落在提示词里的名字。 */
const INDEX_SECTION = 'tool-discovery:index'

/** 全局策略文件名（落在 `$DSH_HOME/tool-discovery/` 下）。 */
const GLOBAL_FILE = 'global.json'

/** 数据路由前缀。 */
const ROUTE_PREFIX = '/tool-discovery'

/** 默认配置；`cordis.patch.yml` 的同名字段逐个覆盖。 */
const DEFAULT_CONFIG = {
  defaultTools: [
    'read', 'write', 'edit', 'glob', 'grep', 'bash',
    'todo_write', 'ask_user_question', 'skill', 'present', 'read_image', TOOL_FIND,
  ],
  blockedTools: [],
  indexBudgetChars: 4000,
  summaryChars: 80,
  workspacePolicyFile: '.dsh/tool-policy.json',
}

/**
 * 插件正文：注册索引段落、assemble 瀑布、屏蔽 guard、`tool_find` 与两条面板路由。
 * @param ctx - Host 上下文。
 * @param config - `cordis.patch.yml` 里的插件配置。
 */
export function apply(ctx, config = {}) {
  const base = normalizeConfig(config)

  /** 会话级激活集合：`sessionId → Set<toolName>`。 */
  const activations = new Map()

  /** 全局策略缓存：`{ stamp, value }`。 */
  let globalCache = { stamp: '', value: undefined }

  /** 工作区策略缓存：`绝对路径 → { stamp, value }`。 */
  const workspaceCache = new Map()

  const globalFilePath = join(dshHome(), 'tool-discovery', GLOBAL_FILE)

  // ---------------------------------------------------------------- 来源自动感知

  /**
   * toolName → 注册方插件名（取自注册时调用方 `ctx.fiber.name`）。
   * 由 {@link hookRegisterSource} 拦截 `ctx.tools.register` 填充；
   * 插件加载早于本插件时那些工具不在表里，靠 {@link sourceOf} 的兜底分支处理。
   */
  const sourceMap = new Map()

  const unhookRegister = hookRegisterSource(ctx, sourceMap)
  ctx.effect(() => unhookRegister, 'tool-discovery: register source hook')

  /**
   * 自动判定一个工具的来源分组。
   *
   * 优先级：MCP 命名规则（`mcp__server__tool`）＞ register 拦截捕获的插件名 ＞
   * 已知内核工具集合 ＞ 其他。
   *
   * MCP 优先于拦截结果：MCP 工具虽然由 mcp-client 插件统一注册，但按服务器
   * 分组比按插件名分组更有用。
   *
   * @param name - 工具名。
   * @returns `{ id, kind, label, server? }`。
   */
  function sourceOf(name) {
    const mcp = MCP_NAME.exec(name)
    if (mcp !== null) {
      const server = mcp[1]
      return { id: 'mcp:' + server, kind: 'mcp', server, label: 'MCP · ' + server }
    }
    const plugin = sourceMap.get(name)
    if (typeof plugin === 'string' && plugin !== '') {
      if (plugin === 'root' || plugin.startsWith('tool-')) return { id: 'core', kind: 'local', label: '内核' }
      return { id: 'plugin:' + plugin, kind: 'local', label: prettifyName(plugin) }
    }
    if (CORE_TOOLS.has(name)) return { id: 'core', kind: 'local', label: '内核' }
    return { id: 'other', kind: 'local', label: '其他' }
  }

  // ---------------------------------------------------------------- 策略读取

  /**
   * 读全局策略：磁盘文件覆盖插件配置；文件不存在时就是配置本身。
   * @returns 归一化后的全局策略。
   */
  function readGlobal() {
    const stamp = stampOf(globalFilePath)
    if (globalCache.stamp === stamp && globalCache.value !== undefined) return globalCache.value
    const disk = readJsonFile(globalFilePath)
    const value = normalizeGlobal(disk, base)
    globalCache = { stamp, value }
    return value
  }

  /**
   * 读工作区策略。没有工作区路径或文件不存在时返回空策略。
   * @param workspacePath - 工作区根目录；缺省表示没有工作区。
   * @returns 归一化后的工作区策略。
   */
  function readWorkspace(workspacePath) {
    if (workspacePath === undefined || workspacePath === '') return EMPTY_WORKSPACE
    const file = join(workspacePath, base.workspacePolicyFile)
    const stamp = stampOf(file)
    const cached = workspaceCache.get(file)
    if (cached !== undefined && cached.stamp === stamp) return cached.value
    const value = normalizeWorkspace(readJsonFile(file))
    workspaceCache.set(file, { stamp, value })
    return value
  }

  /**
   * 解析一个 agent 的工作区目录：会话 header 的 cwd 直接当根，登记表只做校验兜底。
   * @param agent - 目标 agent，可为空（全局视图）。
   * @returns 规范化的工作区路径，或 `undefined`。
   */
  function workspacePathOf(agent) {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return undefined
    try {
      const hit = ctx.workspaceRegistry.list().find((item) => item.path === cwd)
      if (hit !== undefined) return hit.path
    } catch {
      /* 登记表不可用时退化成「按 cwd 找策略文件」。 */
    }
    return cwd
  }

  /**
   * 把三层策略合成一个按工具名判档的视图。
   * @param agent - 目标 agent，可为空（全局视图）。
   * @returns `{ bucketOf, budgetChars, summaryChars, workspacePath, ...各层原始值 }`。
   */
  function policyFor(agent) {
    const global = readGlobal()
    const workspacePath = workspacePathOf(agent)
    const workspace = readWorkspace(workspacePath)
    const sessionId = agent?.id === undefined ? undefined : String(agent.id)
    const activated = sessionId === undefined ? EMPTY_SET : activations.get(sessionId) ?? EMPTY_SET
    const blocked = new Set([...global.blockedTools, ...workspace.blocked])
    const defaults = new Set([...global.defaultTools, ...workspace.default])
    return {
      global,
      workspace,
      workspacePath,
      activated,
      bucketOf(toolName) {
        if (blocked.has(toolName)) return 'blocked'
        if (activated.has(toolName)) return 'default'
        if (defaults.has(toolName)) return 'default'
        return 'discoverable'
      },
      budgetChars: workspace.indexBudgetChars ?? global.indexBudgetChars,
      summaryChars: workspace.summaryChars ?? global.summaryChars,
    }
  }

  // ---------------------------------------------------------------- 提示词注入

  /** 索引段落位置：排在工具 SDK 段落之前（拿不到就退到 4999）。 */
  let indexOrder = 4999
  try {
    indexOrder = ctx.systemPrompt.getSectionOrder('TOOLS_SDK') - 1
  } catch {
    /* 旧核心没有段落目录，用固定值。 */
  }

  ctx.effect(() => ctx.systemPrompt.section({
    name: INDEX_SECTION,
    order: indexOrder,
    text: (assembleContext) => {
      try {
        return buildIndex(assembleContext?.agent ?? assembleContext?.scope)
      } catch {
        return ''
      }
    },
  }), 'tool-discovery: index section')

  /**
   * 现算一条 agent 的可发现工具索引文本。
   * @param agent - 当前组装的 agent，可为空。
   * @returns 索引段落文本；没有可发现工具时为空串（段落自动消失）。
   */
  function buildIndex(agent) {
    if (agent === undefined || agent === null) return ''
    const policy = policyFor(agent)
    let schemas
    try {
      schemas = ctx.tools.schemas(agent)
    } catch {
      return ''
    }
    const rows = []
    for (const schema of schemas) {
      if (RESERVED.has(schema.name)) continue
      if (policy.bucketOf(schema.name) !== 'discoverable') continue
      rows.push({ name: schema.name, summary: summarize(schema.description, policy.summaryChars) })
    }
    if (rows.length === 0) return ''
    rows.sort((a, b) => a.name.localeCompare(b.name))

    const header = [
      '<available-tools-index>',
      '下面这些工具没有默认加载，模型看不到它们的完整定义。需要时先调 tool_find（query 或 name），',
      '确认后带 activate:true 再调一次，工具就会出现在你的声明里。',
    ].join('\n')
    const footer = '</available-tools-index>'
    const budget = policy.budgetChars
    const packed = packRows(rows, budget - header.length - footer.length, true)
    // 预算紧到连一条带摘要的行都放不下时，退成「只有名字」的行；再放不下就只报数量。
    const fallback = packed.lines.length === 0 ? packRows(rows, budget - header.length - footer.length, false) : packed
    const chosen = packed.lines.length === 0 ? fallback : packed
    if (chosen.lines.length === 0) {
      return [header, `（本工作区可发现工具 ${rows.length} 个，索引预算 ${budget} 字符列不下；用 tool_find 按关键词检索。）`, footer].join('\n')
    }
    const tail = chosen.omitted > 0
      ? [`（还有 ${chosen.omitted} 个未列出，用 tool_find 按关键词检索。）`, footer]
      : [footer]
    return [header, ...chosen.lines, ...tail].join('\n')
  }

  // ---------------------------------------------------------------- 视图过滤

  ctx.on('system-prompt/assemble', async (assembly, assembleContext, next) => {
    const result = await next()
    const agent = assembleContext?.agent ?? assembleContext?.scope
    if (agent === undefined || agent === null) return result
    // 失败开放：策略算不出来时保持原样，宁可多给工具也不能让整轮组装失败。
    try {
      const policy = policyFor(agent)
      const kept = []
      for (const schema of result.tools ?? []) {
        if (RESERVED.has(schema.name)) {
          kept.push(schema)
          continue
        }
        if (policy.bucketOf(schema.name) === 'default') kept.push(schema)
      }
      result.tools = kept
    } catch {
      /* 保持 result 原样 */
    }
    return result
  })

  // ---------------------------------------------------------------- 执行闸

  ctx.tools.guard((execution) => {
    const agent = execution.agent
    if (agent === undefined || agent === null) return undefined
    try {
      if (policyFor(agent).bucketOf(execution.name) !== 'blocked') return undefined
      return `工具 ${execution.name} 在当前工作区被屏蔽（dsh-tool-discovery）。`
    } catch {
      return undefined
    }
  })

  // ---------------------------------------------------------------- tool_find

  ctx.tools.register({
    name: TOOL_FIND,
    description:
      'Discover tools that are not loaded by default. Every tool the model does not see is listed ' +
      'in <available-tools-index> with a one-line summary; call tool_find with a name fragment or a ' +
      'plain-language intent to inspect matches, then call it again with activate:true to load the ' +
      'tool into your declaration. Blocked tools never appear here.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Name fragment or natural-language intent, e.g. "mail" or "管理定时提醒".',
        },
        name: {
          type: 'string',
          description: 'Exact tool name; takes precedence over query.',
        },
        activate: {
          type: 'boolean',
          description: 'Load the matched tool (exact `name`, or the only match) into this session.',
        },
        limit: {
          type: 'number',
          description: 'Maximum matches to return (default 10, clamped to 20).',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: value.text }]
      },
    },
    async execute(args, execution) {
      const agent = execution.agent
      if (agent === undefined || agent === null) throw new Error('tool_find 只能在 agent 会话里调用')
      const policy = policyFor(agent)
      const candidates = discoverableSchemas(agent, policy)
      const wanted = typeof args.name === 'string' && args.name !== '' ? args.name : undefined
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (wanted === undefined && query === '') throw new Error('tool_find 需要 query 或 name')
      const limit = clamp(Number(args.limit) || 10, 1, 20)
      const matches = wanted === undefined
        ? rank(candidates, query).slice(0, limit)
        : candidates.filter((item) => item.name === wanted)

      if (matches.length === 0) {
        return { text: `Not found: ${wanted ?? query}（可发现工具外的东西不会出现在这里）` }
      }

      if (args.activate === true) {
        const target = wanted !== undefined ? matches[0] : (matches.length === 1 ? matches[0] : undefined)
        if (target === undefined) {
          return { text: `需要更精确的 name：${matches.map((item) => item.name).join(' / ')}` }
        }
        const sessionId = String(agent.id)
        const set = activations.get(sessionId) ?? new Set()
        set.add(target.name)
        activations.set(sessionId, set)
        return { text: `Successfully activated tools: ${target.name}\n${target.name} — ${target.summary}` }
      }

      const lines = [`Matched ${matches.length} discoverable tool(s)：`]
      for (const item of matches) lines.push(`- ${item.name} — ${item.summary}`)
      lines.push('带 activate:true 再调一次即可加载（name 精确指定）。')
      return { text: lines.join('\n') }
    },
  })

  /**
   * 当前 agent 可见、且落在「可发现」档的工具。
   * @param agent - 目标 agent。
   * @param policy - 该 agent 的合成策略。
   * @returns `[{ name, summary, description }]`，按名字排序。
   */
  function discoverableSchemas(agent, policy) {
    let schemas = []
    try {
      schemas = ctx.tools.schemas(agent)
    } catch {
      schemas = []
    }
    const rows = []
    for (const schema of schemas) {
      if (RESERVED.has(schema.name)) continue
      if (policy.bucketOf(schema.name) !== 'discoverable') continue
      rows.push({
        name: schema.name,
        summary: summarize(schema.description, policy.summaryChars),
        description: typeof schema.description === 'string' ? schema.description : '',
      })
    }
    rows.sort((a, b) => a.name.localeCompare(b.name))
    return rows
  }

  // ---------------------------------------------------------------- 面板路由

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/data`,
    handler: (req, res) => handleData(req, res),
  }), `tool-discovery: GET ${ROUTE_PREFIX}/data`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/policy`,
    handler: (req, res) => handlePolicy(req, res),
  }), `tool-discovery: POST ${ROUTE_PREFIX}/policy`)

  /**
   * 面板读接口：给一段工具表（含档位）与两层策略原文，供两个面板渲染。
   * @param req - 传入请求。
   * @param res - 应答对象。
   * @returns 应答写完即返回。
   */
  async function handleData(req, res) {
    if (rejectUntrusted(req, res)) return
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    const url = new URL(req.url ?? `${ROUTE_PREFIX}/data`, 'http://tool-discovery.local')
    const sessionId = url.searchParams.get('sessionId') ?? undefined
    const explicitWorkspace = url.searchParams.get('workspacePath') ?? undefined
    try {
      const agent = sessionId === undefined ? undefined : ctx.agents.get(sessionId)
      const workspacePath = explicitWorkspace ?? workspacePathOf(agent)
      const policy = agent === undefined && explicitWorkspace === undefined
        ? policyForGlobal()
        : policyForAgentOrPath(agent, workspacePath)
      // 工具全集：全局视图 + 每个活 agent 的可见表。agent preset 把文件工具挂在
      // agent 作用域上，只看全局视图会漏掉一大半，面板也就编辑不到它们。
      const universe = new Map()
      const collect = (scopeAgent) => {
        let schemas = []
        try {
          schemas = ctx.tools.schemas(scopeAgent)
        } catch {
          schemas = []
        }
        for (const schema of schemas) {
          if (!universe.has(schema.name)) universe.set(schema.name, schema)
        }
      }
      collect(undefined)
      let liveSessions = []
      try {
        liveSessions = ctx.agents.list().map((item) => ({
          id: String(item.id),
          cwd: typeof item.session?.header?.cwd === 'string' ? item.session.header.cwd : null,
        }))
      } catch {
        liveSessions = []
      }
      for (const session of liveSessions) {
        const liveAgent = ctx.agents.get(session.id)
        if (liveAgent !== undefined) collect(liveAgent)
      }
      const tools = [...universe.values()]
        .map((schema) => ({
          name: schema.name,
          bucket: policy.bucketOf(schema.name),
          summary: summarize(schema.description, policy.summaryChars),
          source: sourceOf(schema.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
      sendJson(res, 200, {
        ok: true,
        sessionId: sessionId ?? null,
        workspacePath: workspacePath ?? null,
        workspaces: listWorkspaces(),
        sessions: liveSessions,
        global: {
          defaultTools: [...policy.global.defaultTools],
          blockedTools: [...policy.global.blockedTools],
          indexBudgetChars: policy.global.indexBudgetChars,
          summaryChars: policy.global.summaryChars,
        },
        workspace: {
          default: [...policy.workspace.default],
          blocked: [...policy.workspace.blocked],
          indexBudgetChars: policy.workspace.indexBudgetChars ?? null,
        },
        counts: {
          total: tools.length,
          default: tools.filter((tool) => tool.bucket === 'default').length,
          discoverable: tools.filter((tool) => tool.bucket === 'discoverable').length,
          blocked: tools.filter((tool) => tool.bucket === 'blocked').length,
        },
        tools,
      })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: 'collect-failed', message: messageOf(error) })
    }
  }

  /**
   * 面板写接口：保存全局或某一个工作区的策略文件，并作废旧缓存戳。
   * @param req - 传入请求。
   * @param res - 应答对象。
   * @returns 应答写完即返回。
   */
  async function handlePolicy(req, res) {
    if (rejectUntrusted(req, res)) return
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    try {
      const body = await readBody(req)
      const scope = body?.scope
      if (scope !== 'global' && scope !== 'workspace') {
        return sendJson(res, 400, { ok: false, error: 'bad-scope', message: "scope 只能是 'global' 或 'workspace'" })
      }
      const value = scope === 'global'
        ? normalizeGlobal(body.value, base)
        : normalizeWorkspace(body.value)
      const file = scope === 'global'
        ? globalFilePath
        : policyFileFor(body.workspacePath)
      if (file === undefined) {
        return sendJson(res, 400, { ok: false, error: 'missing-workspace', message: '工作区策略需要 workspacePath' })
      }
      writeJsonAtomic(file, serializePolicy(scope, value))
      globalCache = { stamp: '', value: undefined }
      workspaceCache.delete(file)
      sendJson(res, 200, { ok: true, scope, path: file })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: 'write-failed', message: messageOf(error) })
    }
  }

  /**
   * 没有会话时的策略视图：只有全局层。
   * @returns 只有 `global` 的策略对象，`workspace` 为空。
   */
  function policyForGlobal() {
    const global = readGlobal()
    const blocked = new Set(global.blockedTools)
    const defaults = new Set(global.defaultTools)
    return {
      global,
      workspace: EMPTY_WORKSPACE,
      bucketOf(toolName) {
        if (blocked.has(toolName)) return 'blocked'
        if (defaults.has(toolName)) return 'default'
        return 'discoverable'
      },
      budgetChars: global.indexBudgetChars,
      summaryChars: global.summaryChars,
    }
  }

  /**
   * 面板显式指定工作区（未必有活会话）时的策略视图。
   * @param agent - 会话对应 agent，可为空。
   * @param workspacePath - 显式工作区路径，可为空。
   * @returns 合成后的策略对象。
   */
  function policyForAgentOrPath(agent, workspacePath) {
    if (agent !== undefined) return policyFor(agent)
    const global = readGlobal()
    const workspace = readWorkspace(workspacePath)
    const blocked = new Set([...global.blockedTools, ...workspace.blocked])
    const defaults = new Set([...global.defaultTools, ...workspace.default])
    return {
      global,
      workspace,
      bucketOf(toolName) {
        if (blocked.has(toolName)) return 'blocked'
        if (defaults.has(toolName)) return 'default'
        return 'discoverable'
      },
      budgetChars: workspace.indexBudgetChars ?? global.indexBudgetChars,
      summaryChars: workspace.summaryChars ?? global.summaryChars,
    }
  }

  /**
   * 工作区登记表 → 面板下拉项。
   * @returns `[{ id, path, title }]`。
   */
  function listWorkspaces() {
    try {
      return ctx.workspaceRegistry.list().map((item) => ({ id: String(item.id), path: item.path, title: item.title }))
    } catch {
      return []
    }
  }

  /**
   * 工作区策略文件绝对路径。
   * @param workspacePath - 工作区根目录。
   * @returns 路径；缺省时 `undefined`。
   */
  function policyFileFor(workspacePath) {
    if (typeof workspacePath !== 'string' || workspacePath === '') return undefined
    return join(workspacePath, base.workspacePolicyFile)
  }

  /**
   * 信任围栏：不可信来源直接 403，返回 `true` 表示已经应答。
   * @param req - 传入请求。
   * @param res - 应答对象。
   * @returns 是否已经应答。
   */
  function rejectUntrusted(req, res) {
    let rejection
    try {
      rejection = ctx.connection.requestRejection(req)
    } catch {
      rejection = 403
    }
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }
}

// ------------------------------------------------------------------ 纯函数

/** 空工作区策略（冻结，避免调用方改到常量）。 */
const EMPTY_WORKSPACE = Object.freeze({
  default: Object.freeze([]),
  blocked: Object.freeze([]),
  indexBudgetChars: undefined,
  summaryChars: undefined,
})

/** 空集合常量。 */
const EMPTY_SET = new Set()

/** MCP 工具命名规则：`mcp__server__tool`。 */
const MCP_NAME = /^mcp__([\s\S]+?)__([\s\S]+)$/

/** 已知内核工具（register 拦截未捕获时的兜底，避免误归「其他」）。 */
const CORE_TOOLS = new Set([
  'read', 'write', 'edit', 'glob', 'grep', 'bash', 'todo_write',
  'ask_user_question', 'skill', 'present', 'read_image', 'run_code', TOOL_FIND,
])

/** register 拦截标记，防止 HMR 重载时重复打补丁。 */
const HOOK_MARK = Symbol('tool-discovery:register-hook')

/**
 * 把插件名美化成分组标签：去掉 `dsh-` 前缀，其余原样。
 * @param plugin - fiber.name（如 `dsh-sidebar-terminal`）。
 * @returns 标签（如 `sidebar-terminal`）。
 */
function prettifyName(plugin) {
  return plugin.startsWith('dsh-') ? plugin.slice(4) : plugin
}

/**
 * 拦截 `ctx.tools.register`，把每次注册的调用方插件名记进 sourceMap。
 *
 * 利用 Cordis traceable 机制：方法被调用时 `this.ctx` 指向调用方上下文，
 * `this.ctx.fiber.name` 即注册方插件名。`tool-*` 是第一方工具插件的命名
 * 约定，`root` 是无具名插件的根上下文——两者都归「内核」。
 *
 * 沿原型链查找 `register` 的定义点：真实 Cordis 落在 `ToolRuntime.prototype`，
 * 探针桩落在 `ctx.tools` 自身。打补丁后用 `ctx.effect` 注册还原钩子。
 *
 * @param ctx - Host 上下文。
 * @param sourceMap - 写入目标（`toolName → pluginName`）。
 * @returns 卸载钩子（还原原始 register）。
 */
function hookRegisterSource(ctx, sourceMap) {
  let holder = ctx.tools
  let original = null
  while (holder !== null && holder !== undefined) {
    const desc = Object.getOwnPropertyDescriptor(holder, 'register')
    if (desc !== undefined && typeof desc.value === 'function') {
      original = desc.value
      break
    }
    holder = Object.getPrototypeOf(holder)
  }
  if (original === null) return () => {}
  if (original[HOOK_MARK] === true) return () => {}
  const hooked = function register(definition) {
    const disposer = original.call(this, definition)
    try {
      const callerCtx = this?.ctx
      const fiber = callerCtx?.fiber
      const fname = typeof fiber?.name === 'string' && fiber.name !== '' ? fiber.name : 'root'
      sourceMap.set(definition.name, fname)
    } catch { /* 来源捕获失败不影响注册本身 */ }
    return disposer
  }
  Object.defineProperty(hooked, HOOK_MARK, { value: true })
  Object.defineProperty(holder, 'register', {
    value: hooked, writable: true, configurable: true, enumerable: false,
  })
  return () => {
    try {
      Object.defineProperty(holder, 'register', {
        value: original, writable: true, configurable: true, enumerable: false,
      })
    } catch { /* 还原失败忽略 */ }
  }
}

/**
 * 归一化插件配置。
 * @param config - 原始配置。
 * @returns 补齐默认值的配置。
 */
function normalizeConfig(config) {
  return {
    defaultTools: stringList(config?.defaultTools, DEFAULT_CONFIG.defaultTools),
    blockedTools: stringList(config?.blockedTools, DEFAULT_CONFIG.blockedTools),
    indexBudgetChars: positiveInt(config?.indexBudgetChars, DEFAULT_CONFIG.indexBudgetChars),
    summaryChars: positiveInt(config?.summaryChars, DEFAULT_CONFIG.summaryChars),
    workspacePolicyFile: typeof config?.workspacePolicyFile === 'string' && config.workspacePolicyFile !== ''
      ? config.workspacePolicyFile
      : DEFAULT_CONFIG.workspacePolicyFile,
  }
}

/**
 * 全局策略 = 插件配置打底、磁盘文件覆盖。
 * @param disk - 磁盘上的全局策略。
 * @param base - 归一化后的插件配置。
 * @returns `{ defaultTools: Set, blockedTools: Set, indexBudgetChars, summaryChars }`。
 */
function normalizeGlobal(disk, base) {
  const source = isRecord(disk) ? disk : {}
  return {
    defaultTools: new Set(stringList(source.defaultTools, [...base.defaultTools])),
    blockedTools: new Set(stringList(source.blockedTools, [...base.blockedTools])),
    indexBudgetChars: positiveInt(source.indexBudgetChars, base.indexBudgetChars),
    summaryChars: positiveInt(source.summaryChars, base.summaryChars),
  }
}

/**
 * 工作区策略：只保留增量（默认发放 / 追加屏蔽 / 预算覆盖）。
 * @param disk - 磁盘上的工作区策略。
 * @returns `{ default: string[], blocked: string[], indexBudgetChars, summaryChars }`。
 */
function normalizeWorkspace(disk) {
  const source = isRecord(disk) ? disk : {}
  return {
    default: stringList(source.default, []),
    blocked: stringList(source.blocked, []),
    indexBudgetChars: optionalPositiveInt(source.indexBudgetChars),
    summaryChars: optionalPositiveInt(source.summaryChars),
  }
}

/**
 * 落盘前的序列化：Set 变数组，未覆盖的预算字段不写。
 * @param scope - `global` 或 `workspace`。
 * @param value - 归一化后的策略。
 * @returns 可直接 `JSON.stringify` 的对象。
 */
function serializePolicy(scope, value) {
  if (scope === 'global') {
    return {
      defaultTools: [...value.defaultTools],
      blockedTools: [...value.blockedTools],
      indexBudgetChars: value.indexBudgetChars,
      summaryChars: value.summaryChars,
    }
  }
  return {
    default: value.default,
    blocked: value.blocked,
    ...(value.indexBudgetChars === undefined ? {} : { indexBudgetChars: value.indexBudgetChars }),
    ...(value.summaryChars === undefined ? {} : { summaryChars: value.summaryChars }),
  }
}

/**
 * 按预算打包索引行。
 * @param rows - `[{ name, summary }]`。
 * @param budget - 留给索引行的字符预算。
 * @param withSummary - 是否带一句话摘要；`false` 时只写名字。
 * @returns `{ lines, omitted }`。
 */
function packRows(rows, budget, withSummary) {
  const lines = []
  let used = 0
  let omitted = 0
  for (const row of rows) {
    const line = withSummary ? `- ${row.name} — ${row.summary}` : `- ${row.name}`
    if (used + line.length + 1 > budget) {
      omitted += 1
      continue
    }
    lines.push(line)
    used += line.length + 1
  }
  return { lines, omitted }
}

/**
 * 把 `description` 压成一句话：取首句，超长截断并补省略号。
 * @param description - 工具说明。
 * @param maxChars - 上限。
 * @returns 一句话摘要。
 */
function summarize(description, maxChars) {
  const text = typeof description === 'string' ? description.trim().replace(/\s+/g, ' ') : ''
  if (text === '') return '（无说明）'
  const sentence = text.split(/(?<=[。.!?！？；;])\s*/)[0] ?? text
  if (sentence.length <= maxChars) return sentence
  return `${sentence.slice(0, Math.max(1, maxChars - 1))}…`
}

/**
 * 按名字/说明给候选工具打分排序。
 * @param candidates - `[{ name, summary, description }]`。
 * @param query - 查询串。
 * @returns 命中的候选，按分数降序、名字升序。
 */
function rank(candidates, query) {
  const needle = query.toLowerCase()
  const scored = []
  for (const item of candidates) {
    const name = item.name.toLowerCase()
    let score = 0
    if (name === needle) score = 1000
    else if (name.startsWith(needle)) score = 500
    else if (name.includes(needle)) score = 200
    else if (item.summary.toLowerCase().includes(needle)) score = 80
    else if (item.description.toLowerCase().includes(needle)) score = 40
    if (score > 0) scored.push({ ...item, score })
  }
  scored.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name))
  return scored
}

/** `$DSH_HOME`（缺省 `~/.dsh`）。 */
function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  return join(homedir(), '.dsh')
}

/**
 * 读一个 JSON 文件；不存在或坏掉都当空对象。
 * @param file - 绝对路径。
 * @returns 解析结果或 `undefined`。
 */
function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 文件戳：`mtime:size`；不存在为 `missing`。
 * @param file - 绝对路径。
 * @returns 戳字符串。
 */
function stampOf(file) {
  try {
    const stat = statSync(file)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'missing'
  }
}

/**
 * 原子写 JSON：先写临时文件再 rename，避免读到半个文件。
 * @param file - 目标路径。
 * @param value - 可序列化对象。
 * @returns 无。
 */
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}

/**
 * 读请求体并解析 JSON。
 * @param req - 传入请求。
 * @returns 解析后的对象；空体返回 `{}`。
 */
async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

/**
 * 写一份 JSON 应答。
 * @param res - 应答对象。
 * @param status - HTTP 状态码。
 * @param body - 可序列化应答体。
 * @returns 无。
 */
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * 取错误的可读信息。
 * @param error - 任意抛出物。
 * @returns 文本。
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 是否为普通对象。 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 字符串数组归一化：丢掉非字符串与空串，可去重。
 * @param value - 原始值。
 * @param fallback - 不是数组时的回退。
 * @returns 去重后的字符串数组。
 */
function stringList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  const seen = new Set()
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * 正整数归一化。
 * @param value - 原始值。
 * @param fallback - 非法时的回退。
 * @returns 合法正整数或回退。
 */
function positiveInt(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * 可选正整数。
 * @param value - 原始值。
 * @returns 合法正整数，否则 `undefined`。
 */
function optionalPositiveInt(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

/**
 * 数值夹取。
 * @param value - 原始值。
 * @param min - 下限。
 * @param max - 上限。
 * @returns 夹取后的整数。
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.floor(value)))
}
