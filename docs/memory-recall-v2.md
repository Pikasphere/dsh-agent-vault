# 记忆召回 v2：日志层检索 + 检查点隔离（设计草案）

> 状态：**草案，未实现**。目标版本 `2.0.0-alpha.1`（alpha 阶段允许破坏性调整；beta 起冻结返回契约）。
> 本文只描述设计与验收口径；落码前请先用 `cordis_inspect_query` 复核文中引用的 API 行号与 DSH 预览版行为。

## 1. 问题

现在的记忆体系只有两条通道：

- **4K 短记忆**（`store.js:26` `MEMORY_LIMIT = 4000`，覆盖式）——可靠，但容量封顶，写多了只能删；
- **日志层**（journal / 记忆审计 `*.log.md` / 知识库；讨论室是半成品，本版不接）——容量大，但只能被"主动翻"，模型往往想不起来去翻。

用户反馈的核心不是"记不下"，而是**不写进 4000 字的内容，模型不够敏感**。把记忆做大只会稀释权威性；正确的做法是把"现状"与"回忆"分成两层：现状继续写死、始终注入；回忆按需检索、按需注入。

另一条缝隙是**字面检索连不上同实体的不同说法**：「vault 插件」与 `dsh-agent-vault` 指同一件事，但词汇检索不会把它们连起来。这条由 §6.5 的关联扩展补，顺序是先跑纯词汇基线、再叠加扩展。

这与 1.3 已确立的接力（handoff）思路一致：检查点负责"当前状态"，日志负责"过程材料"。

## 2. 目标与非目标

| 编号 | 目标 |
|---|---|
| G1 | 日志层可检索：一条 query 在 journal、记忆审计、知识库上统一召回（讨论室是半成品，2.0 明确不接） |
| G2 | 检查点**结构性隔离**：存储、索引、注入三处都不与日志混流 |
| G3 | 缓存零伤害：检索结果只能作为工具返回值出现，不得进入 `systemPrompt.section` / `context` |
| G4 | 索引是派生数据：删掉可全量重建，源文件（JSONL/MD）永远是唯一真相 |
| G5 | 中文可用：`query:"归档"` 必须命中"取消归档" |
| G6 | 关联扩展：1 跳、只扩检索结果、边不落盘、不做画布（M2.5） |

非目标（2.0 不做）：

- 不替换 4K 短记忆，不改 `agent_memory_save` 语义；
- 不索引对话原文（`~/.dsh/sessions`，2.1 再议）；
- 不引入嵌入模型 / 向量库（见 §11 "为什么先不做 embedding"）；
- 不改动现有 op 的返回契约（只新增字段）；
- 不做图可视化画布（力导向图是独立工程，模型不读它；面板只加"关联"徽标）。

## 3. 现状事实（2026-10-28 实测）

### 3.1 数据规模

| 数据 | 位置 | 实测规模 |
|---|---|---|
| 短记忆 | `<memoryDir>/memory/<agentId>.md` | 每 agent ≤ 4000 字，当前 2–2.6KB |
| 记忆审计 | `<memoryDir>/memory/<agentId>.log.md` | 单文件最大 66KB（`demo-agent`） |
| 私有日志 | `<memoryDir>/journal/<agentId>.jsonl` | 2 个 agent、37 条、80KB，其中 6 条 checkpoint |
| 知识库 | `<knowledgeDir>/<entryId>.md` | 21 条 |
| 对话原文 | `~/.dsh/sessions/.../session.v4.jsonl.zstd` | 110 个会话、52MB（本版不索引） |

结论：**当前规模不需要任何数据库**。进程内全量索引（37 条）毫秒级完成。规模上到万级再换 FTS5。

### 3.2 已有能力（可直接复用）

- `journal.list` 已做 token AND 匹配 + 160 字预览，并**默认隐藏 checkpoint**（`journal.js:86-113`，过滤在 `journal.js:92`）。
- `store.js:126` `score(entry, tokens)` 已有"标题 ×6 / 标签 ×4 / 正文计数"的加权打分，被 `searchKnowledge`（`store.js:539`）使用。
- `journal.read`（`journal.js:115`）可按 id 取全文——索引只存摘要，命中再读，是正确的形态。
- handoff 已把检查点写成 `kind:"checkpoint"` 的日志条目（`index.js:683` `writeCheckpoint`、`handoff.js:224` `buildCheckpointText`）。

