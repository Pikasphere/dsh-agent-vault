# 本地 embedding 方案（2.0.0-alpha.8 起）

> 状态：计划稿。模型已下载到位（见 §3.1），代码尚未开始。
> 前置：`docs/memory-recall-v2.md`（词法 + 图召回的整体设计）。本文件只讲「把语义向量加进日志层」这一段。

## 1. 结论

- **只在日志层做语义**：`journal` 笔记 + `memory` 记忆日志，共 150 条、12.4 万字（≈8.3 万 token）。知识库和会话原文继续纯词法。
- **模型本地跑**：BAAI `bge-small-zh-v1.5`（int8 量化，24 MB，512 维），不依赖网络、不上传任何记忆内容。
- **混合打分**：`final = 0.6 × 归一化词法分 + 0.4 × 余弦相似度`，再乘来源 boost 与时间衰减；语义分低于 0.30 的命中直接丢弃。
- **失败即降级**：模型缺失 / 加载失败 / 超时 > 1.5s → 本次查询退回纯词法，原因写进 `index/state.json`，面板可见，`agent_recall` 调用方不感知报错。
- **红线不变**：向量与检索结果只走工具返回值，绝不进 system prompt / 动态 context（否则缓存前缀整段重付）。

## 2. 为什么是「日志层」而不是全量

| 层 | 规模 | 嵌不嵌 | 理由 |
|---|---|---|---|
| 检查点 L0 | 5 条 | 否 | 权威状态，永远整段注入，进索引没有意义 |
| 4K 记忆 L1 | 1 段 | 否 | 同上，恒注入 |
| journal 笔记 | 32 条 / 4.1 万字 | **是** | 自然语言、中文同义改写多，词法错配最严重 |
| 记忆日志 log | 118 条 / 8.3 万字 | **是** | 同上，且追加写、失效成本低 |
| 知识库 | 21 条 | 暂否 | 专有名词密集，词法本来不差；先拿日志层验证收益 |
| 会话原文 | 110 个会话 / 52 MB | 否 | 分块、脱敏、失效三件事都没解，代价远超收益 |

## 3. 模型

### 3.1 已下载

```
C:\Users\Ephelueur\.dsh\agent-memory\models\bge-small-zh-v1.5\
  config.json                 716 B
  tokenizer.json              439 KB
  tokenizer_config.json       367 B
  special_tokens_map.json     125 B
  vocab.txt                   110 KB
  onnx/model_quantized.onnx   24,010,842 B   sha256 15b717c382bc…
```

来源 `Xenova/bge-small-zh-v1.5`（HF 上的 ONNX 转换版，原模型 `BAAI/bge-small-zh-v1.5`），经 `hf-mirror.com` 镜像下载，逐文件比对过 `size` 与 `lfs.sha256`。

### 3.2 为什么选它

| 候选 | 维度 | int8 体积 | 中文效果 | 取舍 |
|---|---|---|---|---|
| **bge-small-zh-v1.5** | 512 | 24 MB | 强（中文检索榜前列） | 选定：体积/效果最平衡 |
| bge-base-zh-v1.5 | 768 | ~100 MB | 更强 | 内存与首次加载翻倍，日志层这点语料用不上 |
| bge-m3 | 1024 | ~560 MB | 最强、多语 | 太重，108 MB → 不适配「随插件跑」 |
| multilingual-e5-small | 384 | ~120 MB | 中 | 多语均衡，中文不如 bge 小模型 |
| text2vec-base-chinese | 768 | ~400 MB | 中上 | 老一代，句子级效果弱于 bge |

int8 量化对短文本检索的损失通常在 1–2 个点 top-1 以内；如果实测掉得明显，同一仓库有 `model_fp16.onnx`（47 MB）可直接替换，配置里改文件名即可。

### 3.3 何时切换 fp16

- 评测里 int8 的 top-1 比 fp32 低 > 3 个点；
- 或者出现「同一句话两次嵌入余弦 < 0.98」这种量化伪影。

## 4. 运行时

宿主插件跑在 Electron 主进程里，选型按「先短路径、可回退」排：

1. **`onnxruntime-node`**（N-API，跨 Electron ABI 稳定）+ 自写 WordPiece 分词（`vocab.txt` 驱动，BGE 用 BERT 分词，含中文单字切分）。
2. 若 Electron 里加载 native 失败 → **`onnxruntime-web`（wasm）**，同一份 `model_quantized.onnx`，纯 JS 加载，慢 2–4 倍但语料小、可接受。
3. 若 wasm 也不稳 → **子进程**：`node scripts/embed-server.mjs` 用系统 Node 跑，插件通过 stdin/stdout 通信；最后手段，因为多一个进程要管。

不选 `@huggingface/transformers` 全家桶：它会隐式联网下载模型、依赖面大、Electron 兼容性不确定；我们只需要「一个 tokenizer + 一次 session.run」，自己写约 150 行，可控且可测。

**实测**（本机 Ryzen + Node 24 / Electron 44）：session 创建 150 ms（一次性，启动时 `setTimeout` 预热）；3 条文档嵌入 8 ms；单查询 20 ms（12 条改写查询均值，含分词 + 嵌入 + 全量点积；模型加载另计 150 ms，启动时预热）；常驻内存未单独测，24 MB 权重 + ORT arena，估 50–80 MB RSS。

