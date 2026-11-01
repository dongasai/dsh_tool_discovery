/**
 * @module @dongasai/dsh-tool-discovery/client
 *
 * **工具发现 —— 浏览器半边**：在右侧栏注册两个页签。
 *
 * - 「工具·全局」：管所有工作区都继承的底（默认档名单、全局屏蔽、索引预算）。
 * - 「工具·工作区」：只管理当前会话所在工作区的覆盖（追加默认 / 追加屏蔽），
 *   页签正文绑定 `sidebar.right.pane.tab` 槽位传入的 `sessionId`，不提供工作区切换。
 *
 * ## 数据与约束
 *
 * - 读：`GET /tool-discovery/data[?sessionId=|?workspacePath=]`，Host 按
 *   全局 → 工作区 → 会话激活 合成后给出每个工具的档位。
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

  /** Host 半边数据路由。 */
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
          display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px',
          height: '100%', boxSizing: 'border-box', minHeight: 0, fontSize: '14px', color: 'inherit',
        },
        head: { display: 'flex', alignItems: 'center', gap: '8px', flex: 'none' },
        title: { margin: '0', fontSize: '16px', fontWeight: 600 },
        counts: { fontSize: '13px', opacity: 0.65 },
        spacer: { flex: '1 1 auto' },
        button: {
          fontSize: '13px', padding: '5px 12px', borderRadius: '5px', cursor: 'pointer',
          border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35))',
          background: 'transparent', color: 'inherit',
        },
        buttonPrimary: {
          fontSize: '13px', padding: '5px 14px', borderRadius: '5px', cursor: 'pointer',
          border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35))',
          background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))', color: 'inherit',
        },
        toolbar: { display: 'flex', alignItems: 'center', gap: '6px', flex: 'none' },
        input: {
          fontSize: '13px', padding: '5px 8px', borderRadius: '5px', flex: '1 1 auto', minWidth: 0,
          border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35))',
          background: 'transparent', color: 'inherit',
        },
        note: { margin: '0', fontSize: '13px', lineHeight: 1.6, opacity: 0.7 },
        error: {
          margin: '0', padding: '8px 10px', borderRadius: '6px', fontSize: '13px', lineHeight: 1.6,
          border: '1px solid var(--dsw-alias-label-error, rgba(220,80,80,.8))',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        },
        ok: {
          margin: '0', padding: '8px 10px', borderRadius: '6px', fontSize: '13px', lineHeight: 1.6,
          border: '1px solid var(--dsw-alias-state-success, rgba(59,165,93,.8))',
        },
        list: { display: 'flex', flexDirection: 'column', gap: '6px', overflow: 'auto', minHeight: 0 },
        row: { display: 'flex', alignItems: 'center', gap: '12px', padding: '9px 8px', borderRadius: '5px' },
        name: {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '13px',
          fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: '0 0 34%',
        },
        summary: {
          fontSize: '13px', opacity: 0.65, whiteSpace: 'nowrap', overflow: 'hidden',
          textOverflow: 'ellipsis', flex: '1 1 auto', minWidth: 0,
        },
        seg: { display: 'inline-flex', gap: '3px', flex: 'none' },
        segOn: {
          fontSize: '12px', padding: '3px 10px', borderRadius: '999px', cursor: 'pointer',
          border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.45))',
          background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.18))', color: 'inherit',
        },
        segOff: {
          fontSize: '12px', padding: '3px 10px', borderRadius: '999px', cursor: 'pointer',
          border: '1px solid transparent', background: 'transparent', color: 'inherit', opacity: 0.55,
        },
        groupHead: {
          display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 8px',
          cursor: 'pointer', userSelect: 'none', flex: 'none', position: 'sticky', top: 0,
          background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.04))',
          borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2))',
          zIndex: 1,
        },
        groupLabel: { fontSize: '13px', fontWeight: 700, opacity: 0.8, whiteSpace: 'nowrap', flex: '0 0 auto' },
        groupCount: {
          fontSize: '12px', padding: '0 8px', borderRadius: '999px', lineHeight: '18px',
          background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.15))', opacity: 0.7, flex: '0 0 auto',
        },
        chevron: {
          fontSize: '11px', opacity: 0.45, flex: 'none', display: 'inline-block',
          transition: 'transform .12s ease',
        },
        groupBody: { display: 'flex', flexDirection: 'column', gap: '1px' },
      }

      /**
       * 造一个面板组件。
       * @param mode - `global` 或 `workspace`。
       * @returns React 组件。
       */
      function createPanel(mode) {
        const isGlobal = mode === 'global'

        return function ToolDiscoveryPanel({ sessionId }) {
          const [data, setData] = React.useState(undefined)
          const [draft, setDraft] = React.useState(undefined)
          const [error, setError] = React.useState('')
          const [notice, setNotice] = React.useState('')
          const [loading, setLoading] = React.useState(false)
          const [saving, setSaving] = React.useState(false)
          const [query, setQuery] = React.useState('')
          const [collapsed, setCollapsed] = React.useState(() => new Set())
          const alive = React.useRef(true)
          React.useEffect(() => {
            alive.current = true
            return () => { alive.current = false }
          }, [])

          /**
           * 拉一次数据。工作区面板只认当前会话：`sessionId` 由
           * `sidebar.right.pane.tab` 槽位传入；全局面板不带任何参数。
           * @returns 无。
           */
          const load = React.useCallback(async () => {
            const params = new URLSearchParams()
            if (!isGlobal && sessionId !== undefined && sessionId !== '') params.set('sessionId', sessionId)
            const suffix = params.toString() === '' ? '' : `?${params}`
            setLoading(true)
            setError('')
            try {
              const response = await fetch(`${DATA_PATH}${suffix}`, { headers: { accept: 'application/json' } })
              const body = await response.json()
              if (body?.ok !== true) throw new Error(body?.message ?? '读取工具表失败')
              if (!alive.current) return
              setData(body)
              setDraft(Object.fromEntries(body.tools.map((tool) => [tool.name, tool.bucket])))
            } catch (failure) {
              if (alive.current) setError(failure instanceof Error ? failure.message : String(failure))
            } finally {
              if (alive.current) setLoading(false)
            }
          }, [sessionId, isGlobal])

          React.useEffect(() => { void load() }, [load])

          /**
           * 保存草稿：默认档与屏蔽档两个名单直接落盘。
           * @returns 无。
           */
          const save = async () => {
            if (draft === undefined) return
            const defaults = Object.entries(draft).filter(([, bucket]) => bucket === 'default').map(([toolName]) => toolName)
            const blocked = Object.entries(draft).filter(([, bucket]) => bucket === 'blocked').map(([toolName]) => toolName)
            const workspacePath = data?.workspacePath
            if (!isGlobal && (workspacePath === undefined || workspacePath === null || workspacePath === '')) {
              if (alive.current) setError('当前会话没有工作区目录，无法保存工作区策略。')
              return
            }
            const value = isGlobal ? { defaultTools: defaults, blockedTools: blocked } : { default: defaults, blocked }
            setSaving(true)
            setError('')
            setNotice('')
            try {
              const response = await fetch(POLICY_PATH, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  scope: isGlobal ? 'global' : 'workspace',
                  workspacePath: isGlobal ? undefined : workspacePath,
                  value,
                }),
              })
              const body = await response.json()
              if (body?.ok !== true) throw new Error(body?.message ?? '保存失败')
              if (alive.current) setNotice(`已保存（${body.path}）。下一轮请求生效。`)
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

          const sourceLabel = (source) => {
            if (!source) return '其他'
            if (source.kind === 'mcp' || String(source.id).startsWith('mcp:')) {
              return source.server ? `MCP · ${source.server}` : (source.label || source.id)
            }
            if (source.id === 'core') return '内核'
            if (source.id === 'other') return '其他'
            if (source.id.startsWith('plugin:')) return source.label || source.id.slice('plugin:'.length)
            return source.label || source.id
          }
          const groupRank = (id) => {
            if (id === 'core') return 0
            if (id.startsWith('plugin:')) return 100
            if (id.startsWith('mcp:')) return 200
            if (id === 'other') return 999
            return 500
          }
          const groups = new Map()
          for (const tool of filtered) {
            const id = tool.source?.id || 'other'
            if (!groups.has(id)) groups.set(id, { id, source: tool.source, items: [] })
            groups.get(id).items.push(tool)
          }
          const ordered = [...groups.values()].sort((a, b) => {
            const ra = groupRank(a.id)
            const rb = groupRank(b.id)
            if (ra !== rb) return ra - rb
            return sourceLabel(a.source).localeCompare(sourceLabel(b.source))
          })
          const toggleGroup = (id) => {
            setCollapsed((current) => {
              const next = new Set(current)
              if (next.has(id)) next.delete(id)
              else next.add(id)
              return next
            })
          }

          return h('div', { style: S.root },
            h('div', { style: S.head },
              h('h3', { style: S.title }, isGlobal ? '工具自动发现' : '工具·工作区'),
              h('span', { style: S.counts },
                `共 ${data.counts.total} · 默认 ${counters.default} · 可发现 ${counters.discoverable} · 屏蔽 ${counters.blocked}`),
              h('span', { style: S.spacer }),
              h('button', { style: S.button, type: 'button', disabled: loading, onClick: () => void load() }, '刷新'),
              h('button', { style: S.buttonPrimary, type: 'button', disabled: saving, onClick: () => void save() }, saving ? '保存中…' : '保存')),
            h('p', { style: S.note }, isGlobal
              ? '这里的名单是所有工作区的底；工作区只能在此基础上追加屏蔽，不能解屏蔽。'
              : `只管理当前会话所在工作区。当前目标：${data.workspacePath ?? '（未选择）'}`),
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
              ordered.flatMap((group) => {
                const isCollapsed = collapsed.has(group.id)
                return [
                  h('div', {
                    key: 'g:' + group.id,
                    style: S.groupHead,
                    onClick: () => toggleGroup(group.id),
                    role: 'button',
                    'aria-expanded': !isCollapsed,
                  },
                    h('span', { style: { ...S.chevron, transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' } }, '▾'),
                    h('span', { style: S.groupLabel }, sourceLabel(group.source)),
                    h('span', { style: S.groupCount }, group.items.length)),
                  ...(isCollapsed ? [] : group.items.map((tool) => h('div', { key: tool.name, style: S.row },
                    h('span', { style: S.name, title: tool.name }, tool.name),
                    h('span', { style: S.summary, title: tool.summary }, tool.summary),
                    h('span', { style: S.seg },
                      BUCKETS.map((bucket) => h('button', {
                        key: bucket.id,
                        type: 'button',
                        style: (draft?.[tool.name] ?? tool.bucket) === bucket.id ? S.segOn : S.segOff,
                        onClick: () => setBucket(tool.name, bucket.id),
                      }, bucket.label)))))),
                ]
              }),
              filtered.length === 0 ? h('p', { style: S.note }, '没有匹配的工具。') : null))
        }
      }

      /**
       * 指南卡片图标。
       * @returns React 元素。
       */
      function GuideIcon() {
        return h('svg', { width: 20, height: 20, viewBox: '0 0 18 18', fill: 'none', 'aria-hidden': 'true' },
          h('rect', { x: 2.5, y: 3.5, width: 13, height: 11, rx: 2, stroke: 'currentColor', strokeWidth: 1.3 }),
          h('path', { d: 'M5.5 7.5h7M5.5 10.5h4.5', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }))
      }

      /** 左侧栏全局面板图标。 */
      function GlobalIcon({ size }) {
        return h('svg', {
          width: size ?? 18,
          height: size ?? 18,
          viewBox: '0 0 18 18',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '1.4',
          strokeLinecap: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
          h('circle', { cx: 9, cy: 9, r: 6.5 }),
          h('path', { d: 'M9 2.5v13M2.5 9h13' }))
      }

      return {
        name: 'tool-discovery',
        inject: ['slots', 'sidebarRightTabs'],
        /**
         * 注册全局面板（左侧栏）与工作区页签（右侧栏）。
         * @param ctx - 浏览器端插件上下文。
         * @returns 无。
         */
        apply(ctx) {
          const GlobalPanel = createPanel('global')
          const WorkspacePanel = createPanel('workspace')

          function GlobalPanelSlot() {
            return h(GlobalPanel)
          }

          /** 右侧栏页签正文：`sidebar.right.pane.tab` 槽位会把当前会话 id 作为 prop 传进来。 */
          function WorkspacePanelSlot(props) {
            return h(WorkspacePanel, { sessionId: props?.sessionId })
          }

          // 全局管理：左侧栏面板（类似 gitea 的全局看板）
          ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: TAB_GLOBAL,
          }, GlobalPanelSlot)), 'tool-discovery: global main')
          ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: TAB_GLOBAL,
            order: 30,
            label: () => '工具自动发现',
          }, GlobalIcon)), 'tool-discovery: global sidebar icon')

          // 工作区管理：右侧栏页签
          ctx.effect(() => ctx.sidebarRightTabs.register({
            id: TAB_WORKSPACE,
            kind: TAB_WORKSPACE,
            priority: 'builtin',
            title: () => '工具·工作区',
            guide: [{
              id: `${TAB_WORKSPACE}-guide`,
              order: 31,
              title: () => '工具·工作区',
              description: () => '管理当前工作区的默认档与屏蔽',
              icon: GuideIcon,
            }],
          }), 'tool-discovery: workspace tab')
          ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: TAB_WORKSPACE,
          }, WorkspacePanelSlot)), 'tool-discovery: workspace panel')
        },
      }
    },
  })
})()
