# 智能体团队与任务分配（设计稿）

> 状态：**P0、P1 已实现**（2026-11-26，分支 `feat/agent-teams`）；P2–P3 未实现。日期 2026-11-25。
> 本文只描述设计与验收口径，落地按 §12 分期；实现见 `team/store.js`、`team/dispatch.js` 与 `index.js` 的 `registerTeamTools`。背景研读见 `~/文档/deepseek-harness/default-workspace/superagent-原型研读.md` 与 `superagent-插件工程研读.md`。
>
> 一句话：团队的单位是**智能体**；项目只是把已有智能体编成「1 负责人 + N 成员」；任务由负责人分配、成员执行并汇报；子智能体直接使用 DSH 官方 `subagent`，vault 不接管。

## 1. 背景与边界

### 1.1 vault 已经有什么

| 能力 | 现状 | 位置 |
|---|---|---|
| 智能体身份 | `agents.json` 注册表，每个智能体有 id/名字/短记忆 | `store.js:194` |
| 对话绑定 | `bindings.json`：一段对话绑定一个智能体 | `store.js:196` |
| 短记忆 | 每智能体 4K，按绑定注入 `systemPrompt.section` | `index.js:258-275` |
| 共享知识库 | 全智能体共用一个库，条目记录贡献者 | `store.js`、`agent_knowledge_*` |
| 私有日志 | 每智能体一份，只有自己能读写 | `journal.js` |
| 讨论室 | 多智能体共享的追加式 transcript，成员可中途进出 | `rooms.js:8-13` |
| 会话管理 | 创建会话并绑定智能体、列出/归档会话 | `index.js` 的 `agent.newSession`、`archive.set` |
| 面板与 HTTP | `/api/agent-memory` 的 op 路由 | `index.js:1332-1384` |

### 1.2 要加什么

一层「项目 → 任务 → 分配 → 汇报」的编排：

- **项目**：命名、1 个负责人（lead）、若干成员（members），可选绑定一个讨论室；
- **任务**：可创建、可分配、可验收；有状态、有历史；
- **分配**：负责人把任务交给某个成员，成员被叫醒执行；
- **汇报**：成员用结构化 report 回报，负责人不轮询；
- **持久**：智能体身份永不因任务结束而销毁；任务历史保留。

### 1.3 非目标

- 不实现自定义子智能体：成员开子智能体直接用 DSH 官方 `subagent`（§8）。
- 不做外部源与工单 triage：不接 GitHub/飞书，不做 accept/attach/ignore。
- 不管理 worktree/workspace：工作区由 DSH 的 `workspaceRegistry` 负责，vault 只记录任务落在哪个会话/目录。
- 不做会话沙箱与权限模型：权限归 DSH preset，vault 不改 `permissionPresets`、不改 preset。
- 不改记忆语义：记忆仍按绑定会话注入；团队层不向 `systemPrompt` 注入任何东西。

## 2. 与 superagent 的取舍

| 机制 | 取舍 | 理由 |
|---|---|---|
| 分配即事务 + durable effect 队列（`(kind,key)` 幂等） | **借** | 分配、叫醒、汇报都是「先记账、后发生」；重试不重投 |
| `launch/delivery/relay/notice` 四类 effect | **借**，改名 `dispatch/deliver/relay/ping` | 与 vault 现有文件存储结合，语义不变 |
| WorkerSlots：容量上限、人的消息优先、wake 先于 launch | **借** | 改成「项目容量 + 成员忙闲」 |
| report 状态机（progress/waiting/ready/blocked/failed/dropped） | **借** | 负责人不用轮询；状态可机械判定 |
| requestStatus（问 idle 成员） | **借** | 成员 turn 结束但没 report 时，负责人能追问 |
| `ensure`：resolve-or-create 会话 + 绑定 | **借** | vault 已有 `agent.newSession` 路径，直接复用 |
| 三层能力（preset + `tools.restrict` + `tools.guard`） | **借思路，不借实现** | vault 不 ship preset；用工具注册面与绑定校验表达能力 |
| Ticket triage（route/attach/ignore） | 不借 | 项目内没有外部触发源，任务由负责人或用户创建 |
| Source 适配器、worktree 隔离、2 秒 pass 轮询、SQLite | 不借 | vault 是文件型、事件驱动的记忆插件，不复制宿主职责 |

## 3. 领域模型

### 3.1 单位与角色

