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

性能预算：建库 150 条 × 平均 800 字 → int8 CPU 约 6–15 秒（一次性）；单次查询 < 40 ms（含分词）；内存常驻约 50–80 MB RSS。

## 5. 目录与文件格式

```
<root>/
  models/bge-small-zh-v1.5/…        模型（不入 git、不打进 npm 包）
  index/vectors.bin                 float32 小端，按 entries 顺序紧密排列
  index/vectors.json                {version:1, model, dim:512, builtAt, entries:[
                                      {id, src, at, hash, offset} ]}
  index/state.json                  增加 semantic:{model, count, builtAt, lastError}
```

- `hash = sha256(title + "\n" + text).slice(0, 16)`：**按条目内容判脏**。日志文件追加写会让 mtime 整文件变，用 mtime 会每次保存都全量重嵌。
- 向量归一化后存（L2=1），检索时只需点积。
- 删除条目：`entries` 里移除并标记空槽，`vectors.bin` 定期压缩重写（阈值：空洞 > 20%）。

## 6. 流程

### 6.1 下载模型（首次）

```
memory.model {action:"status"}    → {present, model, dim, size, files:[{name,size,ok}]}
memory.model {action:"download"}  → 逐文件下载，镜像 hf-mirror.com → huggingface.co
```

- 逐文件校验 `size`；`onnx/model_quantized.onnx` 额外校验 sha256；不匹配就删除重下。
- 断点续传：存在且 size 正确的文件跳过。
- 面板「下载模型」按钮复用同一个 op，进度按文件回报。
- CLI 预置：`node scripts/fetch-model.mjs`（打包时排除模型本身，`files` 白名单不含 `models/`）。

### 6.2 建库 / 增量

```
memory.reindex  → 全量：清 vectors，逐条嵌入，写 vectors.bin + vectors.json + state.json
首次查询        → 若 vectors.json 不存在或 model 变了：后台建库（查询本身走词法先返回）
日志写入后      → 不主动嵌；下次查询时对 hash 变化的条目补嵌
```

单条嵌入前截断到 512 token（模型上限），并保留 title（标题权重天然高，因为在前）。

### 6.3 检索（hybrid）

1. 词法：现有 `rank.js`，得 `lexScore` 与排序。
2. 语义：查询嵌入一次，对全部条目点积得 `cos`，取 top 30 候选。
3. 归一化：两路各自 min-max 到 `[0,1]`（同一批结果内）。
4. 融合：`score = 0.6*lexNorm + 0.4*cos`，再乘 `decay(at)` 与 `boost(src)`（与现在一致）。
5. 过滤：`cos < 0.30` 的纯语义命中丢弃——日志里常有「都提到这个项目」但主题不同的条目，阈值挡的是这类假阳性。
6. `via` 扩展为 `lexical | alias | ref | entity | session | semantic`，面板按值出徽标；语义独有命中显示「语义」而不是「关联」。
7. 图扩展（`expand`）只作用于词法/别名种子，不拿语义命中当种子——共现边与语义空间是两套结构，混用会把两者的噪声相乘。

参数进 `settings.json`：`recall: {mode:"hybrid"|"lexical", weights:{lexical:0.6, semantic:0.4}, minCosine:0.30}`。默认 `hybrid`；`mode:"lexical"` 保留为回归开关。

### 6.4 失败与降级

| 情况 | 行为 |
|---|---|
| 模型文件缺失 | 本次查询词法；`state.semantic.lastError = "model-missing"` |
| 加载失败（ABI/内存） | 同上 + 面板提示「语义不可用：<原因>」 |
| 单次嵌入 > 1.5 s | 放弃语义，走词法；不重试 |
| 条目文本为空 | 跳过，不占向量槽 |

任何情况下 `agent_recall` 都能正常返回——语义层是增强，不是依赖。

### 6.5 面板

「回忆」页签新增「语义索引」卡片：

- 模型名 / 维度 / 已嵌条数 / 最近建库时间 / 是否降级及原因；
- 「重建语义索引」按钮（进度条）；模型缺失时该按钮变「下载模型（24 MB）」。

## 7. 评测（先于实现）

新增 `eval/recall-paraphrase.mjs`：12 条**改写查询**（答案不变、说法变），例如

| 查询 | 期望命中 |
|---|---|
| 「存档了没」 | 归档 / archive 相关笔记 |
| 「收进 vault」 | 同上 |
| 「那个鲸鱼摆件」 | dsh-whale-widget 相关 |
| 「记忆不敏感怎么办」 | 显著性 / 注入策略笔记 |

跑 `mode:"lexical"` 与 `mode:"hybrid"` 各一遍，报 top-1 / top-3 / MRR / 平均延迟。

通过线（不达标就不合入）：**top-1 至少 +10 个点，或 MRR +0.08，且单查询延迟 < 300 ms**。达不到就说明日志层这 150 条用词法 + 别名已经够，语义层只是负担。

## 8. 里程碑

| 版本 | 内容 | 验收 |
|---|---|---|
| **alpha.8** | 模型加载（onnxruntime-node）+ WordPiece 分词 + 向量索引 + hybrid 打分 + `mode` 参数 + 评测脚本 | `eval/recall-paraphrase.mjs` 达标；`mode:"lexical"` 结果与 alpha.7 完全一致（回归） |
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
| 语义命中把「都提到某项目」的条目拉进来 | 高 | 0.30 余弦下限 + 归一化后 0.4 权重，且语义不作为图扩展种子 |

## 10. 验收清单

- [ ] 模型目录缺失时 `agent_recall` 仍工作，返回词法结果
- [ ] `vectors.json` 的 hash 未变时，重复查询不触发重嵌
- [ ] `mode:"lexical"` 的 top-10 与 alpha.7 逐条一致
- [ ] 语义命中带 `via:"semantic"`，面板显示「语义」徽标
- [ ] 查询延迟 p50 < 120 ms、p95 < 300 ms
- [ ] 全量测试（含新增 `test-embed.mjs`）通过，`npm pack` 不含 `models/`
- [ ] 文档：README 数据布局加 `models/`、`index/vectors.*`；CHANGELOG 写 alpha.8