### 3.3 注入点与缓存基线

- 系统提示注入：`index.js:107` `buildPrompt` → `systemPrompt.section({ name:'agent-memory', order:120 })`（`index.js:163-170`），内容只在记忆/绑定变化时变。
- 另有一个**动态上下文**：`index.js:954-964` 的 `systemPrompt.context({ name:'agent-handoff', order:121, text: context => hints.get(sessionIdOf(context)) ?? '' })`，承载 handoff 压力提示（`hints.set` 在 `index.js:848`，文案由 `index.js:444` `handoffHint` 生成），按步注入——这是已知的缓存隐患（见 §8.3）。
- 本会话缓存实测：162 次请求，命中率 97.3%，按请求中位命中 99.6%；miss 合计 288.9K（新内容 140.0K + ACP 压缩重付 147.2K）。

## 4. 分层模型

| 层 | 内容 | 进 prompt | 进索引 | 可变性 |
|---|---|---|---|---|
| **L0 检查点** | 每 agent **最新一份** checkpoint 文本 | 是（权威段，固定位置） | ❌ | 仅在 handoff settle 时原子替换 |
| **L1 短记忆** | `memory/<agentId>.md` | 是（`<agent_memory>` 段） | ❌ | 仅 `agent_memory_save` |
| **L2 日志** | journal `note`、`*.log.md`、knowledge | 否（只有检索命中时以工具结果出现） | ✅ | 追加为主 |
| **L3 对话原文** | 会话压缩包 | 否 | ❌（2.1 可选） | 只追加 |

规则只有一条：**L0/L1 是权威，L2/L3 是材料**。检索永远不能返回 L0/L1，否则过期快照会被当成现状。

## 5. 数据模型 v2

### 5.1 目录隔离（G2 的落地）

```
<memoryDir>/memory/<agentId>.md          短记忆（不变）
<memoryDir>/memory/<agentId>.log.md      记忆审计（不变，新增索引）
<memoryDir>/journal/<agentId>.jsonl      日志（只含 ns:"note"）
<memoryDir>/checkpoints/<agentId>.jsonl  检查点（新增，从 journal 迁出）
<memoryDir>/index/state.json             索引游标（新增）
<memoryDir>/index/aliases.json           别名表（新增，手填或 agent 维护）
<memoryDir>/rooms/...                    讨论室（半成品，不建索引、不参与召回）
```

- 条目结构不变：`{ id, at, kind, title, text, meta? }`，新增可选 `ns: "note" | "checkpoint"`，缺省按 `kind` 推断。
- `journal.list` / `journal.read` 做**跨文件合并**：先读 `journal/`，再读 `checkpoints/`，`includeCheckpoints` 默认仍为 `false`（向后兼容 1.3 行为）。
- `journal.delete` 同时作用于两个目录。

为什么移动而不是加过滤：过滤靠调用方记得传参，移动靠文件系统。索引器只扫 `journal/*.jsonl` 与其它 L2 源，物理上就看不到检查点。

### 5.2 索引游标

```json
{ "version": 2, "builtAt": "2026-10-28T13:20:00.000Z",
  "sources": { "journal": { "agent-6sbx": 40960 }, "memlog": { "agent-6sbx": 11264 } } }
```

- append-only JSONL 用**字节偏移**做增量：只读 `offset..EOF`，解析新行入索引，再推进偏移。
- 文件被手工编辑（长度回退 / 内容哈希变化）→ 该源全量重建。
- `memory.reindex` op 清空偏移并全量重建（面板按钮）。

### 5.3 迁移

1. `migrate.js` 增加 v1→v2 步骤：扫描 `journal/*.jsonl`，把 `kind==="checkpoint"` 的行原样搬到 `checkpoints/<agentId>.jsonl`，再从源文件重写（去掉这些行）；条目 id / at 保持不变。
2. 写 `index/state.json` 骨架；首次启动惰性建索引。
3. 降级安全：旧版（1.3.x）读不到 `checkpoints/` 只会丢失"checkpoint 可见性"，不会写坏数据；README 注明"从 2.0 降到 1.3 前请先把 checkpoints 目录并回 journal"。

## 6. 检索层（`rank.js`）

新模块，纯函数、无 IO，供 `agent_recall`、`agent_journal search`、`agent_knowledge_search` 共用。