- 团队成员 = **智能体**（`agents.json` 的 id），不是会话、不是子代理。
- `lead` 是项目内的角色字段，不是新实体：同一个智能体可以在 A 项目当负责人、在 B 项目当成员。
- 会话只是执行位置：一个成员可以有多段历史会话，当前活动会话由 `bindings.json` 决定；「工作结束不销毁」指的是智能体身份与任务历史保留，会话可以归档（§10）。

### 3.2 实体

**Project**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | `p-` + 8 位小写字母数字 |
| `name` | string | 项目名，≤ 80 字 |
| `lead` | agentId | 负责人，必须是已注册智能体 |
| `members` | agentId[] | 成员，不含 lead；可含 lead 以外的任意已注册智能体 |
| `roomId` | string? | 可选，绑定讨论室 |
| `capacity` | number | 同时运行的 attempt 上限，默认 3 |
| `status` | `active` / `archived` | 项目归档只影响面板，不影响历史 |
| `createdAt` / `updatedAt` | ISO string | |

**Task**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | `t-` + 8 位 |
| `project` | projectId | |
| `title` | string | ≤ 200 字 |
| `brief` | string | 任务说明，≤ 4000 字；给成员看的原文 |
| `acceptance` | string? | 验收标准，≤ 1000 字 |
| `assignee` | agentId? | 当前执行人；未分配为空 |
| `status` | 见 §3.3 | |
| `createdBy` | `user` / agentId | |
| `attempts` | Attempt[] | 按时间排序 |
| `knowledge` | entryId[] | 可选，关联知识条目 |
| `createdAt` / `updatedAt` | ISO string | |

**Attempt**（一次「交给某个成员跑一轮」）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | `a-` + 8 位 |
| `task` | taskId | |
| `assignee` | agentId | |
| `sessionId` | string? | 唤醒后写入；降级领取时由成员会话决定 |
| `state` | `queued` / `running` / `waiting` / `ready` / `blocked` / `failed` / `dropped` / `cancelled` | |
| `report` | Report? | 终态或等待态的汇报 |
| `startedAt` / `endedAt` | ISO string? | |

**Report**

| 字段 | 类型 | 说明 |
|---|---|---|
| `state` | 同上 | 只有 assignee 能写 |
| `summary` | string | ≤ 600 字，写给负责人看 |
| `question` | string? | 需要负责人/人回答的问题 |
| `files` | string[]? | 产出路径，≤ 20 条 |
| `at` | ISO string | |

### 3.3 状态机

```
Task:    open ──assign──> assigned ──dispatch──> running
              running ──report(waiting)──> waiting ──再dispatch──> running
              running ──report(ready)────> review ──accept──> done
              running ──report(blocked/failed)──> blocked/failed ──reassign/retry──> assigned
              任意未终态 ──cancel──> cancelled
Attempt: queued ──dispatch/claim──> running ──report──> waiting/ready/blocked/failed/dropped
         queued/running/waiting ──改派或关闭──> cancelled
```

不变量：

1. 同一 task 同时最多一个 `running` 的 attempt；重试 = 新建 attempt，旧 attempt 保持终态。
2. `report` 只能由 attempt 的 assignee 写；lead 只能 assign / reassign / close / cancel，不能改写 report。
3. `done` 由 lead 或用户确认，不由成员自报「ready」直接置 `done`（成员只能报 `ready`，进入 `review`）。
4. 任务关闭后不可重开；需要继续就新建 task 并关联旧 task。

### 3.4 可见性

- lead：项目内全部任务、全部 report、成员忙闲；
- 成员：自己名下的任务与 report，以及被 lead 明确共享的上下文；
- 用户：全部（面板）。
- 子智能体：什么也看不到（§8）。

## 4. 存储

### 4.1 布局

```
<memoryDir>/team/projects/<projectId>/
  project.json       项目元数据（成员、lead、容量、roomId）
  tasks.json         任务与 attempt 的物化状态（原子写）
  events.jsonl       追加式事件流（审计与恢复依据）
```

事件类型：`project.created`、`member.added/removed`、`task.created`、`task.assigned`、`attempt.started`、`report.recorded`、`task.closed`、`task.cancelled`。`tasks.json` 可由 `events.jsonl` 重建（派生数据），源事件永远可读。

### 4.2 写入规则

