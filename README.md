# dsh-agent-vault

> npm 包名是 **dsh-agent-vault**（原 `dsh-agent-memory` 在 npm 上已被他人占用）。

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的智能体记忆与知识库插件。

每个智能体有一段**可继承的短记忆**；所有智能体共用**一个详细的共享知识库**；每个对话可以单独绑定一个智能体，因此同一时间可以有多个对话分别处于不同角色。

---

## 它解决什么

DSH 的会话本身是无状态的。跨任务时，你需要自己把上下文重新灌进去；而做完一件事之后，踩过的坑、验证过的命令、为什么这么选，通常散落在对话里，下次用不上。

这个插件补两块：

- **记忆**：智能体在任务完成或交接时，把结果压缩成一段很短的话（默认上限 4000 字）。这段记忆不自动生效——**由用户决定**把它读进哪个对话。
- **知识库**：详细经验（路径、命令、坑、决策理由）。**由智能体自己决定**什么时候查、查什么、何时补充。

两者权限刻意分开：模型没有任何"读记忆"的工具，只能写；知识库的读则只对模型开放，用户侧只能浏览和编辑。

## 功能

| 能力 | 说明 |
|---|---|
| 智能体管理 | 新建 / 改名 / 删除，互不影响 |
| 短记忆 | 每个智能体一份，上限可配，面板里直接编辑，改动留审计日志 |
| 共享知识库 | 所有智能体读写同一库，每条记录贡献者，支持搜索 / 标签 |
| 按对话绑定 | 新建对话时在下拉里选智能体；各对话互不干扰 |
| 记忆注入 | 只注入该对话绑定（或默认）智能体的记忆 |
| 记忆不自动读 | 面板里没有任何"注入"入口，只有绑定；模型侧也没有读记忆的工具 |
| 知识库自主查 | `agent_knowledge_search` / `read` / `write` 由模型自行决定调用 |
| 讨论室 | 可建多个房间；用户指定哪些智能体加入，成员可中途加入或退出；每条发言标注是哪个智能体说的 |
| 私有日志 | 每个智能体一份详细的日记式记录，**只有它自己能读写**，按需检索，不自动注入 |
| 接力（检查点） | 上下文到阈值时提醒模型先写记忆和日志，两件都完成后自动把检查点写进该智能体的日志；可选额外导出 markdown；settle 后新会话自动继承绑定、审批策略与模型，面板「续会话」一键续到新会话；可开启「检查点后自动开启新对话」，并在新对话里自动发送一条「启动指令」 |
| 自动归档 | 续会话/新会话接管后，旧会话自动转为**归档**（只读、可查看、不能继续）；面板「对话」页签可取消归档、转**强归档**（侧栏隐藏、面板灰色）或转回归档 |
| 侧栏右键菜单 | 侧栏「智能体对话」里右键对话：打开 / 归档 / 转化为强归档 / 取消归档 / 在该智能体名下新建对话；Ctrl（⌘）点击切换选中、Shift 点击区间多选，右键作用于整个选中集合；右键智能体行可新建对话或收起/展开 |

## 安装

DSH 插件以 profile 包的形式安装。任选一种：

> **npm 版本注意**：已发布的 1.2.0 / 1.3.0 漏打包了 `archive.js`（`index.js` 却静态导入它），安装后 Node 会报 `ERR_MODULE_NOT_FOUND`，DSH 把它标记为启动失败。请使用 1.3.1；在 1.3.1 发布前，用源码目录安装（`dsh plugin --profile <你的 profile> add /path/to/dsh-agent-vault`）或 `link:` 安装。

### 方式一：从目录安装

```bash
dsh plugin --profile <你的 profile> add dsh-agent-vault
```

也可以直接从目录装：

```bash
dsh plugin --profile <你的 profile> add /path/to/dsh-agent-vault
```

### 方式二：手工加到 patch 层

把仓库放到任意位置，然后确保 profile 的 `node_modules` 能解析到它（`pnpm add link:<路径>`），再在 profile 的 `cordis.patch.yml` 末追加：

```yaml
- insert:
    - id: agent-memory
      name: "dsh-agent-vault"
```

**装完必须完全退出并重开 DSH**，不要依赖热加载。

## 配置

配置写在插件条目上，全部可选：

```yaml
- insert:
    - id: agent-memory
      name: "dsh-agent-vault"
      config:
        memoryDir: "D:\\dsh\\agent-memory"   # 记忆与注册表根目录，默认 ~/.dsh/agent-memory
        knowledgeDir: "E:\\Agent-knowledge"  # 知识库目录，默认 <memoryDir>/knowledge
        memoryLimit: 4000                    # 记忆上限字数，500-20000
        entryLimit: 48000                    # 单条知识上限字数，2000-200000
```

知识库目录也可以直接在面板「设置」里改，立即生效（不迁移已有内容）。

## 数据布局