### 6.1 分词（G5 的硬要求）

```
tokenize(text) →
  ASCII 词：/[a-z0-9_.\-]+/gi，小写
  CJK：每 2 字一个 bigram（"取消归档" → 取消/消归/归档）
  数字：独立 token
```

**必须修掉的现状问题**：`journal.list`（`journal.js:98`）与 `searchKnowledge`（`store.js:542`）都按 `split(' ')` 切词，中文只能整段命中。

### 6.2 打分

复用 `store.js:126` 的权重思路，但改两处：

1. **AND → OR + 覆盖率**：现在 `hit === 0` 直接淘汰（AND），长 query 极易零结果；改为
   `final = (Σhit) × (命中 token 数 / 总 token 数)^2`，覆盖率平方压住"只命中一个高频词"的噪声。
2. **时间衰减**：`decay = 0.5 ** (ageDays / 30)`，30 天半衰期；可被 `pinned`（检查点永远不参与，但知识条目可 pin）。

排序：`score = final × decay × boost`，`boost` 为同 agent 1.0 / 共享知识库 0.9。

### 6.3 返回形态

```json
{ "query": "...", "total": 3, "results": [
  { "id": "j-ab12", "src": "journal", "at": "2026-10-27T...", "title": "...", "preview": "≤160 字", "score": 12.5 } ] }
```

正文一律 `read` 取；单次最多 25 条，`preview` 硬截 160 字。

### 6.4 评测集（`test-recall.mjs`）

固定语料 + 断言：

- 中文：`query:"归档"` 命中"取消归档 / 强归档"条目；`query:"记忆"` 的 top-1 正确；
- 英文/混排：`query:"handoff checkpoint"`；
- 时间：同分时较新者靠前（构造两条同分条目）；
- 隔离：`query:"checkpoint"` **永远不返回** `ns:"checkpoint"` 条目；
- 空 query：返回最近 N 条（保持"空查询=最近"的既有约定）；
- 性能：1000 条语料下 < 20ms（进程内）。

### 6.5 关联扩展（图，M2.5）

词汇检索只能连"字面像"的条目；同一条工作线里"字面不像、实体相同"的材料连不上。方案：**在检索结果上做 1 跳图扩展**，只用于召回。

原则：边全部即时计算、不落盘；只扩 1 跳；扩展条目数封顶；每条结果标注来源。

#### 节点

- **条目节点**：journal `j-*`、知识库 id、记忆审计条目（以 `agentId + 时间戳` 为键）。
- **实体节点**：从正文自动提取的标识符，不建可编辑器（避免维护负担）。

#### 边

| 边型 | 判定 | 权重 |
|---|---|---|
| `ref` | 正文出现另一条目的 id（`j-[a-z0-9]{4,16}`、知识库 id） | 0.9 |
| `entity` | 两条条目共享 ≥1 个实体 | 0.6 × min(1, 共享实体数 / 2) |
| `session` | 同一 `sessionId`（journal `meta.sessionId` / 记忆审计行） | 0.5 |

不建"同工作区"边：`E:\Projects` 这种粒度会把所有项目连成一个团。

#### 实体提取（白名单形状，宁缺毋滥）

```
[A-Za-z]:\\[^\s"'，。]+                                   Windows 路径
/[A-Za-z0-9_.-]{4,}/                                      Unix 路径
agent-[a-z0-9]{4}                                         智能体 id
j-[a-z0-9]{4,16}                                          日志条目 id
[\w-]+\.(js|mjs|md|json|yml|yaml|ts|py|exe|zst|svg)        文件名
[a-z_]+(\.[a-z_]+)+                                        op / 工具名
[a-z0-9][a-z0-9-]{5,}（必须含 `-`）                          包 / 仓库名
```

过滤：纯数字、单字母、长度 > 64、通用词表（`windows`、`node`、`json`、`true` 等）不入实体——否则整张图会被"json"这类词连成一片。

#### 扩展算法

```
seeds     = rank(query, k=8)
alias     = aliases.json 把 query 里的别名展开成实体（命中别名时 seed 权重 ×1.2）
neighbors = seeds 的 1 跳邻居，边权 ≥ 0.35，去掉已在 seeds 里的
extra     = neighbors 按 (seed.score × edgeWeight × 0.3) 排序，取前 5
final     = seeds ∪ extra，总数 ≤ limit
via       = "lexical" | "alias" | "ref" | "entity" | "session"
```