- **单写者**：所有 team 写入走同一个模块，`team/store.js`，不散落在工具与 HTTP 处理器里。
- **每项目一把锁**：`withProject(projectId, fn)` 串行化读改写；Node 单线程但 async 处理器会交错，锁是 promise 链。
- **原子写**：沿用 `store.js` 的 `writeAtomic`（临时文件 + rename）；事件追加用 `appendFileSync`。
- **不引入 SQLite**：项目/任务规模是百级，vault 的哲学是「文件可手改、可备份、可迁移」；检索复用知识库。

### 4.3 恢复

启动时（`apply` 内）扫描所有 `project.json` 的 `tasks.json`：

- attempt 处于 `running` 且 `events.jsonl` 最后一条超过 `staleMs`（默认 30 分钟）→ 标 `failed`，事件 `attempt.stale`，面板可见；
- 或按配置续跑：重新 dispatch 同一 attempt（幂等键不变，不会重复投递）。

不启动后台轮询；恢复是一次性扫描，其余靠事件驱动。

### 4.4 与现有文件的边界

- `agents.json` 只读：项目引用 agent id，删除智能体前需先移出项目（否则项目标 `invalid`）。
- `bindings.json`：只在创建/复用成员会话时写，复用 `agent.newSession` 的路径。
- 不写知识库、不写记忆：任务与知识/记忆的关联由成员自己用现有工具完成（§7）。

## 5. 分配与唤醒

### 5.1 分配流程（lead 侧）

```
team_task_assign(task, member):
  1. 校验：调用者是 lead；task 属于本项目；member 在 members 里；
     task 未终态；项目容量未满。
  2. 事务内：task.status=assigned，task.assignee=member；
     新建 attempt(state=queued)；写事件 task.assigned。
  3. 事务后：入队 dispatch effect（key=`dispatch:${attempt.id}`）。
  4. 返回：attempt 摘要 + 当前容量。
```

容量满时返回 `queued` 而非拒绝：任务留在 `assigned`，等槽位。

### 5.2 唤醒（成员侧）

`dispatch` handler：

```
1. ensure 成员会话：
   - bindings 里已有该成员的活跃会话 → 复用；
   - 否则 sessionController.create + setBinding（与 agent.newSession 相同）。
2. agent.followup(task brief + attempt id + 汇报要求)：
   - 确定性 message id（`vault-team:${attempt.id}`），重试不重投；
   - 先 flush session persistence 再返回，保证重启后不重复。
3. attempt.state=running；写事件 attempt.started。
```

依赖 DSH 的 agent inbox API（`followup`/`steer`/`inject` + `sessionPersistence.flush`），superagent 已验证这条路径（`src/app/delivery.ts:78-85`）。

**降级**：若目标 profile 不提供该 API，`dispatch` 停在 `assigned`，面板标「待成员领取」；成员用 `team_task_claim` 主动领任务，claim 后写 `sessionId` 并进入 `running`。降级路径必须能独立工作，不能成为死胡同。

### 5.3 容量与优先级

- 容量按项目：`capacity`（默认 3），统计 `running` 的 attempt。
- 人的消息优先：用户在面板直接给成员发消息时，允许占用 `capacity+1` 的槽位（对应 superagent 的 `by === 'person'`）。
- 新分配排队：`dispatch` 发现无槽位 → `Later` 语义（不记失败、退避重试），不阻塞其它项目。

### 5.4 失败与重试

- **transient**（模型/网络）：最多 3 次，5s/30s/60s 退避；仍失败 → attempt `failed`，relay 给 lead。
- **确定性失败**（brief 无效、成员不存在、任务已关闭）：不重试，直接 `failed` + relay。
- 不学 superagent 的「无死信」：超过上限必须进 `failed` 终态，面板可见；否则重试风暴会把队列变成噪音。

### 5.5 与人的关系

- 用户可以在面板上直接 assign/改派/取消，不需要经过 lead。
- 用户消息与 lead 消息在成员会话里都是 user message；任务 brief 标明来源（lead/用户）与 attempt id。

## 6. 汇报协议

### 6.1 成员工具

```
team_task_report(task, state, summary, question?, files?)
```

- 只有当前 attempt 的 assignee 能报；
- `summary` ≤ 600 字，写给负责人看；细节放知识库或文件，summary 里给路径；
- `question` 非空 → attempt `waiting`，relay 给 lead（lead 再决定问人还是自己答）；
- 报 `ready` → task 进 `review`，等 lead/用户验收；报 `blocked`/`failed`/`dropped` → 对应状态。

`team_task_list`：成员只看自己的；lead 看全项目。

