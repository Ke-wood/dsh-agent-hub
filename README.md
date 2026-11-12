# dsh-agent-hub

> 自建子代理工具链：一套工具同时管 Team teammate 和 subagent，不覆盖任何原装工具。

---

## 它解决什么

DSH 原装两套子代理体系**互相看不见**：

| 体系 | 派出方式 | 谁能看见它 |
|---|---|---|
| legacy | `subagent` | 只有 legacy 版 `list_agents` |
| Team | `spawn_teammate` | 只有 Team 版 `list_agents` |

**两者都叫 `list_agents`，谁装上谁赢，赢的那个只认自己那一半。**

实测代价（真实会话，19 个 subagent）：

```
list_agents 返回：[{ lead }]        ← 只 1 行，19 个子代理全隐身
wait_agent 调用 26 次 → 全部 noProgress
ops_stat   调用 50 次 → 反复读文件大小猜进度
```

主代理以为「没有正在运行的子代理」，实际有 19 个在跑。

---

## 本插件的做法

**不覆盖任何原装工具**——那会跟 Team 抢名字、跟加载顺序耦合、且实测覆盖不生效。

改为注册一套自己的工具，直接调 `ctx.subagents` 与 `ctx.agentTeams`：

| 工具 | 作用 |
|---|---|
| `hub_spawn` | 派子代理（可选 `backend: subagent` 或 `backend: team`） |
| `hub_list` | 列出**全部**代理：lead + teammate + subagent，一张表 |
| `hub_wait` | **真的等**，轮询 `ctx.agents.get(id).status` |
| `hub_tell` | 给任意代理发消息（自动判断走 Team 还是 subagent） |

名字统一 `hub_` 前缀，一眼知道是同一套；不与原装冲突，不依赖加载顺序。

---

## 实测结果

### `hub_list` 同时显示三类

```
16 个代理（1 个在跑）:
lead:lead [running] — lead
teammate:coord-verify [inactive] — 验证协调者-执行者分工
subagent:4f8775da [inactive] depth=1 — Verify subagent toolchain
subagent:ad5102b3 [inactive] depth=2 — Worker A sleep 30s
...
```

- `depth=1` 是直接子代理，`depth=2` 是孙代理
- 三种 kind 前缀清晰：`lead:` / `teammate:` / `subagent:`

### `hub_wait` 是真 join

| 测试 | 子代理实际工作 | `hub_wait` 等了多久 |
|---|---|---|
| 跑 `sleep 55` | 55 秒 | **65307ms** ✅ |
| 跑 `sleep 50` | 50 秒 | 等满 ✅ |

对比：`ctx.subagents.waitForChildren` 在同一场景下 **11 秒就返回**（它只遍历
`resident` 内存表，子代理在两次工具调用之间会短暂离开该表）。

---

## 为什么 `hub_wait` 自己轮询

```js
// ctx.subagents.waitForChildren 的核心：
const children = [...this.resident.values()].filter(...)
```

只遍历 `resident`（内存中的活跃 activation）表。`subagent` 在两次工具调用之间、
或纯等待时会短暂离开该表，此时 `children` 为空、`waits` 为空，函数立刻返回。

本插件改为每 500ms 采样 `ctx.agents.get(id).status`：
- 只看真实 Agent 状态（`idle` / `running`），不依赖 `resident` 表
- 派出后先给 3 秒宽限，避免「刚派出未启动」被误判为「没在跑」

---

## 安装

```bash
dsh plugin --profile <profile> add D:\path\to\dsh-agent-hub
```

或在 DSH 里让 agent 调 `plugin_manager` 的 `install_bundle`。

---

## 用法

```
hub_spawn({ prompt: "...", description: "短标签" })
  → started subagent <id>

hub_list()
  → 16 个代理（1 个在跑）: ...

hub_wait({ timeoutMs: 120000 })
  → 子代理已全部停下。（等待 65307ms）

hub_tell({ id: "...", message: "..." })
  → 已投递（via subagent）
```

**不要再用**：

| 原装工具 | 为什么 |
|---|---|
| `list_agents` | 只认一半（Team 版或 legacy 版，取决于谁装上） |
| `wait_agent` | 只等 Team 成员，对 subagent 永远 noProgress |
| `send_message` | 只发给 Team 成员，对 subagent 报 not found |

---

## 已知限制

- **`hub_wait` 不取消子代理**：超时后它们继续跑，只是不再等。
- **`inactive` 语义模糊**：源码明确「neither status describes task completion」。
  判断完成只能用 `hub_wait`。
- **`backend: team` 受 `maxMembers` 限制**：默认 16，且名字永久占用。
  需要更多就在 profile 的 `agent-team` 配置里调大 `maxMembers`。
- **孙代理只能看不能直接通信**：`sendMessage` 按直接父子关系授权；
  `depth >= 2` 的只能用 `hub_list` 看见，用 `interrupt` 打断（本插件未暴露）。

---

## 许可

MIT