- **为什么只 1 跳**：2 跳会穿过"共享一个常用实体"的弱连接，噪声增长远快于收益。需要更深时由模型用 `why.hub` 再调一次工具，可见、可控。
- **别名表**：`<memoryDir>/index/aliases.json`，形如 `{"vault 插件": ["dsh-agent-vault"], "鲸鱼": ["dsh-whale-widget"]}`。中文检索的别名收益高于边本身，而且加一行就生效。
- **边不落盘**：`journal.delete` 后立刻正确，省掉增量维护与迁移；当前 58 个节点量级重算 < 5ms。万级再考虑派生边表（可删、可重建）。

#### 输出契约

每条结果除 §6.3 字段外增加 `via` 与 `why`（`why` 只给扩展出来的条目）：

```json
{ "id": "j-x9k2", "src": "journal", "via": "entity",
  "why": { "hub": "dsh-agent-vault", "edge": "entity", "weight": 0.6 } }
```

#### 评测（追加进 `test-recall.mjs`）

- **实体桥**：A、B 字面不同但共享 `dsh-agent-vault`，query 只命中 A → B 以 `via:"entity"` 出现；
- **引用桥**：知识条目正文引用 `j-ab12` → 该日志条目以 `via:"ref"` 出现；
- **别名**：`query:"vault 插件"` → 命中 `dsh-agent-vault` 相关条目，`via:"alias"`；
- **反例**：query 只命中高频实体时，扩展后不得出现 > 2 条无关邻居；
- **隔离**：checkpoint 不作为节点参与扩展（§6.4 的断言在图上仍然成立）。

#### 与 UI 的关系

不做画布。面板结果列表对 `via != "lexical"` 的行加徽标（"关联·实体"/"关联·引用"），展开看 `why.hub`。

#### 缓存影响

扩展在工具调用内部完成，返回仍是尾部工具消息 → 不触碰系统前缀，零失效。

## 7. 工具面

### 7.1 新工具 `agent_recall`

| 参数 | 说明 |
|---|---|
| `query` | 必填；空串 = 最近 N 条 |
| `limit` | 1–25，默认 8 |
| `since` | ISO 日期，过滤下界 |
| `expand` | `0` / `1`，默认 `1`：是否做 1 跳关联扩展（`0` = 纯词汇，便于对比基线） |
| `source` | `journal` / `knowledge` / `memory-log` / 省略=全部。**2.0 不提供 `rooms`**：讨论室尚未完工（无调度、成员语义还在改），索引它等于把半成品固化进契约 |

host op：`memory.recall`。返回 §6.3 结构，扩展项另带 `via` / `why`（§6.5）。**不返回全文**，避免一次吃进太多 token。

### 7.2 与既有工具的关系

- `agent_journal search` → 内部改为调用同一个 rank，但只扫自己 journal（行为兼容，命中质量提升）。
- `agent_knowledge_search` → 同样切到共享 rank（AND→OR 会让结果变多，`limit` 默认保持 8）。
- 不合并工具：`journal` 是"自己的流水账"，`knowledge` 是"共享经验"，`recall` 是"跨源回忆"，语义不同。

## 8. 注入策略（缓存是硬约束，G3）

### 8.1 默认不自动注入

检索结果只在模型**主动调用工具**时出现，作为工具返回值追加在消息尾部：历史前缀字节不动 → 缓存零失效。

### 8.2 若将来做 auto-recall

只允许一种形态：**会话尾部追加一条 tool-result 形态的消息**（一次性），禁止改 `systemPrompt.section` / `systemPrompt.context`。原因：记忆段位于 `order:120`，系统提示一变，其后全部消息都要重新计费——本会话单请求 50–80K token，会直接把命中率从 97% 打到个位数。

### 8.3 已存在的两个隐患（M2 处理）

1. **handoff 压力提示**（`index.js:954-959`，order 121）按步注入带 token 数的文本：若每步都变，就是稳定漏点。改为"仅在跨过阈值时变一次"，或挪到工具结果。
2. **检查点文本的确定性**：注入的检查点必须逐字节稳定——单份文本、固定字段顺序、不写 ISO 时间戳/条目数/"3 分钟前"。

### 8.4 缓存验收