`embed.js` 用 `createRequire` 惰性 `require('onnxruntime-node')`：依赖缺失只让 `embedder` 变 `null`（检索退回词法），不会让插件加载失败。

## 5. 目录与文件格式

```
<root>/
  models/bge-small-zh-v1.5/…        模型（不入 git、不打进 npm 包）
  index/vectors.bin                 float32 小端，按 entries 顺序紧密排列
  index/vectors.json                {version:1, model, dim:512, builtAt, entries:[
                                      {key:"journal:<id>", src, at, hash} ]}
  index/state.json                  增加 semantic:{model, count, builtAt, lastError}
```

- `hash = sha256(title + "\n" + text).slice(0, 16)`：**按条目内容判脏**。日志文件追加写会让 mtime 整文件变，用 mtime 会每次保存都全量重嵌。

向量库是**全库一份**（所有智能体的日志层一起嵌，key 形如 `journal:j-xxxx` / `log:<agentId>:m-3`）：只嵌调用方的智能体会让两个智能体互相把对方的行挤掉，交替查询时每次都要重嵌上百条。日志条目的 id 在一个文件内是位置序号（`m-3`），所以 key 必须带智能体前缀，否则跨智能体撞键。
- 向量归一化后存（L2=1），检索时只需点积。
- 删除条目：`bin` 整文件重写并收缩（`sync()` 里做），不保留空槽——150 条的量级重写只要几毫秒，空洞+定期压缩不值得。

## 6. 流程

### 6.1 下载模型（首次）

```
node scripts/fetch-model.mjs [--dir <modelsDir>] [--force]
memory.model {action:"status"}    → state().semantic（模型名 / 维度 / 已嵌条数 / 降级原因）
memory.model {action:"prepare"}   → 预加载模型 + 增量建库
```

- CLI 逐文件下载，镜像 hf-mirror.com → huggingface.co；**逐文件校验 size，全部文件校验 sha256**（6 个文件的 size/sha256 写死在脚本里，本次下载即按此校验）。
- 续传：文件已存在且 size+sha256 正确就跳过，所以中断后重跑即可；`--force` 覆盖。
- 模型不打进 npm 包（`files` 白名单不含 `models/`）。
- 面板「下载模型 / 重建」按钮留到 alpha.9，复用同一份文件清单。

### 6.2 建库 / 增量

```
memory.reindex  → 全量：清 vectors，逐条嵌入，写 vectors.bin + vectors.json + state.json
首次查询        → 若 vectors.json 不存在或 model 变了：后台建库（查询本身走词法先返回）
日志写入后      → 不主动嵌；下次查询时对 hash 变化的条目补嵌
```

单条嵌入前截断到 512 token（模型上限），并保留 title（标题权重天然高，因为在前）。

### 6.3 检索（hybrid）

1. 词法：现有 `rank.js`，得带分排序（别名命中已并入这一步）。
2. 语义：查询嵌入一次（**加 BGE 查询指令前缀**，文档不加），对全部条目点积得 `cos`。
3. 过滤：`cos < minCosine` 的条目没有语义名次（默认 0.45）。
4. 融合：**倒数排名融合（RRF）**，`score = 0.6/(20+lexRank) + 0.4/(20+semRank)`，缺哪一路就少加哪一项。
5. `via` 扩展为 `lexical | alias | ref | entity | session | semantic`，面板按值出徽标；语义独有命中显示「语义」而不是「关联」。
6. 图扩展（`expand`）只作用于词法/别名种子，不拿语义命中当种子——共现边与语义空间是两套结构，混用会把两者的噪声相乘。

**为什么不是加权和**：先按 `0.6*norm(lex) + 0.4*cos` 实现过，实测 top-1 只有 33.3%（vs 纯词法 25%）。原因是量纲：词法最大项恒被归一化成 1.0→占 0.6，而余弦常在 0.5–0.65→只占 0.2–0.26，只要某条有词法命中，正确但只靠语义的条目永远翻不上来。改成 RRF 后同一评测集 top-1 41.7%、MRR 0.528。RRF 只比名次，不存在这个量纲陷阱，且对分数的绝对值不敏感（词法分数是 `rank.js` 的经验加权，本来就不该被当成概率）。

参数进 `settings.json`：`recall: {mode:"hybrid"|"lexical", lexicalWeight:0.6, semanticWeight:0.4, minCosine:0.45}`。默认 `hybrid`；`mode:"lexical"` 保留为回归开关。`weights` 与 `minCosine` 也可按次覆盖（评测脚本用，见 `recall.search` 的 `input.weights`）。

### 6.4 失败与降级

| 情况 | 行为 |
|---|---|
| 模型文件缺失 | 本次查询词法；`state.semantic.lastError = "model-missing"` |
| 加载失败（ABI/内存） | 同上 + 面板提示「语义不可用：<原因>」 |
| 单次嵌入 > 1.5 s | 放弃语义，走词法；不重试 |
| 条目文本为空 | 跳过，不占向量槽 |

