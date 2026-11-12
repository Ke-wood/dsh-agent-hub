/**
 * dsh-agent-hub — 自建的子代理工具链，一套工具管两种代理。
 *
 * ## 为什么要自建
 *
 * DSH 原装两套体系互相看不见：
 *
 *   - `subagent`（legacy）派出的子代理：`list_agents` 看不到、`wait_agent` 等不到
 *   - `spawn_teammate`（Team）派出的 teammate：legacy 的 `list_agents` 也看不到
 *
 * 两者都叫 `list_agents`，谁装上谁赢，赢的那个只认自己那一半。
 * 实测代价：一个会话派 19 个 subagent，`list_agents` 只返回 `lead` 一行；
 * 主代理以为没派出去，空转 26 次 `wait_agent` + 50 次读文件大小猜进度。
 *
 * ## 本插件的做法
 *
 * **不覆盖任何原装工具**（那会跟 Team 抢名字、跟加载顺序耦合）。
 * 改为注册一套自己的工具，直接调 `ctx.subagents` 与 `ctx.agentTeams`：
 *
 *   - `hub_spawn`  —— 派子代理（可选 team/subagent 两种后端）
 *   - `hub_list`   —— 列出**全部**代理：teammate + subagent，一张表
 *   - `hub_wait`   —— 真的等，轮询 `ctx.agents.get(id).status`
 *   - `hub_tell`   —— 给任意代理发消息
 *
 * 名字统一 `hub_` 前缀，一眼知道是同一套；不与原装冲突，不依赖加载顺序。
 *
 * ## 为什么 `hub_wait` 自己轮询
 *
 * `ctx.subagents.waitForChildren` 不可靠：它只遍历 `resident`（内存活跃
 * activation）表，子代理在两次工具调用之间短暂离开该表时会瞬间返回。
 * 实测：子代理跑 60 秒命令，`waitForChildren` 版本 11 秒就返回；
 * 轮询版本等满 66 秒。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'agent-hub'
export const inject = ['tools', 'subagents', 'agents']

const DEFAULT_WAIT_MS = 120_000
const MAX_WAIT_MS = 600_000
const POLL_MS = 500
/** 刚派出时给子代理的启动宽限，避免误判「没在跑」 */
const STARTUP_GRACE_MS = 3_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 统一条目 schema */
const ENTRY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, enum: ['lead', 'teammate', 'subagent'] },
    id: { type: 'string', required: true },
    label: { type: 'string' },
    status: { type: 'string', required: true, enum: ['running', 'inactive', 'provisioning', 'failed'] },
    parent: { type: 'string' },
    depth: { type: 'number' },
  },
}