### 6.2 状态语义

| state | 含义 | 是否 relay 给 lead |
|---|---|---|
| `progress` | 还在做，阶段进展 | 否（只写事件） |
| `waiting` | 需要输入/答复 | 是 |
| `ready` | 完成，可验收 | 是 |
| `blocked` | 卡住，需要人/负责人决策 | 是，面板标红 |
| `failed` | 做不了/失败 | 是，面板标红 |
| `dropped` | 判断不该做/不需要 | 是 |

### 6.3 relay 给 lead

- `report` 写入 attempt + 事件，事务后入队 `relay`（key=`relay:${attempt.id}:${report.at}`）；
- `relay` handler 把 summary + question 投给 lead 的会话（`followup`，幂等）；
- lead 会话不存在或归档 → 停在队列；lead 回来时补投，不丢。

### 6.4 不轮询

lead 不需要主动查任务；report 与人的消息会自己到。lead 可用 `team_member_status(member)` 问一个 idle 成员（对应 superagent 的 `requestStatus`），但这是显式动作，不是后台循环。

## 7. 与记忆 / 知识库 / 讨论室

- **不自动写记忆**：任务完成不触发任何自动写入；成员自己决定 `agent_memory_save`（交接）与 `agent_knowledge_write`（详细经验），沿用 2.x 的哲学：记忆由用户决定读入，知识由模型决定查写。
- **项目作用域**：知识条目增加可选 `project` 标签（写入时传、检索时过滤）；不传 = 全局。默认行为不变，只有显式传 `project` 才收窄。
- **任务与知识关联**：task 可记录 `knowledge` entryId[]（可选，由 lead 或成员在 report 里附带）；面板可跳转。
- **讨论室**：项目可绑定 `roomId`；创建项目时可邀请成员入房；房间成员管理仍归用户，vault 不自动发消息进房间。
- **journal**：不动，保持私有。
- **记忆注入**：不变。团队层不向 `systemPrompt` 注入任何东西；任务 brief 只作为 user message 进成员会话。

## 8. 子智能体（官方）

- 成员开子智能体 = 直接调用 DSH 官方 `subagent` 工具；vault **不注册、不装饰、不追踪、不分配任务**。
- 子智能体没有 vault 特性：没有绑定、没有记忆注入、没有知识/journal/房间工具。这是**接受的边界**，不是缺陷；团队层不为子智能体补任何东西。
- 成员的职责：把子智能体的产出转成 `team_task_report` 的 summary 或知识条目；子智能体不写 team 记录、不占项目容量（容量只算成员的 running attempt）。
- 权限：子智能体继承成员的权限；若要收紧，靠成员 preset 的工具预算（vault 不改 preset、不调权限）。

## 9. 工具与 API

### 9.1 工具清单

| 工具 | 调用者 | 作用 |
|---|---|---|
| `team_project_create` | 用户/lead | 建项目（name、lead、members） |
| `team_project_list` | 任意已绑定智能体 | 列出项目与任务计数 |
| `team_member_add` / `team_member_remove` | lead | 成员增删 |
| `team_task_create` | lead/用户 | 建任务（title、brief、acceptance、assignee 可选） |
| `team_task_assign` | lead/用户 | 分配给成员，入队 dispatch |
| `team_task_report` | 成员 | 写 report，驱动状态 |
| `team_task_list` | lead/成员 | 列表（成员只读自己的） |
| `team_task_claim` | 成员 | 降级路径：主动领 assigned 任务 |
| `team_task_close` | lead/用户 | 验收（done）或取消（cancelled） |
| `team_member_status` | lead | 问 idle 成员要状态 |

授权规则：所有 team 工具都要求当前会话已绑定智能体（复用 rooms/journal 的 `requireSpeaker` 逻辑，`index.js:551-560`）；lead 操作校验 `project.lead === bound`；成员操作校验 `attempt.assignee === bound`。

### 9.2 HTTP 与面板

- HTTP：`/api/agent-memory` 下新增 `team.state`、`team.project`、`team.task`、`team.ops`（与现有 op 模式一致，`index.js:1332`）。
- 面板新增「团队」页签：项目列表、成员、任务板（按状态分列）、报告时间线、手动 assign/close/取消；沿用 `client.js` 现有表格与抽屉组件。

### 9.3 返回形状