任何情况下 `agent_recall` 都能正常返回——语义层是增强，不是依赖。

### 6.5 面板

「回忆」页签新增「语义索引」卡片（alpha.9）：

- 模型名 / 维度 / 已嵌条数 / 最近建库时间 / 是否降级及原因（数据已由 `memory.model {action:"status"}` 提供，alpha.8 只是还没有这张卡片）；
- 「重建语义索引」按钮（进度条）；模型缺失时该按钮变「下载模型（24 MB）」。

搜索框旁出现 `mode` 切换（hybrid / lexical），用来看「这句话语义找到了什么」，也方便把一次可疑的召回退回纯词法复现。

## 7. 评测（先于实现）

`eval/recall-paraphrase.mjs`：12 条**改写查询**（答案不变、说法变，且与目标笔记没有字面重叠），跑 `mode:"lexical"` 与 `mode:"hybrid"` 各一遍，报 top-1 / top-3 / MRR / 平均延迟 / 排名变化 / 语义独有命中。

| 查询 | 期望命中（作者自己的 journal） | 纯词法排名 | hybrid 排名 |
|---|---|---|---|
| 会话怎么被收起来 | 1.2.0-beta.3 自动弱归档 | 10 | 15 |
| 两个会话之间怎么接上 | 接力 v1 落地 | 19 | 6 |
| 装大模型踩了什么坑 | 9B 下载 + Ollama 接入 | 6 | 5 |
| 改完名字就打不开 | 改名导致启动崩溃 | 8 | **2** |
| 上下文怎么这么短 | bili 报 6144 窗口 | miss | 6 |
| 这个对话算谁的 | 1.2.0-beta.1 对话归到智能体 | 3 | 20 |

2026-10-29 实测（真库 `demo-agent`，28 条 journal，**全库 150 条向量**；测量前已预热，含模型加载的冷启动约 200 ms）：

| 模式 | top-1 | top-3 | MRR | 延迟 |
|---|---|---|---|---|
| lexical | 25.0% | 58.3% | 0.403 | 1 ms |
| hybrid (RRF) | **41.7%** | **66.7%** | **0.528** | 20 ms |

通过线（不达标就不合入）：**top-1 至少 +10 个点，或 MRR +0.08，且单查询延迟 < 300 ms**。RRF 版两项都过（+16.7 pt / +0.125）；加权和版只有 +8.3 pt / +0.062，当时正是靠这条线判定「不能合入」才去查融合方式。

同时 `eval/recall-baseline.mjs`（14 条词面可对的查询，强制 `mode:"lexical"`）保持 top-1 92.9% / top-3 100% / MRR 0.952——语义层不许动词法基线。

## 8. 里程碑

| 版本 | 内容 | 验收 |
|---|---|---|
| **alpha.8** ✅ | 模型加载（onnxruntime-node）+ WordPiece 分词 + 向量索引 + RRF 混合 + `mode` 参数 + 评测脚本 | 改写集 +16.7 pt top-1 / +0.125 MRR、55 ms；词法基线不动（2026-10-29 达成） |
| **alpha.9** | 面板「语义索引」卡片 + 下载/重建按钮 + 增量与压缩 + 降级原因展示 | 模型目录临时改名后，检索仍返回词法结果且面板显示原因 |
| **beta 前** | 决定知识库是否也嵌 | 用同一评测集测「日志 + 知识」是否再涨 |

## 9. 风险

| 风险 | 概率 | 应对 |
|---|---|---|
| `onnxruntime-node` 在 Electron 里加载失败 | 中 | 切 `onnxruntime-web` wasm（§4.2），性能预算重新测 |
| int8 精度不够 | 低 | 换 `model_fp16.onnx`（47 MB），改一个配置项 |
| 首次加载 1–2 s 拖慢首查 | 高 | 懒加载 + 后台预热（插件 `apply` 后 `setTimeout` 预加载，不阻塞启动） |
| 中文长笔记被 512 token 截断丢信息 | 中 | 只嵌 title + 前 512 token；检索命中后仍可 `memory.open` 看全文 |
| 磁盘 24 MB / 内存 80 MB | 低 | 可接受；面板可见、可删 |
| 语义命中把「都提到某项目」的条目拉进来 | 高 | 余弦下限 0.45（调到 0.40 时 MRR +0.016 但尾部噪声变多，保持保守）+ 语义不作为图扩展种子 |

## 10. 验收清单

- [x] 模型目录缺失时 `agent_recall` 仍工作，返回词法结果
- [x] `vectors.json` 的 hash 未变时，重复查询不触发重嵌
- [x] `mode:"lexical"` 的 top-10 与 alpha.7 逐条一致
- [x] 语义命中带 `via:"semantic"`，面板显示「语义」徽标
- [x] 查询延迟 55 ms（12 条改写查询均值，含嵌入）
- [x] 全量测试（含新增 `test-embed.mjs`）通过，`npm pack` 不含 `models/`（`files` 白名单里本来就没有）
- [ ] 文档：README 数据布局加 `models/`、`index/vectors.*`；CHANGELOG 写 alpha.8