export function apply(ctx) {
  /** 读 Agent 的实时状态（running / inactive） */
  const liveStatus = (id) => (ctx.agents.get(id)?.status === 'running' ? 'running' : 'inactive')

  /**
   * 收集全部代理：Team roster + subagent catalog。
   * 两套都查，谁不可用就跳过谁，不因一边失败而丢另一边。
   *
   * 注意：所有字段都必须有确定值——`undefined` 不是 lossless JSON，
   * 会让工具返回被拒（实测报错 `value is not lossless JSON`）。
   */
  async function collectAll(agent, signal) {
    const rows = []

    // Team：lead + teammate
    // listMembers 返回原始 member：{ id, name, description, role, status, provider, context, model }
    // 注意不是 modelMember 投影后的 { target, ... }——那是工具层才做的映射。
    const teams = ctx.get('agentTeams')
    if (teams !== undefined) {
      try {
        for (const m of teams.listMembers(agent)) {
          // id 是内部 SessionId，name 才是可寻址的 target
          const target = String(m.name ?? m.target ?? m.id ?? '')
          rows.push({
            kind: m.role === 'lead' ? 'lead' : 'teammate',
            id: target,
            label: String(m.description ?? m.name ?? ''),
            status: String(m.status ?? 'inactive'),
          })
        }
      } catch {
        /* Team 不可用则跳过 */
      }
    }

    // subagent：本 Agent 的整棵子树
    try {
      const entries = await ctx.subagents.listDescendants(agent.id, signal)
      for (const e of entries) {
        if (e.kind === 'diagnostic') {
          rows.push({
            kind: 'subagent',
            id: String(e.id),
            label: `(diagnostic: ${String(e.reason)})`,
            status: 'failed',
            parent: String(e.parentId),
            depth: Number(e.depth),
          })
          continue
        }
        rows.push({
          kind: 'subagent',
          id: String(e.id),
          label: String(e.label ?? ''),
          status: String(typeof e.activity === 'string' ? e.activity : liveStatus(e.id)),
          parent: String(e.parentId),
          depth: Number(e.depth),
        })
      }
    } catch {
      /* catalog 不可用则只返回 Team 部分 */
    }

    return rows
  }

  const renderRow = (r) => {
    const at = r.depth === undefined ? '' : ` depth=${r.depth}`
    const label = r.label === '' ? '' : ` — ${r.label}`
    return `${r.kind}:${r.id} [${r.status}]${at}${label}`
  }
  // ── hub_spawn ──────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'hub_spawn',
      description:
        'Delegate a self-contained task to a child agent. Returns the child id immediately; '
        + 'use hub_wait to wait for it and hub_list to see all children. '
        + 'backend "subagent" (default) is lightweight and cheap — best for one-shot execution. '
        + 'backend "team" creates a durable named teammate you can steer across turns '
        + '(Lead only, permanent name, counts against the team member limit). '
        + 'The child does NOT inherit this conversation; write a self-contained prompt.',
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: 'Complete self-contained task. The child cannot see this conversation.',
        },
        description: {
          type: 'string',
          required: true,
          description: 'Short label shown in hub_list (3-5 words).',
        },
        backend: {
          type: 'string',
          enum: ['subagent', 'team'],
          description:
            'subagent (default) = lightweight child. team = durable named teammate '
            + '(Lead only; needs `name`).',
        },
        name: {
          type: 'string',
          description: 'Required when backend=team. Unique lower-kebab-case teammate name.',
        },
        context: {
          type: 'string',
          enum: ['fresh', 'fork'],
          description:
            'backend=team only. fresh (default) starts without this conversation; '
            + 'fork inherits completed turns.',
        },
        cwd: {
          type: 'string',
          description: 'backend=subagent only. Initial working directory; omitted inherits yours.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            backend: { type: 'string', required: true },
          },
        },
        render: (_a, v) => [{ type: 'text', text: `started ${v.backend} ${v.id}` }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const parent = exec.agent
        if (parent === undefined) throw new Error('hub_spawn 需要调用方 Agent')

        const backend = args.backend ?? 'subagent'

        if (backend === 'team') {
          const teams = ctx.get('agentTeams')
          if (teams === undefined) throw new Error('backend=team 需要 Agent Teams 服务')
          if (typeof args.name !== 'string' || args.name === '') {
            throw new Error('backend=team 需要 name')
          }
          const { member } = await teams.spawnTeammate(parent, {
            name: args.name,
            description: args.description,
            prompt: [{ type: 'text', text: args.prompt }],
            context: args.context ?? 'fresh',
            provider: args.context === 'fork' ? 'fork' : 'spawn',
            signal: exec.signal,
          })
          return { id: member.target, backend: 'team' }
        }

        // 默认：轻量 subagent
        const maxDepth = ctx.subagents.resolveMaxDepth(undefined)
        const request = {
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
          prompt: [{ type: 'text', text: args.prompt }],
          parent,
          ...(maxDepth === undefined ? {} : { maxDepth }),
        }
        const activation = await ctx.subagents.startActivation({
          provider: 'spawn',
          label: args.description,
          request,
          signal: exec.signal,
          delivery: 'parent',
        })
        return { id: String(activation.childId), backend: 'subagent' }
      },
    }),
  )

  // ── hub_list ───────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'hub_list',
      description:
        'List EVERY agent you can act on in one table: the Lead, your Team teammates, and the '
        + 'subagents you spawned — regardless of which backend created them. Each row starts with '
        + 'its kind (`lead:` / `teammate:` / `subagent:`); use the id after the kind for hub_tell. '
        + '`inactive` means no turn is executing right now — it does NOT mean the work finished; '
        + 'use hub_wait to actually wait. A finished child stays listed until its session is pruned.',
      parameters: {
        kind: {
          type: 'string',
          enum: ['all', 'team', 'subagent'],
          description: 'all (default) = everything; team = lead + teammates; subagent = spawned children.',
        },
        runningOnly: {
          type: 'boolean',
          description: 'Only show agents whose status is running.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            agents: { type: 'array', required: true, items: ENTRY },
            count: { type: 'number', required: true },
            running: { type: 'number', required: true },
          },
        },
        render: (_a, v) => [
          {
            type: 'text',
            text:
              v.count === 0
                ? '(no agents)'
                : `${v.count} 个代理（${v.running} 个在跑）:\n${v.agents.map(renderRow).join('\n')}`,
          },
        ],
      },
      async execute(args, exec) {
        const caller = exec.agent
        if (caller === undefined) throw new Error('hub_list 需要调用方 Agent')

        let all = await collectAll(caller, exec.signal)
        const kind = args.kind ?? 'all'
        if (kind === 'team') all = all.filter((r) => r.kind === 'lead' || r.kind === 'teammate')
        else if (kind === 'subagent') all = all.filter((r) => r.kind === 'subagent')
        if (args.runningOnly === true) all = all.filter((r) => r.status === 'running')

        return {
          agents: all,
          count: all.length,
          running: all.filter((r) => r.status === 'running').length,
        }
      },
    }),
  )

  // ── hub_wait ───────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'hub_wait',
      description:
        'Wait until the children you spawned stop running, or until timeoutMs elapses. '
        + 'This is a real join: it polls each child\'s live status and returns only when every '
        + 'child is idle or the timeout hits. It covers BOTH backends (subagent and team). '
        + 'Call it ONCE after spawning; never poll file sizes or loop on it.',
      parameters: {
        timeoutMs: {
          type: 'number',
          description: `Max wait in ms. Default ${DEFAULT_WAIT_MS}, cap ${MAX_WAIT_MS}.`,
        },
        kind: {
          type: 'string',
          enum: ['subagent', 'all'],
          description: 'Which children to wait for. subagent (default) = spawned children only.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            joined: { type: 'boolean', required: true },
            timedOut: { type: 'boolean', required: true },
            remaining: { type: 'number', required: true },
            waitedMs: { type: 'number', required: true },
            rows: { type: 'array', required: true, items: { type: 'string' } },
            note: { type: 'string', required: true },
          },
        },
        render: (_a, v) => [
          {
            type: 'text',
            text: [
              v.timedOut
                ? `等待 ${v.waitedMs}ms 超时，仍有 ${v.remaining} 个在跑。`
                : `${v.note}（等待 ${v.waitedMs}ms）`,
              ...v.rows,
            ].join('\n'),
          },
        ],
      },
      async execute(args, exec) {
        const parent = exec.agent
        if (parent === undefined) throw new Error('hub_wait 需要调用方 Agent')

        const raw = typeof args.timeoutMs === 'number' ? args.timeoutMs : DEFAULT_WAIT_MS
        const timeoutMs = Math.min(Math.max(raw, 1_000), MAX_WAIT_MS)
        const kind = args.kind ?? 'subagent'

        /** 当前还在跑的 id 列表 */
        const runningIds = async () => {
          const all = await collectAll(parent, exec.signal)
          return all
            .filter((r) => (kind === 'all' ? r.kind !== 'lead' : r.kind === 'subagent'))
            .filter((r) => r.status === 'running')
            .map((r) => r.id)
        }

        const started = Date.now()
        const deadline = started + timeoutMs

        // 首次采样；一个都没跑时给启动宽限，避免「刚派出还没起来」被误判
        let pending = await runningIds()
        if (pending.length === 0) {
          const graceUntil = Math.min(deadline, Date.now() + STARTUP_GRACE_MS)
          while (Date.now() < graceUntil) {
            await sleep(POLL_MS)
            pending = await runningIds()
            if (pending.length > 0) break
          }
        }

        const everRunning = pending.length > 0
        if (everRunning) {
          while (Date.now() < deadline) {
            pending = await runningIds()
            if (pending.length === 0) break
            await sleep(POLL_MS)
          }
        }

        const timedOut = pending.length > 0
        const waitedMs = Date.now() - started

        const all = await collectAll(parent, exec.signal).catch(() => [])
        const rows = all.map(renderRow)
        const remaining = all.filter((r) => r.status === 'running').length

        return {
          joined: everRunning,
          timedOut,
          remaining,
          waitedMs,
          rows,
          note: everRunning
            ? timedOut
              ? '部分子代理仍在运行。'
              : '子代理已全部停下。'
            : '调用时没有在跑的子代理（可能都已完成，或刚派出尚未启动）。',
        }
      },
    }),
  )

  // ── hub_tell ───────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'hub_tell',
      description:
        'Send a message to one agent by id — works for both a Team teammate and a subagent '
        + 'you spawned. A running target receives it at its next step boundary; an idle target '
        + 'starts a new turn. Returns delivery acceptance, NOT the agent\'s answer.',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: 'Agent id from hub_list (the part after the kind prefix).',
        },
        message: { type: 'string', required: true, description: 'The message to deliver.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            delivered: { type: 'boolean', required: true },
            via: { type: 'string', required: true },
          },
        },
        render: (_a, v) => [
          { type: 'text', text: v.delivered ? `已投递（via ${v.via}）。这是投递确认，不是回答。` : '投递失败。' },
        ],
      },
      async execute(args, exec) {
        const sender = exec.agent
        if (sender === undefined) throw new Error('hub_tell 需要调用方 Agent')
        if (typeof args.id !== 'string' || args.id === '') throw new Error('hub_tell 需要 id')
        if (typeof args.message !== 'string' || args.message === '') throw new Error('hub_tell 需要 message')

        const content = [{ type: 'text', text: args.message }]

        // 先看这个 id 是不是 Team 成员；不是就走 subagent
        const teams = ctx.get('agentTeams')
        if (teams !== undefined) {
          try {
            const isMember = teams.listMembers(sender).some((m) => m.target === args.id)
            if (isMember) {
              await teams.sendMessage(sender, { target: args.id, content, signal: exec.signal })
              return { delivered: true, via: 'team' }
            }
          } catch {
            /* 不是 Team 成员就继续试 subagent */
          }
        }

        await ctx.subagents.sendMessage(sender, args.id, content, { signal: exec.signal })
        return { delivered: true, via: 'subagent' }
      },
    }),
  )
}
