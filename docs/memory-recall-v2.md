# 记忆召回 v2：日志层检索 + 检查点隔离（设计草案）

> 状态：**M1 已实现**（`2.0.0-alpha.1`，2026-10-28）；M2/M2.5/M3 未开始。目标版本 `2.0.0-alpha.1`（alpha 阶段允许破坏性调整；beta 起冻结返回契约）。
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
- ~~不索引对话原文~~（M3 已做，见 §5.4；仍然只取 user/assistant 文本，工具输出与推理不入库）；
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
| 对话原文 | `~/.dsh/sessions/.../session.v4.jsonl.zstd` | 110 个会话、52MB；M3 起按归属索引 user/assistant 文本 |

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
{ "version": 1, "builtAt": "2026-10-28T21:40:00.000Z", "total": 61,
  "sources": { "journal:agent-6sbx": 3, "log:agent-6sbx": 0, "knowledge": 21 } }
```

- M1 的实际实现是**按文件 `(size, mtimeMs)` 判脏**，变了就整份重建该源，未变直接复用。当前语料（37 条笔记 / 80KB）全量重建只要几毫秒，字节偏移只在语料上万条时才有意义，故推迟到 M2.5 再做（届时改法：`offset` 记住上次读到的字节，只解析新行）。
- 文件被手工编辑（长度回退 / 内容哈希变化）→ 该源全量重建。
- `memory.reindex` op 清空缓存并全量重建，重写 `index/state.json`（面板按钮）。

### 5.3 迁移

1. **惰性拆分**（仓库没有独立的 `migrate.js`，旧知识库迁移也是 `store.js` 里惰性做的）：`journal.js` 的 `splitCheckpoints(agentId)` 在该智能体的日志第一次被读写时执行——若 `journal/<id>.jsonl` 里还有 `kind:"checkpoint"` 的行，就把它们原样追加到 `checkpoints/<id>.jsonl`，再重写笔记文件去掉这些行。幂等：拆分后笔记文件不再含检查点，探测成本是一次字符串 `includes`。条目 id / at 保持不变。
2. 写 `index/state.json` 骨架；首次启动惰性建索引。
3. 降级安全：旧版（1.3.x）读不到 `checkpoints/` 只会丢失"checkpoint 可见性"，不会写坏数据；README 注明"从 2.0 降到 1.3 前请先把 checkpoints 目录并回 journal"。

### 5.4 对话原文（M3）

会话文件是 `~/.dsh/sessions/<workspaceDir>/session-<uuid>/session*.jsonl.zstd`——zstd 帧格式，帧边界可从帧头推出（`0x184D2A50` 可跳过帧 + 标准 magic + 块头），因此不需要原生模块：`zstd-frames.mjs` 用 `zlib.zstdDecompressSync` 逐帧解压再拼接，约 70 行。

读取规则（`transcripts.js`）：

- **归属**：只读 `journals`（本智能体日志的 `meta.sessionId`）、`handoff` 配置、`bindings` 里属于此智能体的会话；不认识的一律跳过。会话 → vault 的映射由「该 vault 是否有权读」决定，而不是由目录结构猜。
- **取哪些行**：只取 `type` 为 user/assistant 且带文本的消息；`thinking`、工具调用与工具结果丢弃。
- **裁剪**：从最早一条往后累加，到 `TRANSCRIPT_LIMIT = 12000` 字符截断，末尾附 `[truncated]`；单会话输出成一条 `{id:'session-<uuid>', src:'session', at, title, text}`。
- **打码**：`sk-` 密钥、`Bearer <token>`、`api_key=`/`token=` 赋值、`ghp_`/`github_pat_` → `<redacted>`。只做正则替换，不保证穷尽，故仍把「对话入索引」做成显式开关。
- **缓存**：以 `(size, mtimeMs)` 判脏；会话仍是追加写，所以几乎只有活跃会话会重建。

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

### 6.4 评测

两层，各管一件事：

**机制层 `test-recall.mjs`**（离线、可重复）：分词（CJK 二元组、标识符整体保留、停用词）、标题权重 > 正文重复、覆盖率平方、半衰期、同分时较新靠前、检查点不可召回、旧文件惰性拆分幂等、删除后缓存立刻失效、`source` / `since` / `limit` / `total` 语义、`index/state.json` 落盘。

**真实语料基线 `eval/recall-baseline.mjs`**（对着真实私有日志跑，人肉标注）：

```bash
node eval/recall-baseline.mjs [--dir <memoryDir>] [--agent demo-agent]
```

2026-10-28 实测（`demo-agent` 的 28 条笔记，14 条标注查询，`source:"journal"`）：

| 指标 | 值 |
|---|---|
| top-1 | **92.9%**（13/14） |
| top-3 | **100%** |
| MRR | **0.952** |

唯一失手的是「为什么包名要改」——`j-mvhpevfwfj`（包名被占用）被两条同样提到"改名"的较新笔记（`j-mvqmhvvh9x` 等）挤到第 3。这是词汇检索的典型弱点：字面像但语义不对，正是 §6.5 图扩展要补的那类。

**这就是 `expand:1` 上线前的基线**，M2.5 验收时用同一组查询重跑：`expand:1` 的 top-1 / top-3 / MRR 与 `expand:0` 完全一致（92.9% / 100% / 0.952），rank changes: none，14 条查询共扩出 18 条邻居、单查询最多 2 条。结论要诚实记下来：**在当前这个 28 条笔记的同质语料上，图扩展只是补尾，没有把失手的那条救回来**（那条的正确答案本来就排第 3，扩展是在词汇命中之后追加）。要看到图的收益，需要一类"字面完全不同、实体相同"的查询，而真库里暂时没有这种标注样本。

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
| `entity` | 两条条目共享 ≥1 个实体 | `0.6 × min(1, 0.5 + 共享实体数/4) × 稀有度` |
| `session` | 同一 `sessionId`（journal `meta.sessionId` / 记忆审计行） | 0.5 |

`稀有度` = 该实体在库里的文档频率 `df ≤ 3` 时为 1，之后线性衰减、`df ≥ 7` 归零。**实测教训**：真库 28 条笔记全是同一个插件的记录，"agent-memory"这类词 df 有 6–13，按原始公式每条都能连上别人，扩展项把词汇命中挤掉了；加频率衰减后 14 条评测查询的扩展项从 33 条降到 18 条、单查询最多 2 条，top-1 不变。

不建"同工作区"边：`E:\Projects` 这种粒度会把所有项目连成一个团。

#### 实体提取（白名单形状，宁缺毋滥）

```
[A-Za-z]:\\[^\s"'，。]+                                   Windows 路径
/(?:[A-Za-z0-9_.-]+/){2,}                                 Unix 路径（≥2 段）
agent-[a-z0-9]{4}                                         智能体 id
j-[a-z0-9]{4,16}                                          日志条目 id
[\w-]+\.(js|mjs|md|json|yml|yaml|ts|py|exe|zst|svg)        文件名
[a-z_]+(\.[a-z_]+)+                                        op / 工具名
[a-z0-9]+(-[a-z0-9]+)+                                    包 / 仓库名（连字符是硬条件）
```

过滤：纯数字、单字母、长度 > 64、通用词表（`windows`、`node`、`json`、`true`、`undefined` 等）不入实体——否则整张图会被"json"这类词连成一片。连字符是硬条件的原因同样来自实测：写成"长度 ≥ 6"时 `created`、`settled`、`handoff` 这些普通英文词全被当成实体，它们出现在十条笔记里，正是噪声的主要来源。

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

### 8.3 两个隐患（M2 已处理）

1. ✅ **handoff 压力提示**（order 121）原本把实时 token 数拼进文本，每步都变 → 每步重付整个前缀。已改为**只写阈值**（设置项，会话内稳定），文本逐字节不变；触发/撤销各只翻转一次（`index.js` 的 `handoffHint`）。
2. ✅ **注入文本的确定性**：记忆段只拼 `名称 / id / 绑定来源 / 记忆正文 / 知识库路径`，不含 ISO 时间戳、条目数或相对时间；检查点不进 system prompt（写入日志供检索之外的手动阅读）。

### 8.4 缓存验收

改动后跑 `acp_cache`：

- 命中率 ≥ 95%，中位 ≥ 99%；
- `line items` 里不得出现"comp=0 且 hit<85% 且每请求一行"的模式（那是每轮改前缀的特征）；
- `mid-history divergence` 只应来自 ACP 压缩 fold，不随 turn 数增长。

## 9. UI（M2 ✅）

- 面板新增「回忆」页签：搜索框 + 来源下拉（日志 / 记忆 / 知识库）+ 起始日期 → 结果列表（来源徽标 / 时间 / 得分 / 预览）→ 点击展开全文（`memory.open`，再点收起）。
- 索引状态卡片：条目总数、`builtAt`、各来源条数；「重建索引」按钮 → `memory.reindex`。
- 召回面板纯前端查询，不影响 prompt，也不产生额外 token。
- M3 起：会话来源的命中可以在展开项里「回到对话」（`uiWorkspace.openSession`，M3 ✅）；预览由 `rank.js` 的 `snippet()` 给出**命中词周围的窗口**，不再是正文开头 160 字。
- M4 起：「对话来源」卡片逐会话勾选（`memory.sessions` / `memory.transcript`，落 `settings.json` 的 `transcriptExclude`），取消勾选的会话退出索引但保留打开入口。
- M5 起（`2.0.0-alpha.6`）：`session` 命中带 `hit: {seq, role, at, text}`，指向得分最高的那条消息；索引时保留 `{seq, role, at, text}` 消息列表，超预算按「留头 + 留尾、丢中间」裁剪，消息列表与正文共用同一子集；`memory.message` 按 `sessionId + seq` 取单条全文，面板提供「复制该条」。
- **硬约束**：宿主 `uiWorkspace.openSession(target)` 只接受 `SessionId | SubagentAddress`，没有消息锚点；`ISessions.fork` 是唯一带 `seq` 的入口，且会分叉会话，不能用来定位。所以「自动滚动到第 N 条」做不到，M5 的交付止于「精确到消息 + 复制原文 + 回到会话」。
- 未做：日志条目（`memory/<id>.log.md`）没有稳定的会话反查键，所以日志命中不提供跳转；检查点不进索引。

## 10. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M1** `2.0.0-alpha.1` ✅ | `rank.js`、`agent_recall`（`expand:0` 可用）、`memory.reindex`、checkpoints 迁移、`index/state.json`、`test-recall.mjs`、README 数据布局 | 全量测试通过；**top-1 基线 92.9%**（§6.4）；checkpoint 不可召回；缓存无回归 |
| **M2** `2.0.0-alpha.2` ✅ | 面板「回忆」页签、索引状态卡片、handoff 提示节流、`memory.open` 展开全文 | 面板可用；`acp_cache` 命中率不降 |
| **M2.5** `2.0.0-alpha.3` ✅ | §6.5 关联扩展（`entity` / `ref` / `session`）、`aliases.json`、面板徽标 | `test-recall.mjs` 五类断言全过；真库 14 条查询 expand:0 与 expand:1 的 top-1 都是 92.9%、单查询扩展 ≤ 2 条；扩展不引入缓存失效 |
| **M3** `2.0.0-alpha.4` ✅ | 对话原文入索引：`transcripts.js` + 自带 zstd 帧解析、只读本智能体归属的会话、仅 user/assistant、密钥打码、每会话 12000 字上限、设置开关 | `test-transcripts.mjs` 全过（打码、`thinking` 丢弃、归属隔离、上限、截断提示）；真库 6 个工作区可读；会话未变时缓存命中 |
| **M4** `2.0.0-alpha.5` ✅ | 结果片段围绕命中词（`snippet`）、逐会话勾选（`memory.sessions` / `memory.transcript`）、`/op` 的 404 映射 | `test-recall.mjs` 片段窗口、`test-transcripts.mjs` 排除后列表/检索、`test-host.mjs` 两个新 op 与 404 |
| **M5** `2.0.0-alpha.6` ✅ | 消息级命中（`hit`）、`memory.message`、面板「复制该条」、超预算裁剪与消息列表同源 | `test-recall.mjs` 命中指向正确消息、`test-transcripts.mjs` 消息列表与预算、`test-host.mjs` 两个 404/400 |

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