```
<memoryDir>/agents.json                 智能体注册表
<memoryDir>/settings.json               知识库目录、默认智能体
<memoryDir>/bindings.json               对话 → 智能体 绑定
<memoryDir>/memory/<agentId>.md         该智能体的记忆
<memoryDir>/memory/<agentId>.log.md     记忆写入审计（追加式）

<knowledgeDir>/<entryId>.md             共享知识库条目（front matter 带 agent 贡献者）

<memoryDir>/rooms/<roomId>/room.json     讨论室元数据（名称、成员）
<memoryDir>/rooms/<roomId>/messages.jsonl 讨论室发言（每行一条，带发言人）
<memoryDir>/journal/<agentId>.jsonl      私有日志（每行一条，只有该智能体可读）
<memoryDir>/handoff.json                 接力配置（阈值、导出目录）
<memoryDir>/handoff-state.json           每会话的接力阶段
```

全部是普通 Markdown / JSON，可以直接用编辑器改，也可以纳入 git。

## 模型侧工具

| 工具 | 作用 |
|---|---|
| `agent_memory_save` | 写该智能体的短记忆（覆盖式） |
| `agent_knowledge_search` | 检索共享知识库；空查询列出最近条目 |
| `agent_knowledge_read` | 读一条完整内容 |
| `agent_knowledge_write` | 新增或按 `entry` 修订已有条目 |
| `agent_room` | `action`: `list` / `read` / `say` / `join` / `leave`，参与讨论室 |
| `agent_journal` | `action`: `list` / `search` / `read` / `write`，读写**自己的**私有日志 |

工具通过调用会话的绑定解析智能体；显式传 `id` 时优先。`agent_journal` 永远只作用于调用方的智能体，**不接受其他智能体 id**，这就是隔离的实现方式。

## 接力（交棒检查点）

长时间任务会让单个会话堆到窗口边缘，越后面越贵、越容易复发早期已经修好的问题。接力做的事很简单：**在还来得及的时候，把这次工作沉淀成记忆和日志**。

| 阶段 | 发生什么 |
|---|---|
| watching | 每步进入前用 `ctx.tokenMeter.measure(session).totalTokens` 量压力，低于阈值什么都不做 |
| requested | 超过阈值：在该步的系统提示里插入一条交接提醒，要求模型先用 `agent_memory_save` 写记忆、再用 `agent_journal` 写一条详细日志 |
| ready | 检测到记忆的 `memoryUpdatedAt` 与最近一条普通日志都**晚于这次提醒** → 生成检查点 |
| settled | 检查点写进该智能体的日志（`kind: "checkpoint"`），本会话继续用，不再重复提醒 |

要点：

- **检查点就是一条日志**，不是工作区里的文件。它天然属于该智能体、天然隔离、天然能用 `agent_journal` 找回来。
- 记忆或日志掉回阈值 90% 以下（例如手动压缩过），这次请求会被清掉，允许下次重新触发。
- **提醒不换会话、不打断**：它只是在那一步的系统提示里多一段话，模型照常继续手上的工作。

### 阈值

只有一个 `triggerTokens`，默认 **300000**，是**绝对值、不按窗口自适应**。

| 窗口 | 建议阈值 |
|---|---|
| 256K（官方默认） | 180000 |
| 512K 及以上 | 300000–350000 |

窗口越小越要往下调，否则永远不触发，看起来像插件没工作。

### 配置

面板「接力」页签可改，也可以直接写 `<memoryDir>/handoff.json`：

```json
{
  "enabled": true,
  "triggerTokens": 300000,
  "remindEverySteps": 2,
  "exportDir": "",
  "autoSwitch": false,
  "startupPrompt": "这是交接后的新会话（上下文已重置）。先读你最近的日志和交棒检查点（agent_journal），再搜共享知识库里的相关经验，确认上次的进度后继续完成工作；结束前更新记忆和日志。"
}
```

`remindEverySteps` 控制提醒频率：超阈值后**每隔这么多步**才重复一次（默认 2）。第一次触发总会提醒，之后按这个间隔降噪；记忆和日志一落盘就彻底停止。`exportDir` 留空时就只写日志；填了会额外落一份 markdown（`checkpoint-<会话短 id>-<时间>.md`），方便用编辑器看或给别的工具读。`startupPrompt` 是自动切换后发给新会话的第一条消息，留空则只打开对话、不发消息（上限 2000 字）。

### 重置

「接力」页签的会话列表里，处于等待沉淀或已生成检查点的会话那一行会有「重置」。它只清掉该会话的阶段记录，让它重新从 `watching` 开始；已经写进日志的检查点**不会删除**。适合手动压缩过上下文、或者想在同一会话里再走一轮的时候。

检查点落盘后会记一个 30 分钟内有效的「下一会话」意图：在这个目录里新建的会话会自动绑定同一智能体，并继承审批策略、模型与 Agent preset（`resume`、子智能体和已绑定的会话不会误消费）。面板的「续会话」按钮把意图刷新 + 新建会话合成一步，并让新会话落在源会话所在的工作区、沿用源会话的模式。开启「检查点后自动开启新对话」后，客户端在回合结束、会话空闲时自动完成这套切换，旧会话自动归档；切换前会把「启动指令」写进交棒意图，新会话继承完成后由主机自动发送，作为它的第一条消息（手动「续会话」不发送）。API 事实与实现细节见 [docs/handoff-v2.md](docs/handoff-v2.md)。

