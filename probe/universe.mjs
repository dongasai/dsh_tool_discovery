/**
 * 真实工具全集的分组模拟（确定性核查，不是单测）。
 *
 * 数据来源：
 *   - `probe/universe-tools.json`（快照，来自会话提示词 `<available-tools-index>`
 *     与各插件源码里核实过的注册名；新增插件工具时往这个文件补名字）；
 *   - 缺省内核工具（`read`/`bash`/…）在脚本里补齐，避免快照漏项。
 *
 * 模拟「全部工具都先于本插件注册」的最坏情形（register 拦截一个都捕不到），
 * 调真实的面板路由打印分组结果，看哪些工具仍会落「其他」。重启 dsh web 后
 * 面板看到的就是这个分组。
 *
 * 用法：node probe/universe.mjs
 */
import { apply } from '../index.js'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 桩 ctx：只给面板路由需要的最小面，工具全集预置、不模拟 register 捕获。 */
function makeCtx(tools) {
  const routes = new Map()
  return {
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on() { return () => {} },
    tools: {
      register(definition) { tools.set(definition.name, definition); return () => {} },
      guard() { return () => {} },
      schemas: () => [...tools.values()].map((t) => ({
        name: t.name, description: t.description, parameters: { type: 'object', properties: {} },
      })),
    },
    systemPrompt: { section() { return () => {} }, getSectionOrder() { return 5000 } },
    agents: { get() { return undefined }, list() { return [] } },
    webServer: { register(r) { routes.set(r.path, r); return () => {} } },
    connection: { requestRejection() { return undefined } },
    workspaceRegistry: { list() { return [] } },
    __routes: routes,
  }
}

/** 快照工具名 + 缺省内核工具（去重）。 */
function universe() {
  const listed = JSON.parse(readFileSync(join(here, 'universe-tools.json'), 'utf8'))
  const defaults = [
    'read', 'write', 'edit', 'glob', 'grep', 'bash', 'todo_write',
    'ask_user_question', 'skill', 'present', 'read_image', 'tool_find',
  ]
  return [...new Set([...defaults, ...listed])]
}

async function main() {
  const names = universe()
  const tools = new Map(names.map((name) => [name, { name, description: '' }]))
  const ctx = makeCtx(tools)
  apply(ctx, {})
  const res = await new Promise((resolve) => {
    const captured = { statusCode: 200, body: undefined }
    ctx.__routes.get('/tool-discovery/data').handler({ method: 'GET', url: '/tool-discovery/data' }, {
      set statusCode(v) { captured.statusCode = v },
      setHeader() {},
      end(text) { captured.body = JSON.parse(text); resolve(captured) },
    })
  })
  const groups = new Map()
  for (const tool of res.body.tools) {
    const id = tool.source.id
    if (!groups.has(id)) groups.set(id, { label: tool.source.label, items: [] })
    groups.get(id).items.push(tool.name)
  }
  const order = [...groups.entries()].sort(([a], [b]) => {
    const rank = (id) => (id === 'core' ? 0 : id.startsWith('mcp:') ? 200 : id === 'other' ? 999 : 50)
    return rank(a) - rank(b)
  })
  for (const [id, { label, items }] of order) {
    console.log(`[${label}] (${items.length})`)
    for (const name of items) console.log(`  ${name}`)
  }
  const other = groups.get('other')
  if (other === undefined) console.log('\n「其他」组：无残留 ✓')
  else console.log(`\n「其他」组残留 ${other.items.length} 个：${other.items.join(', ')}`)
}

await main()