工具返回统一 `{ ok, ... }`，错误用 `MemoryError` code（`bad-project`、`no-member`、`not-lead`、`not-assignee`、`task-closed`、`capacity`），与现有 `guard()` 一致（`index.js:292`）。

## 10. 并发、恢复与容量

- 同项目串行（mutex），跨项目并行。
- 插件重启：一次性扫描 running attempt（§4.3）；lead 会话不存在时按绑定重建；`dispatch`/`relay` 队列中的 key 幂等，重放安全。
- 会话归档：沿用 vault 的 archive 语义；「不销毁」= 智能体身份、任务历史、知识保留；会话可以归档以控制上下文。
- 上下文成本：attempt 结束可建议归档该会话；长项目用 checkpoint（借用 `sleep.js` 的折叠思路，但不自动注入，只在面板/工具里可查）。

## 11. 安全与边界

- 授权全部在工具入口做，不依赖提示词：`requireSpeaker` + lead/assignee 校验 + 项目归属校验。
- 注入面：brief ≤ 4000 字、summary ≤ 600 字、report 原文不进 systemPrompt；brief 以 user message 进入，来源标 `vault-team`。
- 不扩大权限：不调 `permissionPresets`、不改 preset、不创建高于调用者的会话。
- 删除智能体：若仍属于任何项目，拒绝删除并列出项目（或要求先移出）。

## 12. 分期落地

| 期 | 范围 | 验收 |
|---|---|---|
| P0 | 领域模型 + 文件存储 + 工具（project/task/assign/report/list/close），无唤醒 | **已完成（2026-11-26）**：`team/store.js`、`registerTeamTools`、`test-team.mjs` 全绿；文件落盘正确、重启可读、非法操作返回固定 code |
| P1 | 唤醒 + relay（依赖 DSH inbox API）+ 降级 claim 路径 | **已完成（2026-11-26）**：`team/dispatch.js` 用 `agent.followup` 唤醒成员、把非 progress 的 report relay 给 lead；确定性消息 id + inbox/历史检查防重投；宿主不支持 inbox 时停在 queued，claim 路径保留 |
| P2 | HTTP ops + 面板「团队」页签 | 面板可建项目、派任务、看报告；与工具操作一致 |
| P3 | 项目作用域知识、房间绑定、恢复与容量、归档建议 | 项目过滤检索正确；重启恢复正确；容量不超卖 |

每期结束跑 `npm test`（现有 node 测试风格），并补 `test-team.mjs`。

P0/P1 的落地差异：分配后由 `team/dispatch.js` 自动唤醒成员（找到或新建成员绑定会话，`agent.followup` 投递任务 brief，随后 attempt 置 `running`）；成员报 `waiting/ready/blocked/failed/dropped` 后自动 relay 给 lead 的绑定会话（没有绑定会话则留在待投队列，不新建 lead 会话）。队列是派生状态：`pendingDispatches` = assigned + queued attempt，`pendingRelays` = 有 report 且无 `relayedAt`，重启后重放。消息 id 固定为 `vault-team:dispatch:<attemptId>` / `vault-team:relay:<attemptId>:<at>`，发送前查 inbox 与历史，避免重投。宿主没有 inbox API 时，attempt 停在 `queued`，成员仍用 `team_task_claim` 领取。`team_project_list` 是为发现项目补的只读工具。任务被改派或关闭时，未完成的 attempt 记为 `cancelled`（新增于 `team/store.js`，不在原设计的状态表里）。

## 13. 开放问题

1. **lead 的会话**：lead 用现有绑定会话，还是项目专属会话（`project-<id>`）？谁创建、谁唤醒？建议 P0 只记录 lead 的 agent id，P1 再定会话策略。
2. **与 DSH 官方 Agent Teams 的关系**：目标 profile 若启用了 `team_task_*`/`send_message` 原语，vault 是把它们当传输层复用，还是并存？建议先确认目标 profile 是否带这些工具，再决定 P1 的 relay 实现。
3. **唤醒 API 的权限**：vault 所在进程能否对任意智能体 `followup`？需要一次实机验证（用一个测试会话）。
4. **成员被用户直接使用**：用户在一个普通对话里用某成员时，它的 team 任务状态如何与对话隔离？建议按会话绑定区分，任务状态全局。
5. **多成员同 repo 并发写**：靠 task 的 scope 约定（不同目录/文件域），还是给每个 attempt 分配工作区？P0 先靠约定。
6. **项目删除/成员移除**：历史任务保留还是随项目归档？建议保留，项目 `archived`。
