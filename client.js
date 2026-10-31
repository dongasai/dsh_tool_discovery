/**
 * @module @dongasai/dsh-tool-discovery/client
 *
 * **工具发现 —— 浏览器半边**：在右侧栏注册两个页签。
 *
 * - 「工具·全局」：管所有工作区都继承的底（默认档名单、全局屏蔽、索引预算）。
 * - 「工具·工作区」：管某一个月录的覆盖（追加默认 / 追加屏蔽 / 预算覆盖），
 *   顶部下拉可切换工作区；没有会话时也能用。
 *
 * ## 数据与约束
 *
 * - 读：`GET /tool-discovery/data`（Host 半边按 全局 → 工作区 → 会话激活 合成后给出档位）。
 * - 写：`POST /tool-discovery/policy`（全局写 `$DSH_HOME/tool-discovery/global.json`，
 *   工作区写 `<workspace>/<workspacePolicyFile>`）。
 * - 整个文件包在 IIFE 里、不 import 任何 Harness 包：宿主把所有 client bundle 拼成
 *   一个 classic script，顶层同名 `const` 会连带整条 combo 挂掉。
 */
;(() => {
  /** 插件包名：`__ModuleLoader__.load` 的 id，与 package.json 的 name 逐字一致。 */
  const PACKAGE_NAME = '@dongasai/dsh-tool-discovery'

  /** 全局面板页签 id。 */
  const TAB_GLOBAL = 'tool-discovery-global'

  /** 工作区面板页签 id。 */
  const TAB_WORKSPACE = 'tool-discovery-workspace'

  /** Host 半边数据路由；与 `index.js` 里的常量逐字一致。 */
  const DATA_PATH = '/tool-discovery/data'

  /** Host 半边写入路由。 */
  const POLICY_PATH = '/tool-discovery/policy'

  /** 三档的展示顺序与文案。 */
  const BUCKETS = [
    { id: 'default', label: '默认' },
    { id: 'discoverable', label: '可发现' },
    { id: 'blocked', label: '屏蔽' },
  ]

  window.__ModuleLoader__.load({
    id: PACKAGE_NAME,
    /**
     * 客户端模块工厂。
     * @param require - 客户端模块加载器（`react` 由它解析）。
     * @returns 客户端插件对象。
     */
    factory(require) {
      const React = require('react')
      const h = React.createElement

      /** 内联样式：只用主题 token，主题改名最多是外观退化。 */
      const S = {
        root: {
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          padding: '12px',
          height: '100%',
          boxSizing: 'border-box',
          minHeight: 0,
          fontSize: '12px',
          color: 'inherit',
        },
        head: { display: 'flex', alignItems: 'center', gap: '8px', flex: 'none' },
        title: { margin: '0', fontSize: '13px', fontWeight: 600 },
        counts: { fontSize: '11px', opacity: 0.65 },
        spacer: { flex: '1 1 auto' },
        button: {
          fontSize: '11px',
          padding: '3px 8px',
          borderRadius: '4px',
          border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35))',
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
        },
        buttonPrimary: {
          fontSize: '11px',
          padding: '3px 10px',
          borderRadius: '4px',
          border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35))',
          background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))',
          color: 'inherit',
          cursor: 'pointer',
        },
        toolbar: { display: 'flex', alignItems: 'center', gap: '6px', flex: 'none' },
        input: {
          fontSize: '11px',
          padding: '3px 8px',
          borderRadius: '4px',
          border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35))',
          background: 'transparent',
          color: 'inherit',
          flex: '1 1 auto',
          minWidth: 0,
        },
        select: {
          fontSize: '11px',
          padding: '3px 6px',
          borderRadius: '4px',
          border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35))',
          background: 'transparent',
          color: 'inherit',
          maxWidth: '100%',
        },
        note: { margin: '0', fontSize: '11px', lineHeight: 1.6, opacity: 0.7 },
        error: {
          margin: '0',
          padding: '6px 8px',
          borderRadius: '6px',
          border: '1px solid var(--dsw-alias-label-error, rgba(220,80,80,.8))',
          fontSize: '11px',
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        },
        ok: {
          margin: '0',
          padding: '6px 8px',
          borderRadius: '6px',
          border: '1px solid var(--dsw-alias-state-success, rgba(59,165,93,.8))',
          fontSize: '11px',
          lineHeight: 1.6,
        },
        list: { display: 'flex', flexDirection: 'column', gap: '2px', overflow: 'auto', minHeight: 0 },
        row: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '4px 6px',
          borderRadius: '4px',
        },
        name: {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: '11px',
          fontWeight: 600,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flex: '0 0 38%',
        },
        summary: {
          fontSize: '11px',
          opacity: 0.65,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flex: '1 1 auto',
          minWidth: 0,
        },
        seg: { display: 'inline-flex', gap: '2px', flex: 'none' },
        segOn: {
          fontSize: '10px',
          padding: '1px 7px',
          borderRadius: '999px',
          border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.45))',
          background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.18))',
          color: 'inherit',
          cursor: 'pointer',
        },
        segOff: {
          fontSize: '10px',
          padding: '1px 7px',
          borderRadius: '999px',
          border: '1px solid transparent',
          background: 'transparent',
          color: 'inherit',
          opacity: 0.55,
          cursor: 'pointer',
        },
      }

      /**
       * 造一个面板组件。
       * @param mode - `global` 或 `workspace`。
       * @returns React 组件。
       */
      function createPanel(mode) {
        const isGlobal = mode === 'global'

        return function ToolDiscoveryPanel() {
          const [data, setData] = React.useState(undefined)
          const [draft, setDraft] = React.useState(undefined)
          const [error, setError] = React.useState('')
          const [notice, setNotice] = React.useState('')
          const [loading, setLoading] = React.useState(false)
          const [saving, setSaving] = React.useState(false)
          const [query, setQuery] = React.useState('')
          const [workspacePath, setWorkspacePath] = React.useState('')
          const alive = React.useRef(true)
          React.useEffect(() => {
            alive.current = true
            return () => { alive.current = false }
          }, [])

          /**
           * 拉一次数据；工作区模式带上当前选中的路径。
           * @param pathOverride - 显式覆盖选择（下拉切换时用，绕过 state 批处理）。
           * @returns 无。
           */
          const load = React.useCallback(async (pathOverride) => {
            const path = pathOverride ?? workspacePath
            const url = isGlobal || path === ''
              ? DATA_PATH
              : `${DATA_PATH}?workspacePath=${encodeURIComponent(path)}`
            setLoading(true)
            setError('')
            try {
              const response = await fetch(url, { headers: { accept: 'application/json' } })
              const body = await response.json()
              if (body?.ok !== true) throw new Error(body?.message ?? '读取工具表失败')
              if (!alive.current) return
              setData(body)
              setDraft(Object.fromEntries(body.tools.map((tool) => [tool.name, tool.bucket])))
              if (!isGlobal && (pathOverride ?? workspacePath) === '') {
                const first = body.workspaces[0]?.path ?? ''
                if (first !== '') {
                  setWorkspacePath(first)
                  await load(first)
                  return
                }
              }
            } catch (failure) {
              if (alive.current) setError(failure instanceof Error ? failure.message : String(failure))
            } finally {
              if (alive.current) setLoading(false)
            }
          }, [workspacePath])

          React.useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

          /**
           * 保存草稿：默认档与屏蔽档两个名单直接落盘。
           * @returns 无。
           */
          const save = async () => {
            if (draft === undefined) return
            const defaults = Object.entries(draft).filter(([, bucket]) => bucket === 'default').map(([toolName]) => toolName)
            const blocked = Object.entries(draft).filter(([, bucket]) => bucket === 'blocked').map(([toolName]) => toolName)
            const value = isGlobal ? { defaultTools: defaults, blockedTools: blocked } : { default: defaults, blocked }
            setSaving(true)
            setError('')
            setNotice('')
            try {
              const response = await fetch(POLICY_PATH, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ scope: isGlobal ? 'global' : 'workspace', workspacePath: isGlobal ? undefined : workspacePath, value }),
              })
              const body = await response.json()
              if (body?.ok !== true) throw new Error(body?.message ?? '保存失败')
              if (alive.current) setNotice(`已保存（${body.path}）。新策略在下一轮请求生效。`)
              await load()
            } catch (failure) {
              if (alive.current) setError(failure instanceof Error ? failure.message : String(failure))
            } finally {
              if (alive.current) setSaving(false)
            }
          }

          /**
           * 改一个工具的档位。
           * @param toolName - 工具名。
           * @param bucket - 目标档位。
           * @returns 无。
           */
          const setBucket = (toolName, bucket) => {
            setDraft((current) => (current === undefined ? current : { ...current, [toolName]: bucket }))
          }

          if (data === undefined) {
            return h('div', { style: S.root },
              h('p', { style: S.note }, loading ? '正在读取工具表…' : '没有读到工具表。'),
              error === '' ? null : h('p', { style: S.error, role: 'alert' }, error))
          }

          const filtered = data.tools.filter((tool) => query === '' || tool.name.toLowerCase().includes(query.toLowerCase()))
          const counters = { default: 0, discoverable: 0, blocked: 0 }
          for (const bucket of Object.values(draft ?? {})) counters[bucket] += 1

          return h('div', { style: S.root },
            h('div', { style: S.head },
              h('h3', { style: S.title }, isGlobal ? '工具·全局' : '工具·工作区'),
              h('span', { style: S.counts },
                `共 ${data.counts.total} · 默认 ${counters.default} · 可发现 ${counters.discoverable} · 屏蔽 ${counters.blocked}`),
              h('span', { style: S.spacer }),
              h('button', { style: S.button, type: 'button', disabled: loading, onClick: () => void load() }, '刷新'),
              h('button', { style: S.buttonPrimary, type: 'button', disabled: saving, onClick: () => void save() }, saving ? '保存中…' : '保存')),
            isGlobal
              ? h('p', { style: S.note }, '这里定的名单是所有工作区的底；工作区面板只能在此基础上追加屏蔽，不能解屏蔽。')
              : h('div', { style: S.toolbar },
                h('span', { style: S.note }, '工作区：'),
                h('select', {
                  style: S.select,
                  value: workspacePath,
                  onChange: (event) => {
                    setWorkspacePath(event.target.value)
                    void load(event.target.value)
                  },
                }, data.workspaces.map((item) => h('option', { key: item.id, value: item.path }, `${item.title} — ${item.path}`)))),
            h('div', { style: S.toolbar },
              h('input', {
                style: S.input,
                placeholder: '按工具名过滤…',
                value: query,
                onChange: (event) => setQuery(event.target.value),
              })),
            error === '' ? null : h('p', { style: S.error, role: 'alert' }, error),
            notice === '' ? null : h('p', { style: S.ok }, notice),
            h('div', { style: S.list },
              filtered.map((tool) => h('div', { key: tool.name, style: S.row },
                h('span', { style: S.name, title: tool.name }, tool.name),
                h('span', { style: S.summary, title: tool.summary }, tool.summary),
                h('span', { style: S.seg },
                  BUCKETS.map((bucket) => h('button', {
                    key: bucket.id,
                    type: 'button',
                    style: (draft?.[tool.name] ?? tool.bucket) === bucket.id ? S.segOn : S.segOff,
                    onClick: () => setBucket(tool.name, bucket.id),
                  }, bucket.label))))),
              filtered.length === 0 ? h('p', { style: S.note }, '没有匹配的工具。') : null))
        }
      }

      /**
       * 造一个 guid 卡片图标（右下角一个小方块）。
       * @returns React 元素。
       */
      function GuideIcon() {
        return h('svg', { width: 18, height: 18, viewBox: '0 0 18 18', fill: 'none', 'aria-hidden': 'true' },
          h('rect', { x: 2.5, y: 3.5, width: 13, height: 11, rx: 2, stroke: 'currentColor', strokeWidth: 1.3 }),
          h('path', { d: 'M5.5 7.5h7M5.5 10.5h4.5', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }))
      }

      return {
        name: 'tool-discovery',
        inject: ['slots', 'sidebarRightTabs'],
        /**
         * 注册两个页签类型与各自的正文。
         * @param ctx - 浏览器端插件上下文。
         * @returns 无。
         */
        apply(ctx) {
          const panels = [
            {
              id: TAB_GLOBAL,
              kind: TAB_GLOBAL,
              title: '工具·全局',
              description: '所有工作区共享的工具默认档与屏蔽清单',
              order: 30,
            },
            {
              id: TAB_WORKSPACE,
              kind: TAB_WORKSPACE,
              title: '工具·工作区',
              description: '按工作区覆盖默认档、追加屏蔽',
              order: 31,
            },
          ]
          for (const panel of panels) {
            const Component = createPanel(panel.id === TAB_GLOBAL ? 'global' : 'workspace')
            ctx.effect(() => ctx.sidebarRightTabs.register({
              id: panel.id,
              kind: panel.kind,
              priority: 'builtin',
              title: () => panel.title,
              guide: [{
                id: `${panel.id}-guide`,
                order: panel.order,
                title: () => panel.title,
                description: () => panel.description,
                icon: GuideIcon,
              }],
            }), `tool-discovery: tab ${panel.id}`)
            ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
              name: 'sidebar.right.pane.tab',
              key: panel.id,
            }, Component)), `tool-discovery: panel ${panel.id}`)
          }
        },
      }
    },
  })
})()