改动后跑 `acp_cache`：

- 命中率 ≥ 95%，中位 ≥ 99%；
- `line items` 里不得出现"comp=0 且 hit<85% 且每请求一行"的模式（那是每轮改前缀的特征）；
- `mid-history divergence` 只应来自 ACP 压缩 fold，不随 turn 数增长。

## 9. UI（M2）

- 面板新增「回忆」页签：搜索框 → 结果列表（来源徽标 / 时间 / 预览）→ 点击展开全文；命中条目带"回到面板会话"链接（复用 `agent.sessions` / `uiWorkspace.openSession`）。
- 设置区显示索引状态：条目数、`builtAt`、各源 offset；「重建索引」按钮 → `memory.reindex`。
- 召回面板纯前端查询，不影响 prompt，也不产生额外 token。

## 10. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M1** `2.0.0-alpha.1` | `rank.js`、`agent_recall`（`expand:0` 可用）、`memory.reindex`、checkpoints 迁移、`index/state.json`、`test-recall.mjs`、README 数据布局 | 全量测试通过；**记录纯词汇 top-1 基线**；checkpoint 不可召回；缓存无回归 |
| **M2** `2.0.0-alpha.2` | 面板「回忆」页签、索引状态卡片、handoff 提示节流 | 面板可用；`acp_cache` 命中率不降 |
| **M2.5** `2.0.0-alpha.3` | §6.5 关联扩展（`entity` / `ref` / `session`）、`aliases.json`、面板徽标 | §6.5 四条评测全过；扩展不引入缓存失效 |
| **M3** `2.0.0-alpha.4`（可选） | 对话原文入索引（脱敏、按会话勾选、体积上限） | 密钥/令牌不入索引；单会话增量 < 1s |

版本口径：alpha 之间允许破坏性调整（返回结构、字段名），**beta 起冻结契约**；npm 用 `--tag alpha` 发布，`latest` 保持 1.3.x 直到 `2.0.0` 正式版。

## 11. 风险与取舍

- **为什么先不做 embedding**：当前 L2 总量 80KB、37 条，关键词 + 衰减足够；embedding 引入模型端点、向量存储、幂等重建三件复杂事，收益在万级条目才显现。预留接口：`rank.js` 的 `score()` 可被向量相似度替换，`state.json` 增加 `embedding` 版本号即可。
- **中文分词**：bigram 会带来误召回（"记忆"命中"记忆化"），靠覆盖率平方 + 标题权重压制；`test-recall.mjs` 里必须有反例。
- **隐私**：L2 含路径与片段；M3 入对话层前需要脱敏规则（token/密钥正则 + 可选白名单目录）。
- **索引漂移**：手工编辑 JSONL 会让 offset 失效 → 长度回退检测 + 全量重建兜底。
- **性能**：1 万条以内进程内可行；超过后换 `node:sqlite` FTS5（Node ≥ 22.5 才有 `node:sqlite`，本机 CLI 为 v24.21.0 可用，但 **Electron 主进程的 Node 版本需单独确认**，这是引入前的必查项）。
- **破坏性**：2.0 的破坏只在"checkpoints 目录分离 + 条目 ns 字段"，旧版读取会缺 checkpoint 但不会写坏；`package.json` version 走 `2.0.0-alpha.N`，收口为 `2.0.0-beta.N`。

## 12. 开放问题

1. ~~`agent_recall` 默认是否包含讨论室？~~ **已定：不包含**。讨论室目前是半成品（不自动调度、成员语义未稳定），2.0 既不入索引也不开 `source`，等它完工后按 `src:"rooms"` 加回，`rank.js` 的 `boost` 表已为它留位（0.7）。
2. 是否允许跨 agent 召回？倾向**否**（journal 的隔离语义不能破），管理员视图另做。
3. `aliases.json` 由谁维护？倾向：agent 用新 op `memory.alias` 写，面板可编辑——手填的别名最可靠，但没人会填。
4. 检查点历史是否需要面板可读（只读时间线）？倾向 M2 做只读列表，但**永不进 prompt**。
5. `agent_journal list` 的 AND 语义改成 OR 后，是否影响既有调用方的预期？需要一次 CHANGELOG 明示。
6. ~~是否做图？~~ **已定：做检索侧 1 跳扩展、不做画布**（M2.5 / `alpha.3`），边不落盘。