## 面板

侧栏出现「智能体」图标，打开后：

- 左侧：顶部可在「智能体 / 讨论室」之间切换
- 智能体视图：列表显示记忆字数、贡献条数、被几个对话使用；右侧六个页签：记忆 / 对话 / 共享知识库 / 日志 / 接力 / 设置
- 对话页签：按智能体收拢它的对话（标题、工作区、时间、运行状态），可「打开」「解绑」；顶部可选工作区并「切换过去」或「新建对话」（新建的会话自动绑定该智能体）
- 讨论室视图：新建房间、点成员名字加入或移出、消息流、直接发言（Enter 发送）
- 记忆页底部列出正在使用它的对话（显示**对话标题 + 短 id**），可一键解除绑定

已绑定智能体的对话会从左侧工作区列表里隐藏（客户端展示层过滤，不改会话数据，搜索仍可命中）。设置页可以关掉这个隐藏行为。工作区上方还有一块「智能体对话」区，按智能体分组列出这些对话，点一下就能打开。细节与限制见 [docs/sessions-and-workspaces.md](docs/sessions-and-workspaces.md)。

新建对话时，新会话那一行右侧会出现「智能体」下拉。

讨论室的发言由**用户驱动**：在某个已绑定智能体的对话里让它「去讨论室说点什么」，它会用 `agent_room` 读上下文并发言；也可以由你直接在面板里发言。插件不做自动轮流发言。

## 侧栏右键菜单

侧栏「智能体对话」段（vault 自建的列表）支持右键：

| 位置 | 菜单 |
|---|---|
| 对话行 | 打开 / 归档 / 转化为强归档 / 取消归档 / 在「该智能体」名下创建新对话 |
| 智能体行 | 在它名下创建新对话 / 收起或展开它 |

- **多选**：Ctrl（macOS ⌘）点击切换单个对话的选中；Shift 点击在**同一智能体**内从锚点扩选。选中的行有底色，右键点了已选行时保留整个选区，否则选区重置为光标下的那一行。菜单头会显示「已选 N 个对话」。
- **动作落在整个选区上**：归档 / 强归档 / 取消归档对每个选中对话并发调用 `archive.set`，全部成功才提示成功，任一失败会在底部弹条里给出错误。
- 菜单项按选区当前状态禁用（都已归档就不能再归档；没有已归档的就不能取消归档；都已强归档就不能再转强归档）。
- 键盘：打开后方向键上下移动，Esc 或点击别处关闭。
- **在智能体名下创建新对话**：取该智能体最近一个已绑定对话的工作区，调用 `agent.newSession` 新建会话并立即绑定，然后切过去；没有历史对话时会话落在默认工作区。它不继承审批策略（那是「续会话」/ 交接的语义），需要继承时用面板的「续会话」。

## 已知限制

- **改动插件后必须完全重启 DSH。** 运行中热加载这类 Host 插件会让工具执行上下文失效（所有工具报 `cannot get requested service "sessionProjections" in inactive context`）。这是实测结论，与插件逻辑无关。
- 知识库是全库共享：不做按智能体的隔离，只有贡献者标记（私有日志才是隔离的）。
- 讨论室不自动调度发言，也不限制谁先说；顺序完全由使用方式决定。
- 对话标题来源有两处：live 会话走 `sessionTitle` 服务，已关闭会话读投影缓存；两者都取不到时显示「未命名对话」。
- 面板的视觉细节依赖宿主主题变量 `--dsw-alias-*`，换主题不会破版，但不会跟随自定义设计系统。

## 开发

纯 JavaScript，无构建步骤。两个半片：

- `index.js` — Host：工具、提示词段落、`/api/agent-memory` 路由
- `client.js` — 浏览器：面板与新建对话选择器（手写 ModuleLoader bundle）
- `store.js` — 存储层，不依赖 Cordis，可单独测试
- `rooms.js` — 讨论室存储
- `journal.js` — 私有日志存储
- `handoff.js` — 接力：配置、每会话阶段、检查点文本与导出
- `archive.js` — 归档级别（`weak` / `strong`）的持久记录

测试（无需安装依赖）：

```bash
node test-package.mjs    # 打包保护：import 链上的文件必须都在 package.json files 里
node test-store.mjs      # 记忆与知识库文件层
node test-host.mjs       # 用 mock ctx 跑注册、工具与 HTTP 分发
node test-migrate.mjs    # 旧「按智能体分目录」布局合并到共享库
node test-binding.mjs    # 对话绑定与解析优先级
node test-rooms.mjs      # 讨论室：成员、中途加入、发言顺序
node test-journal.mjs    # 私有日志与跨智能体隔离
node test-handoff.mjs    # 接力：阈值、requested→ready、检查点文本、启动指令与导出
```

## 致谢

- **[dsh-degeneration-kit](https://github.com/walksls/dsh-degeneration-kit)** —— 「接力」的思路来源：它让上下文不空转，这里负责换会话时不丢上下文。

## 许可

MIT，见 [LICENSE](LICENSE)。
