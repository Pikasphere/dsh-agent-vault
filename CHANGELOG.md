# Changelog

## 2.1.0-beta.8 — 2026-11-04

检索时的嵌入成本：从「每轮约 300 ms」压到「后台付账」。

- 会话块 6000 → **1200 字符**。向量层还会把每块再切成 ~420 字符的行，而「开放的尾块」每轮都会被追加改写——6000 字符一块意味着每轮重嵌约 18 行（≈300 ms）。现在尾块约 5 行（≈80 ms）。
- `recall.touch()`：日志/记忆写入后延迟 1.2 秒在后台 `vectors.sync()`，写路径不等嵌入。下次搜索通常已是热的；`touch` 的定时器 `unref()`，不阻止进程退出。
- 实测（真实语料，1.48M 字符）：5,000 字符级固定开销只有 4 ms（hash 1 + 切块 3），全量重建约 62 秒（仅 reindex），打分约 3 ms。

## 2.1.0-beta.7 — 2026-11-04

折叠的两道安全闸，都是从 `tool result has no matching call` 那次事故反推出来的。

- **整片配对检查**（`pairingProblem`）：原先只校验区间两端不切工具对，但真正会坏的是「区间内部有一条断言、其调用在区间外」——16558–16579 那次就是漏掉了 16580 那条带调用的 assistant 消息，会话能加载，下一次请求才被 provider 拒。现在按成员关系比较：call 和 result 要么都留、要么都折，只删一个就判死。
- **宁可缩也不拒绝**：发现不平衡时从尾部逐条丢弃，直到整片平衡；缩到少于 2 条才放弃。
- **重复折叠检测**（`#am-<stamp>` 桩戳）：桩里带 sha256(会话:区间) 的前 12 位，重试前先翻持久日志——同一片已经折过就跳过（stage=`duplicate`），不再二次归档、也不会替换已不存在的节点。

## 2.1.0-beta.6 — 2026-11-04

折叠记账同时记两套数字：`shadowedTokenCount` 是这次归档掉的内容量（内容侧），`tokensBefore` / `tokensAfter` / `savedTokens` 是重建表面后 token 计量器给出的实际值。两者不一致，调阈值看 meter，判断归档效果看 shadow。

## 2.1.0-beta.5 — 2026-11-04

深折每轮只做一次。beta.4 实测：一次空闲在 9 毫秒内连做三次深折，区间彼此重叠（`17237–18068`、`16411–18106`、`16091–18107`）——第二次会把第一次刚写的指针节点又归档一遍。原因是分片循环用的是外层 `config.maxSlices`(3)，忽略了 `sliceConfig.maxSlices`(1)。现在硬阈值以上把循环上限压到 1。

## 2.1.0-beta.4 — 2026-11-04

补上「大压缩」：硬阈值以上做一次**跨水印的深折**，而不是继续在尾巴上切 30k。

- 之前的逻辑是越线后用 `bigChunkTokens`(200k)，但仍受水印约束——水印之后的材料往往只剩十几个节点，于是每次只能切出 20–30k，上下文在 470k 上反复横跳。
- 现在硬阈值以上把 `deep: true` 传给 `shelve`，区间选择忽略水印，切片大小取 `min(当前token - 软阈值, bigChunkTokens)`：一次折回软阈值以下。只有这一次会牺牲前缀缓存，符合「rare but deep」的定位。
- 每次折叠的记账里带 `deep` 标记，便于区分小折与大折。

## 2.1.0-beta.3 — 2026-11-04

**超阈值时一次折一大片**（`bigChunkTokens`，默认 200k）：上下文一旦越过 `triggerTokens`，小折叠（每次约 3 万）已经追不上增长，而且这一层本来就要重写前缀、缓存必失——干脆一次折掉 20 万 token。

- 选择逻辑：`tokens >= triggerTokens` → 单片大折叠（`maxSlices` 强制为 1）；否则仍按 `chunkTokens` 小片补齐。
- 这是不依赖宿主 `compaction` 服务的「大压缩」：走的是同一条记忆化路径（先写 journal，再替换成指针桩）。

## 2.1.0-beta.2 — 2026-11-04

三处修正，都来自实际运行数据。

- **一次空闲多片抽干**（`maxSlices`，默认 3）：原先每个 idle 只折一片（约 3 万 token），而会话每轮增长更快，结果 token 一路涨到 47 万仍压不下去（最近 400 条记录里：15 次成功折叠、287 次 `cooldown` 跳过）。
- **冷却只在真实折叠后计入**：以前「没有合适区间」也会重置 60 秒冷却，导致后续有机会时全被冷却挡住。
- **host 模式拿不到 compaction 服务时回退到记忆化折叠**（`fallbackShelve`，默认开）：服务活在预设 isolate 里，profile 级插件看不到；什么都不做是最差结果。

同步：profile 实际加载的是 `/home/pikasphere/dsh-plugins/dsh-agent-vault`（与 `~/Projects/...` 是两份拷贝），这版已同步过去。

## 2.1.0-beta.1 — 2026-11-04

进入 beta。这版补上面板里一直空着的一半：语义模型缺失时可以直接在界面上补。

- `scripts/fetch-model.mjs` 拆出可复用 `fetchModel({dir, force, onProgress})`，CLI 行为不变；下载仍逐文件校验 size + sha256、镜像回退、`.part` + rename。
- `memory.model {action:"download"}`：后台单例下载，**立即返回**（早先的实现会把整个下载 await 在请求里，面板因此长时间处于 busy，看起来像白屏）；完成后自动 `recall.reloadModel()` + `prepare()`，不重启即可用语义检索。
- 语义卡在不可用时区分两种原因：模型文件缺失显示「下载模型」按钮；**缺少本地推理运行时**（`onnxruntime-node`，来自 npm 依赖）显示专门提示，不再把两者混为一谈。
- 修复点击下载导致页面空白：`memory.model` 的返回值是任务对象而不是 store 快照，客户端改为走不触碰面板状态的原始请求。

## 2.1.0-alpha.26 — 2026-11-02

修第二次折叠被拒的根因：**表面顺序不等于 seq 顺序**。

第一次替换之后，surface 里出现了一个 seq 很大的桩节点，可见 seq 从此非单调。契约原话是「start/end 按表面位置取，不是数值 seq 顺序」。第一版用 `seq >= start && seq <= end` 过滤节点，于是漏掉了宿主认为「在区间内」的节点，被拒：

```
surface replace: sourceEventSeqs must include every shadowed surface node;
missing 16582, 16584, 16588, 16590
```

现在区间一律按**索引切片**：`nodes.slice(startIndex, endIndex + 1)`，`sourceEventSeqs` 就是这片节点本身（表面序）。水印比较也改成按索引定位。

## 2.1.0-alpha.24 — 2026-11-02

水电后第一个真实问题：**折叠水印把自己的路堵死了**。

`selectSpan` 过去只要区间起点 ≤ 水印就整段放弃。于是折叠一次之后，尾部那段新内容无论多长都折不动——预算 60k 会一路回退到水印之前，永远被拒。现在改成**夹紧**：起点越过水印，只折水印之后的新材料；区间不足 `minFoldTokens` 再放弃。

顺带把 `boot.jsonl` 的版本号改成从 `package.json` 动态读取（此前是手写字符串，alpha.22/23 忘了同步，导致「运行的是不是最新代码」这个判断连续两次被误导）。

## 2.1.0-alpha.23 — 2026-11-02

会话修好后继续对话，第一轮就失败：`DeepSeek Messages tool result has no matching call`。

- **根因在折叠本身**：`selectSpan` 判断「不切断工具调用」时查的是 `nodeType(...) === 'tool/call'`，可 `tool/call` 根本不是表面节点（它只是日志事件），工具调用实际藏在 `assistant/message` 的 `tool-call` block 里。于是尾端落在 `16582`——一条带调用的 assistant 消息上：桩把调用折走，结果 `16584` 却留在表面，模型请求里就出现「没有对应调用的 tool result」，provider 直接拒绝整轮。
- 这类损坏**加载时不报错**（格式完全合法），只在下一轮真正发请求时才炸，所以和 alpha.22 的「打开即崩」是两个不同层次的坑。
- **修法**：`selectSpan` 尾端规则改为「不得落在 `tool/result`，也不得落在仍带 `tool-call` 的 `assistant/message` 上」——不满足就向后回退；新增 `toolCallIds()` 辅助函数和回归测试（构造一条尾端带调用的表面，断言折叠点落在它之前）。
- 受损会话 `196a4c81` 已就地重平衡：fold 区间从 `16558–16582` 收到 `16558–16579`（7 个节点），把 `16582/16584` 这对调用/结果留在表面；catalog 校验与工具配对审计均通过。

## 2.1.0-alpha.22 — 2026-11-02

shelve 的指针桩把会话写坏了：打开时 `stored session ... is corrupt: format v4 message requires a producer-owned source kind`。

- **根因**：桩用 `session.append('user/message', { role, content })` 落盘，缺了 v4 当场要求的两个字段——`id`（已识别消息）和 `source.kind`（生产者归属，且不能是 `plugin`）。写入端只做物理行准入，不校验消息身份，所以写的时候一切正常，**直到下次打开会话才整体崩掉**（接着还会报 `lacks an identified message`）。
- **修法**：桩改为 `{ id: randomUUID(), role: 'user', source: { kind: 'user' }, content }`。`kind: 'user'` 与宿主自己 `createUserMessage` 的产物一致，任何读取端都认得。
- 已原位修复被它写坏的 3 个会话（`196a4c81`、`b6a436d8`、`cf046ef3`）：补 `id` + `source`，zstd 按原帧边界重打包（未受影响的帧字节不变），并用宿主自己的 format catalog（`validation: 'current'` + installed Session）验证通过；原件备份在 `E:\Projects\.tmp-session-repair\backup\`。
- `test-sleep.mjs` 增加桩消息 id/source 的断言。

## 2.1.0-alpha.21 — 2026-11-02

记忆化压缩只差最后一步：宿主拒绝了表面替换，并给出了确切契约——

```
surface replace: sourceEventSeqs must include every shadowed surface node;
missing 16537, 16544, 16546, 16548, 16552
```

即：替换一个区间时，`sourceEventSeqs` 必须逐条列出被遮蔽的每一个表面节点。补上即可（顺带确认了整条链路是通的：选中区间 → 写 journal（`j-mvzeji3lku` 已落盘）→ 走到 append 才被拦下）。

## 2.1.0-alpha.20 — 2026-11-02

**记忆化压缩（shelve）**：同会话、不换窗口，但压缩走记忆层——这正是 bili 做不到的那件事。

- 触发后先**把区间原文写进该智能体的 journal**（每 15000 字一条 `j-xxxx`，带 `meta.sessionId/span`）；
- 写盘成功后，才把这段表面替换成一条**指针桩**（几百字）：`【已归档】第 a–b 段已存入记忆：j-1、j-2。要细节请用 agent_recall，不要凭印象补写。`
- 关键点：桩是**我们自己已生成好的文本**，不需要任何摘要模型。所以不存在「压不住」——不会因为 payload 太大而失败（正是 1.9M 那次 session 的死因），也不会因为模型瞎写而失真。
- 顺序保证：先归档、后改写。中途失败则 session 原样不动。
- 用 `sleep.mode` 开关：`host`（走 compaction 服务，默认）| `shelve`（记忆化压缩）。未绑定智能体时拒绝执行（没有记忆可写）。

## 2.1.0-alpha.19 — 2026-11-02

修完计量后暴露的下一层：`skip: no-compaction-service`——`compaction` 服务活在**agent 预设的 isolate 作用域**里，profile 级插件用 `ctx.get('compaction')` 看不见。

现在按顺序尝试四路解析：

1. `agent.ctx.get('compaction')`（scoped 事件给到的 agent 自带上下文）；
2. `agentPresets.serviceFor(agent, 'compaction')`；
3. `ctx.get('compaction')`；
4. `ctx.root.get('compaction')`。

成功时会记一条 `{"kind":"acquired","source":"agent.ctx"|"agentPresets"|"root"}`；全部失败则记 `skip.no-compaction-service` 并带上试过的路径。

## 2.1.0-alpha.18 — 2026-11-02

**真正的根因**：`sleep.js` 把注入的 `measureTokens` 当成两参数函数调用，而 `index.js` 传进来的是单参数闭包。

```js
createSleep({ measureTokens: sessionId => measureTokens(ctx, sessionId) })  // 注入侧：一个参数
const tokens = measureTokens(ctx, sessionId)                                // 调用侧：两个参数 → 第一个参数是 ctx 对象
```

于是 `sessions.get(ctx对象)` 恒为 undefined，计量恒为 0，`below-threshold` 静默跳过——这解释了此前所有“探针有了、数字是 0”的现象。

修法：四处调用改成单参数。同时保留 `measure-recovered` 兜底（meter/字符估算），作为以后任何计量失败的保险。

## 2.1.0-alpha.14 — 2026-11-02

兜底之后 tokens 仍是 0，说明 `deriveMessages()` 这条路也拿不到内容。这版补两件事：

- `measureTokens` 的第二层兜底：当 `deriveMessages()` 为空或抛错时，改按 `session.surface.nodes` + `eventAt(seq)` 序列化事件体积估算（这份数据在账本里已经被证明可读）。
- tick 的 `measured` 行加上 `hasSession` / `nodes` / `derived` 三个字段，一次看清「会话对象拿没拿到、surface 有几个节点、deriveMessages 返回几条」。

## 2.1.0-alpha.13 — 2026-11-02

**找到休眠机制一直不动作的真正原因**：`measureTokens` 恒为 0。

诊断输出：`{"step":"measured","sessionId":"session-196a4c81…","tokens":0}` —— 会话在列表里、服务都拿得到，唯独 token 数是 0。原有实现对 `ctx.get('tokenMeter')` 缺失、`measure()` 抛错、返回 0 三种情况一律 `return 0`，而 0 永远低于阈值，于是每一轮都安静地什么都不做。

修法：`measureTokens` 加本地兜底——meter 不可用或答 0 时，按 `session.deriveMessages()` 的序列化字符数估算（≈ 3 字符/token），与账本里手工估算的口径一致。

**副作用提示**：交接（handoff）用的是同一个 `measureTokens`，所以自动交接其实也一直是“token 永远 0、永不触发”。这次一起修好了。

## 2.1.0-alpha.12 — 2026-11-02

sweep 每一步都无条件记账（`step: enter/got/listed/disabled/measured/session-threw/...`）。上一版的 tick 探针仍走 `probe()`，而 `probe()` 被 `sleep.debug` 门控——如果 `store.settings()` 在定时器上下文里抛异常，`debug` 会被静默当成 false，于是「跑了但什么都没写」和「没跑」长得一模一样。

## 2.1.0-alpha.11 — 2026-11-02

诊断加固：`attached` 之后仍然没有 tick，而 tick 的唯一探针被 `sleep.debug` 门控——分不清「没跑」和「跑了不说话」。

- `sweep()` 开头无条件写 `{kind:"tick-enter"}`，不受任何设置影响；
- 另起一个 6 秒定时器写 `{kind:"timer-fired"}`，单独验证「这个上下文里定时器到底会不会触发」。

## 2.1.0-alpha.10 — 2026-11-02

修轮询没跑起来的两处：

- `sweep()` 里 `ctx.get('sessions')` 在服务不可见时会**抛异常**（不是返回 undefined），而它当时在 try 之外——异步回调的 rejection 被吞掉，表现成「定时器没触发」。现在整段包在 try/catch 里，失败也写一条 `{seen:"tick", skipped:"sessions-error"}`。
- `boot.jsonl` 的版本号是写死的字符串，改版本时忘了同步；现在跟着发布号走，避免再用它判断「加载的是不是最新代码」时被误导。

## 2.1.0-alpha.9 — 2026-11-02

睡眠机制改用**轮询**作为主触发：`ctx.get('sessions').list()` 拿到所有活跃会话，启动 5 秒后扫一次、之后每 60 秒一次。

为什么放弃事件：`agent/status`、`session/event`、`agent/pre-step` 三个钩子在真实 profile 里都没有到达根作用域的插件（boot 标记证明代码已加载、记忆根正确、无异常），继续猜作用域只会多耗几轮重启。轮询不依赖事件派发，一定跑得到。

- 每 tick 记一条 `{seen: "tick", sessions: N}`，首个 tick 在启动后 5 秒；
- 每条会话照旧走 `maybeCompact`（阈值、冷却、水印、区间选择都在）；
- 事件钩子保留但降级为可选路径，`attached` 一行记录注册了几个。

## 2.1.0-alpha.8 — 2026-11-02

睡眠机制加「活性探针」与第三个触发口。前两版挂的 `agent/status`、`session/event` 在真实 profile 里一条 probe 都没到，说明根作用域收不到这两个事件；而 `agent/pre-step` 是确定能收到的（handoff 的归档闸门就跑在上面）。

- 新增 `agent/pre-step` 监听：每分钟最多写一条 `{seen: "pre-step", tokens}` probe，并在 2 秒后调一次检查（那时通常已 idle；若还在跑，`compactRegion` 会自己拒绝，只会计账）。
- 新增启动标记 `index/boot.jsonl`：`apply()` 入口写一行 `{at, version, root}`，用来一次区分「代码没加载到」「记忆根不一致」「钩子没收到事件」三种情况。

## 2.1.0-alpha.7 — 2026-11-02

睡眠机制加第二个触发口：`session/event` 的 `turn/end`。

`agent/status` 是 scope-filtered 事件，根作用域的监听在部分组合里收不到——实测开关打开、阈值已过，却一条 probe 都没有，说明钩子压根没被调用。所以同时监听 post-commit 的 `session/event`：提交了 `turn/end` 之后 800ms 再调一次检查（那时 agent 已脱离运行态）。两条路都便宜且幂等，`inFlight` + 冷却吸收重复。

probe 现在会写 `seen: "status-idle"` / `seen: "turn-end"`，下一个版本就能看出到底是哪条路在生效。

## 2.1.0-alpha.6 — 2026-11-02

给小折叠加诊断：`sleep.debug` 打开后，每次空闲都往 `index/compaction.jsonl` 记一条 `kind: "probe"`，写明决策停在哪一步（`below-threshold` / `cooldown` / `no-compaction-service` / `compactIfNeeded-missing` / `compactRegion-missing` / `no-session` / `no-span`），并带上量到的 token 数、surface 节点数、当前水印。

理由：开启 toggle 后没有任何记账，仅凭外部观察分不清是「上下文没到阈值」「拿不到 compaction 服务」还是「区间选不出来」——这三个原因需要完全不同的修法。

## 2.1.0-alpha.5 — 2026-11-02

按 billion-context 的结论补两处：折叠水印与最小折叠量。

- **折叠水印**（借鉴 bili 的 `pendingOrphanSweepMinRef`）：每次小折叠后把起点写进 `index/sleep.json`（`{foldStartSeq: {sessionId: seq}}`），下次选区间时起点不得 ≤ 水印——否则会重写上一轮仍在缓存里的前缀，等于白扔一次缓存。水印推进意味着折叠点一直往后走，前缀持续存活。
- **最小折叠量** `minFoldTokens`（默认 5000）：区间字符数不到 `3 × 阈值` 就攒着等下一次 idle。一次折叠有固定成本（一次摘要调用 + 前缀重付），太碎是亏的。
- 记账里带上 `span {start, end, nodes}`；`state()` 暴露 `foldStartSeq`，面板能看出折叠点是否一直在推进。
- 测试：新增「低于最小折叠量不动作」「水印挡住重复折叠同一段」两个用例。

## 2.1.0-alpha.4 — 2026-11-02

小压缩（尾部折叠）：在撞上硬阈值之前，先把最近已消费的一段折成摘要，推迟那次会打穿 KV 缓存的大压缩。

- 机制：`compaction.compactRegion(startSeq, endSeq, agent)`。为什么是「尾部」——替换位置 P 之后的前缀全部失效，折最老的一段等于把整段历史重付；折尾部已消费的内容只重付尾巴。bili 的「缓存友好」本质就是这一点。
- 选择区间：从尾部倒数 `keepRecent`（默认 8）条之前开始，向前累到 `chunkTokens`（默认 20k）；端点按工具配对修正——不以 `tool/result` 起、不以 `tool/call` 止，否则 `compactRegion` 会以不平衡拒绝。
- 阈值：`softTokens`（默认 300k）触发小折叠；超过 `triggerTokens`（默认 400k）才走宿主平衡缩减。冷却仍是 10 分钟。
- 记账多一个 `kind: 'small' | 'big'` 与 `span {start, end, nodes}`，失败也记，方便统计小折叠的实际收益。
- 设置页新增「开始小压缩」「每次折叠目标」两个输入。
- 测试：`test-sleep.mjs` 补小折叠路径（区间有序、避开工作集、端点不切工具对）、低于软阈值不动作、区间被拒时记账不抛。

## 2.1.0-alpha.3 — 2026-11-02

会话索引从「一条会话一条」改成分块：**日志里有的，现在都搜得到。**

- 原先每个会话只索引头 2000 + 尾 10000 字符（`MAX_CHARS=12000`），本会话 203,537 字里只有 10,276 字进了索引——**5.05%**，中间的记忆实际上是查不到的。
- 现在按约 6000 字一块切片，块 id 是 `session:<id>#<起始 seq>`，标题仍是会话名，另带 `round`（第几轮）与 `span`（seq 区间）。
- 效果（真实语料，9 个归属会话）：索引条目 108 条、749,241 字，本会话 27 块、205,961 字，**覆盖率从 5.05% 到 100%**；全量重建 2.7 秒。
- `messagesOf()` 改为返回整份消息列表，块命中能指向其中任意一条；`get()` 仍返回整会话的裁剪视图（面板详情用）。

## 2.1.0-alpha.2 — 2026-11-02

「提前压缩」：不再等宿主把上下文压到窗口边缘才动手，而是在**回合结束、会话空闲**的那一刻，按我们自己的阈值请宿主压一次。

- 新模块 `sleep.js`：监听 `agent/status`（`idle` 时），读 `tokenMeter` 的当前总量，超过 `sleep.triggerTokens`（默认 **400k**）且过了冷却窗口（默认 10 分钟）就调公开的 `compaction.compactIfNeeded({session, options}, 'context-overflow', signal)`。**不接管实现**，不碰请求，不改写历史——只是把「该压了」说得更早。
- 用 `context-overflow` 这个触发值，是因为它的契约写明「可以低于实现自己的阈值强制做一次平衡缩减」，这正是阈值前移需要的语义。
- 记账：每次尝试追加一行到 `<memoryDir>/index/compaction.jsonl`（时间、会话、智能体、原因、压缩前 token、是否成功、折叠 token、摘要字符、耗时、错误）。设置页的「提前压缩（睡眠）」卡片会显示「已尝试 / 累计折叠」。
- 设置：`sleep.enabled`（**默认关**）、`sleep.triggerTokens`、`sleep.cooldownMs`，都走 `settings.save`，面板开关即时生效（阈值在同一张卡片里改）。
- 防重：同一会话有在飞任务时跳过；超时 120s 自动 abort。
- 测试：新增 `test-sleep.mjs`（关闭不触发、低于阈值不触发、正常触发并记账、冷却生效、服务返回 null 仍记账、失败被吞并记账、会话/服务缺失不抛、`state()` 聚合）。

## 2.1.0-alpha.1 — 2026-11-02

账本视图从「事件列表」升级成「汇总卡」：现在能回答「这个会话压过几次、成了几次、省了多少」。

- `session.context` 的返回新增 `runs` 与 `stats`：`compaction/start`、`compaction/end`、`compaction/summary` 按 `compactionId` 配对成一次压缩尝试，带轮次、耗时、成功/失败、失败原因（`refused-by-proxy` 单独归类）、摘要字符数。
- `stats`：压缩尝试数、成功、失败、被代理拒绝、工具结果剪枝次数与累计折叠 token、摘要总字符、峰值请求 token（从溢出错误里解析）。
- 视图顶部是八格汇总卡，下面是事件构成直方图，再接压缩尝试列表。
- 单测：`test-transcripts.mjs` 新增账本用例（三次尝试两败一成、拒绝归类、prune 累计、峰值 token 解析、缺失会话返回不可用）。

### 真实数据（本会话，2.0.x 时期）

- 4 次压缩尝试：2 次撞窗口失败（1.86M / 1.91M tokens，窗口 1,048,576）、1 次被 bili 拒绝、1 次成功。
- 成功那次：摘要 32,225 字符 ≈ 21.5k tokens，替换掉 190 万 token 的历史。
- 工具结果剪枝：29 次，累计 135,754 tokens，单次最大 12,491。

## 2.1.0-alpha — 2026-11-01

为「压缩记账」铺第一块砖：**只做前端视图，不接管任何逻辑**。

- 正文新增第二个独立视图「账本 / Ledger」（`conversation.view`，`id: "vault-ledger"`，`order: 6`，排在「检索」右侧）。
- 数据来自新的只读 op `session.context {sessionId}`：`transcripts.js` 新增 `ledger()`，把本会话的事件按类型做直方图，并单列出 `compact` / `summar*` 类事件（seq、时间、类型、前 400 字）。
- 明确边界：**没有拦截、没有改写、没有停用宿主原生压缩**。这一版只是让「记账要读哪些数据」先看得见，等真实数据摆出来再设计接管。
- 仍受既有约束：只允许读「绑定在当前会话名下」的智能体拥有的会话。

## 2.0.6 — 2026-11-01

正文多了一个「检索」视图：一个会话跑上几千步之后，右侧那排短横只能按轮次跳，找不回具体说过什么。

- **为什么是视图而不是改那条轨**：右边缘的轮次轨由壳直接绘制，槽位树里没有对应节点（`conversation.view` / `sidebar.right.pane.tab` 之外没有扩展点），插件改不了它；客户端也没有「滚到第 N 条消息」的 API（`sessions.search` 只回 `{sessionId, snippet}`）。所以这一版做的是能读的那一半：**搜到 + 读全 + 复制**。
- **新增**：`conversation.view` 下 `id: "vault-search"`、`order: 5`，排在「对话」左侧，标签为「检索 / Search」。
- **能力**：输入关键词扫**整个会话原文**（不是召回用的 12000 字摘录，`transcripts.js` 新增 `all()` 读全量），命中按轮次标号；清空搜索时显示**轮次地图**——每个用户轮次一行（第 N 轮 + 首句 160 字），几千步的会话因此约 70 行可读。
- **宿主 op**：`session.map {sessionId}`（轮次 + 条数 + 字数）、`session.search {sessionId, query, limit}`（按命中词数排序，上限 50）。两个 op 都要求**该会话已绑定到某个智能体**，否则 `no-agent`；只允许读自己名下会话，否则 `not-found`。
- **边界**：不做跨会话检索（那是 `agent_recall` 的 `session` 来源）；不做跳转（没有锚点 API）。

## 2.0.5 — 2026-10-31

手机/平板上的确认弹窗真正落进屏幕里了。只动客户端，刷新页面即可。

- **症状**：2.0.3 把 `window.confirm()` 换成面板内弹层后桌面正常，手机上点「删除智能体」仍然像没反应——弹层其实渲染了，但落在视口外。宿主在窄屏让面板长过一屏（`.am-root{height:100%}` 碰到 auto 高度的父级会退化成内容高度），而遮罩是 `position:absolute; inset:0`，「垂直居中」因此相对两千多像素高的整块内容居中；滚到底部点按钮时，对话框停在屏幕上方很远的位置。
- **修法**：遮罩改 `position:fixed`（跟视口而不是面板盒子走）、`z-index` 提到 `2147483000`（不被壳层浮层压住）、加 `overflow:auto` 并让卡片 `margin:auto`（横屏等矮视口里对话框自己可滚，不会顶出屏幕）。
- 复现与验证：用静态骨架复刻「容器比视口高 + 滚到底部点按钮」，`absolute` 版对话框在视口外（复现），`fixed` 版落在视口中央；360 / 420 宽各截一次。
- 测试：`test-client.mjs` 照旧通过（233 个文案键、无 `window.confirm`）。

## 2.0.4 — 2026-10-31

设置页新增「目录」卡片，三个目录一键在文件管理器里打开；顺手修掉「对话入索引」开关存不住的问题。宿主侧改了，需完全重启 DSH。

- **目录卡片**（设置页）：记忆库目录、知识库目录、插件目录，各带一行路径和「打开」按钮。插件目录跟着安装位置走（现在是 `E:\Projects\dsh-plugins\dsh-agent-vault`），换了目录不用改代码。
- **按钮走宿主，不走页面**：客户端只发 `fs.reveal {target}`，target 只能是 `root` / `knowledge` / `plugin`；路径由宿主映射（`reveal.js` → `explorer.exe` / `open` / `xdg-open`），页面拿不到「打开任意路径」的能力。未知 target 回 400，目录不存在回 404。
- 修 bug：设置页的「对话入索引」开关调 `settings.save {transcripts}`，但宿主 op 只转发 `knowledgeDir` 和 `hideBoundSessions`——开关看着能点、刷新后又变回去。现在 `settings.save` 一并转发 `transcripts` / `sessionsRoot` / `transcriptExclude`。
- 测试：新增 `test-reveal.mjs`（三个平台的命令、空/非法路径不 spawn、spawn 抛错返回 false）；`test-host.mjs` 补 `fs.reveal` 的三个目标、非法 target、以及 `transcripts` 开关是否真的落盘。现在 `npm test` 跑 14 个脚本。
- 截图核对：320 / 360 / 1100px 三档，路径在窄屏换行、按钮不挤压。

## 2.0.3 — 2026-10-31

手机/平板上的确认弹窗不再丢失。只动客户端，刷新页面即可。

- **症状**：点「删除智能体」，什么都没发生——没有确认框、也没有删除。原因是用的是浏览器原生 `window.confirm()`，它在部分移动端 WebView / 内嵌框架里会被静默丢弃（调用直接返回 `false`，连提示都没有），于是按钮看起来像坏了。
- **修法**：改成面板内的确认弹层（`.am-modal-mask` + `.am-modal`）：半透明遮罩 + 居中卡片 + 两枚按钮；窄屏下按钮改为竖排、整宽 38px 高，拇指够得到；点遮罩空白处或按 Esc 等同「取消」。
- 同一处隐患的四个兄弟一起换掉了：删除讨论室、重置接力、删除知识条目（两处）原本也都用 `window.confirm()`，在手机上会同样哑掉。
- 新增 `test-client.mjs`（并入 `npm test`）：① 禁止 `client.js` 出现 `window.confirm(` 调用（注释除外）；② 每个 `t('key')` 都必须在 zh/en 两份字典里各有定义——这一条已顺手查出并确认 `memoryHint`/`dirHint` 是多行定义（不是缺键）。
- 验证：静态骨架 + 无头 Edge，在 360px 与 1100px 各截图核对（弹层居中、遮罩覆盖面板、窄屏按钮竖排）。

## 2.0.2 — 2026-10-31

窄屏（手机）布局修复 + 记忆库横条常驻滑块。只动客户端 CSS，没有宿主侧改动，刷新页面即可。

- **症状**：视口窄时面板仍是「264px 记忆库栏 + 主栏」，主栏被挤到几十像素，八个页签里靠右的几个被 `overflow:hidden` 裁掉——看不到也点不到。
- **修法**：新增 `@media (max-width:720px)`：记忆库栏转为顶部横向胶囊条（`overflow-x:auto`，不撑宽面板）；页签容器由 `flex` 改为 `grid; grid-template-columns:repeat(4,minmax(0,1fr))`，八项固定 4×2 全可见；头部/页签/正文内边距 26px → 12px；讨论室成员条、消息流、输入区同步收窄。
- **滑块**：横条最初把滚动条藏了（`scrollbar-width:none`），列表再长也看不出还有几个智能体。现在改成 6px 高的常驻细滑块（`scrollbar-width:thin` + 自定义 `::-webkit-scrollbar` 轨道/滑块，滑块色 `--dsw-alias-border-l2`、悬停 `--dsw-alias-label-tertiary`），横条底部留 4px 内边距，滑块不压胶囊。触摸屏上原生滚动条是覆盖式的（iOS Safari 不认 `::-webkit-scrollbar`），这类设备照常左右滑动。
- 桌面宽度下所有原规则不变（新样式全部包在媒体查询里）。
- 验证：把插件真实的 `CSS` 常量抽出来套一份等价 DOM 骨架，用无头 Edge 在 320 / 360 / 720 / 1100px 四档宽度各截图核对（4×2 页签在 320px 下仍完整；1100px 与改动前一致；滑块完整显示、胶囊不被压住）。截图存于 `docs/images/narrow-panel.png`（不打进 npm 包）。

## 2.0.1 — 2026-10-30

只改文档，没有代码变化。`docs/migrate-1.3-to-2.0.md` 在 2.0.0 的包里写错了两处：

- 模型下载脚本的参数是 `--dir <modelsDir>`（模型目录），不是 `--dest`；脚本里 `flag()` 只认自己用到的名字，多写的参数会被静默忽略。
- 「面板会先下载模型再建向量」是错的：`memory.model` 只有 `status` 与 `prepare`，模型缺失时「准备向量」按钮禁用并显示原因，下载要自己跑 `scripts/fetch-model.mjs`。
- 检查点拆分的触发点写成「首次读」不准确，实际是 `readAll` / `write` 都会触发，所以是「首次读取或写入」；自检表里的条数说明改成「日志 + 检查点两个页签加起来 = 升级前总条数」。
- `docs/memory-recall-v2.md` 里程碑表 M11 与 M12 之间的空行导致表格断开，已修。

## 2.0.0 — 2026-10-30

2.0 转正。相对 1.3.3 的主体是「召回层」：日志、审计日志、知识库、对话原文都能按当前智能体检索，`agent_recall` 把结果作为工具返回值交给模型——**不进 system prompt**，所以不会顶掉前缀缓存。beta.1 冻结的契约自本版生效，破坏性调整留给 3.0。

### 1.3.3 → 2.0.0 一览

- **工具**：新增 `agent_recall`（`query` / `limit` / `source` / `since` / `expand` / `mode`，`session` 行带 `hit`，扩展行带 `why`，检查点永不返回）与 `agent_alias`（`list` / `set` / `delete`）。原有工具只多了一条「写入用绝对日期」的说明。
- **面板**：8 个页签，新增「回忆」（检索、展开全文、索引状态、语义索引、排序微调、别名表）与「检查点」（只读）；侧栏「智能体对话」支持右键菜单与 Ctrl/⌘、Shift 多选。
- **检索**：词法（标题 6 : 正文 min(count,40)，覆盖率平方，30 天半衰期）+ 一跳关联扩展（引用 / 实体 / 会话三类边，不落盘）+ 别名表 + 本地语义（BGE-small-zh，`onnxruntime-node` 缺失则降级）+ RRF 融合（`k=20`，余弦下限 0.45）；对话原文按会话入索引，可逐会话排除，正文 12000 字预算。
- **热度**：引用入度 / 打开 / 曝光计数（`index/access.json`）只破同分；打开旧笔记会把衰减参照时间前移（上限 180 天）。
- **磁盘**：新增 `checkpoints/<agentId>.jsonl`（检查点与笔记分文件，旧文件首访时惰性拆分）、`index/`（`state.json` / `aliases.json` / `vectors.*` / `access.json`）、`models/`（可选模型）；`settings.json` 新增 `recall.*` 键。
- **依赖**：`onnxruntime-node` 为 `optionalDependencies`，加载失败自动降级为纯词法。
- **npm**：`latest` 指向 2.0.0；`1.3.3` 保留在上一条稳定线。

升级与回退的逐步说明（含检查点合并命令）见 [`docs/migrate-1.3-to-2.0.md`](docs/migrate-1.3-to-2.0.md)。2.0 线内部的取舍与实测（哪些做了、哪些量完没上线）见下文的 beta.4 → beta.1 小节，以及 `docs/memory-recall-v2.md` §7–§10。

### 说明

- 语义检索是**可选**的：不下载模型时 `hybrid` 会降级成词法并在面板说明原因，功能不缺块。
- 检索灵敏度：45 条改写用例的配对区间宽度 ±0.128 MRR——小于这个量级的改动不宣称提升，`docs/embedding-local.md` 里每条参数决定都附区间。
- 契约冻结面（工具参数、11 个 op、设置键、磁盘格式）逐条列在 `docs/memory-recall-v2.md` §13。

## 2.0.0-beta.4 — 2026-10-30

三条从 AstrBot-LivingMemory 借来的排序手段：热度、读取移动衰减参照时间、去重 / MMR。前两条上线（改排序），后两条只留开关（真库上量不出收益）。工具参数与 op 的返回结构不变，只新增三个设置键、一个 `memory.index` 的 `settings` 字段与面板一张卡片。

### 新增

- `access.js`：`createAccess({ rootDir, now, flushMs })` → `record(key, 'read' | 'exposed')` / `stats(key)` / `flush()` / `size`；落 `index/access.json`（`{version:1, entries}`），2 s 合并写、原子 rename、上限 5000 键、保留 365 天、损坏时重建。
- 热度：`recall.heat`（0–0.5，默认 **0.25**）。`H = 1 + heat·(½·min(1, refs/10) + ½·min(1, (opens + exposed/4)/20))`，`refs` 由一次正则扫全语料得到（`CITE_ID`）；`memory.open` 记一次 read，结果页出现记一次 exposed。热度是乘法因子，**只在同分时可能改变顺序**。
- 读取移动衰减参照时间：`referenceTime = min(max(at, lastRead), at + 180d)`。400 天前的笔记被读一次，分数可涨 5 倍以上。
- 去重 / MMR：`recall.dedupe`、`recall.mmr`（0–1，默认 **0**）。`dedupe > 0` 时对 top-3 相似行贪心降权（不删行、不动第 1 名）；`mmr > 0` 时走真 MMR 贪心。`total` 始终是截断前的条数。
- `memory.index` 返回值新增 `settings: { heat, dedupe, mmr, titleWeight }`（增量字段，旧客户端忽略即可）。
- 面板「回忆」页签新增**排序微调**卡片：三个数字输入 + 保存（走 `recall.save`）；卡片显示的是宿主回报的生效值，不是本地默认值。
- `eval/dupe-rate.mjs`：每条查询 top-3 两两 Jaccard，报分位与两个阈值下的重复率。

### 修复

- 所有评测脚本改为 `createRecall({ …, access: false })`：测一次就写一次访问计数，会让第二次跑出来的数字和第一次不一样。

### 实测

- 重复度（真库 59 条查询 × 两种 mode）：top-3 最大 Jaccard **0.19**（分位 p90 ≤ 0.13），0.5 / 0.75 阈值下重复率 **0%** → 没有东西可去重，`dedupe`/`mmr` 默认 0，机制保留。
- 热度只破平局：`test-recall.mjs` 里同分三条，被引用者反超、两次打开再翻回来、`heat: 0` 回到文件序、20 次重复查询 top-1 不漂移。
- 回归：词法族 92.9% / 100% / 0.952 不动；改写族 hybrid 13.3% / 37.8% / 0.281（与 beta.2 同量级）。

### 说明

- 为什么不做 astrbot 那种 `0.5×相关 + 0.25×重要 + 0.25×新鲜`：真库多数查询只有一两条命中，强加权重会开始改变排序而不是打破平局，而评测灵敏度只有 ±0.128 MRR，测不出这种改动。
- `heat` 上限 0.5 与 `titleWeight` 同理：再高就不是「破平局」而是「主导排序」。
- 删掉 `index/access.json` 是安全的，只是热度归零；`settings.json` 里缺这三个键时按默认值补齐，不需要迁移。

## 2.0.0-beta.3 — 2026-10-30

写入时的相对时间归一：三条写入工具都要求绝对日期，宿主再用窄口径校验补一行提醒。工具参数、op 返回结构、磁盘格式都不变。

### 新增

- `time.js`：`relativeWords(text)`、`todayStamp(now)`、`timeHint(text, now)`、`withTimeHint(result, text, now)`。
- 工具描述里统一注入 `TIME_RULE`（`agent_memory_save` / `agent_knowledge_write` / `agent_journal` 的 `write`）：自己陈述的事件、决定、计划里的「今天/昨天/下周」，写之前换算成 `YYYY-MM-DD`；引用原话保留原话，括号补日期。
- 写入结果里的 `timeHint`：正文命中窄表（今天/昨天/明天/前天/后天/上周/这周/下周/上个月/下个月/今年/去年/明年、今早/今晚/昨晚 等）**且**没有任何 `2026-10-30`、`2026/10/30`、`10月30日` 锚点时追加一行，写明建议的日期。写入不中断——拒绝会丢信息，提醒还能补。
- `test-time.mjs`（并入 `npm test`，现 12 个脚本）：词表命中与去重、锚点不再提醒、`最近`/`目前` 不误报、结果不被原地修改、三个工具确实引用 `TIME_RULE` 且三条调用路径都过 `withTimeHint`。

### 说明

- 为什么不做宽松词表：「最近」「目前」在很多句子里就是诚实的精度，强行精确反而更假。
- 为什么不在 op 层加字段：beta.1 冻结了 11 个 op 的返回结构；提示只挂在工具文本上，面板写入是用户手写的，不需要。
- 现状统计（改前真库，用 `time.js` 直接扫）：日志 33 条命中 3 条（9%）、知识库 28 条命中 1 条（4%）、检查点 8 条 0 条、短记忆 7 个文件命中 1 个。命中样本正是「今天又复发一次」这类反复出现的故障记录。
- 交接提醒（order 121 的 prompt 段）追加一句「两处都用绝对日期（2026-10-30），不要写今天/昨天」，在模型最容易写混的时间点再兜一次。

## 2.0.0-beta.2 — 2026-10-30

两件「看着该做」的事量完之后都没有上线，旋钮与证据留下。面板与工具行为不变，契约冻结清单不受影响（只新增一个设置键）。

### 新增

- **`recall.titleWeight`**（设置键 + `agent_recall` 按次覆盖），夹在 `0–0.5`，默认 `0`。`> 0` 时 `vectors.js` 为每条笔记多存一行标题向量（`chunk: -1`），`scoreMap` 按 `best = (1-w)·正文最佳 + w·标题` 混合；改这个权重会触发一次重建。
- 评测：`eval/title-vs-body.mjs`（标题与正文的余弦诊断）、`eval/knowledge-eval.mjs`（知识库 lexical vs hybrid + 噪声探针）、`eval/cases.mjs` 增 `KNOWLEDGE_CASES`（14 条）。

### 实测：标题加权不上线

词法族 14 条上标题余弦确实更高（0.689 vs 0.592，14/14），但改写族 45 条上更低（-0.041，仅 10/45）。接进真实管线后改写族 hybrid 反而下降：`0` → 13.3% / MRR 0.281，`0.15` → 11.1% / 0.280，`0.25` → 8.9% / 0.251。原因：词法路径已给标题 6:1 权重，再塞进语义列就是双计，RRF 融合后单路收益被前排吃掉。默认保持 `0`。

### 实测：知识库不接语义

25 条共享条目、14 条改写查询：lexical 与 hybrid 同为 top-1 78.6% / top-3 92.9% / MRR 0.857（互换两条，净 0）；无关问题余弦峰值 **0.471**，高于 0.45 下限 → 接上只泄漏。`VECTOR_SOURCES` 保持 `['journal','log']`。

### 说明

- 8 个评测脚本末尾加 `process.exit(0)`：原生 ORT 会话有时让进程跑完不退出，评测会凭空「挂住」。
- 测试在禁止写系统临时目录的沙箱里需要 `TEMP=/path npm test`（`test-*.mjs` 用 `mkdtemp` 建库）。


## 2.0.0-beta.1 — 2026-10-30

版本口径从 alpha 转 beta：**契约冻结，进入 beta 渠道**。这一版没有行为变化——`2.0.0-alpha.13` 的代码原样发布，改的是版本号、发布渠道与文档里的承诺。冻结的意思很具体：下面这些面在 `2.0.0` 正式版之前不再改，改就要等 3.0。

### 冻结的契约

- **两个工具**：`agent_recall`（`query` / `limit` / `source` / `since` / `expand` / `mode`）与 `agent_alias`（`list` / `set` / `delete`）的名字、参数、返回结构。
- **宿主 op**：`memory.recall`、`memory.reindex`、`memory.index`、`memory.open`、`memory.message`、`memory.sessions`、`memory.transcript`、`memory.model`、`memory.aliases`、`memory.alias`、`recall.save` 的请求与返回形状。
- **设置键**：`settings.json` 的 `recall.mode` / `lexicalWeight` / `semanticWeight` / `minCosine` / `rrfK`、`transcriptExclude`、`transcriptInclude`、`hideBoundSessions`。
- **磁盘格式**：`checkpoints/<agentId>.jsonl`、`index/state.json`、`index/aliases.json`、`index/vectors.json`（version 2）+ `index/vectors.bin`、记忆日志标题行的 `[session: …]` 后缀。
- **测试套件**：`npm test` 覆盖的 11 个脚本是发布门槛，删减需要理由。

### 仍然可以变

默认参数值（按 `eval/` 的配对区间证据改）、内部实现与文件布局之外的细节、面板文案与排版。beta 期间每改一次默认值，都要重跑 `eval/recall-grid.mjs` 并把区间写进 README。

### 发布渠道

`npm publish --tag beta`：`dsh-agent-vault@beta` 指向 `2.0.0-beta.N`，`latest` 仍停在 **1.3.3**，直到 `2.0.0` 正式版。

## 2.0.0-alpha.13 — 2026-10-30

长笔记不再被 512 token 截断：一条笔记改成多行向量，相似度取各段最大值。这一版上线的理由是**正确性**，不是分数——A/B 的差值落在评测灵敏度之内，文档里如实写了。

### 新增

- **分块嵌入**（`vectors.js`）：`CHUNK_CHARS = 420`、重叠 60 字、优先切在句末；每段前置标题；`chunksOf(entry, chunkChars)` 导出（`0` = 不分块）。`index/vectors.json` 升到 **version 2**（`row: "key#chunk"`、`chunk`、`chunks`），v1 读到即作废重建。
- **相似度取最大**：同一条笔记的多行取 max，不取平均（平均会让别的段落冲淡真正对上的那一段）。
- **`eval/chunk-variants.mjs`**：整条 / 420 字 / 260 字三变体 A/B，各自在临时 `vectorsDir` 建库（不动真索引），输出改写族、词法族、噪声峰值与配对区间。
- **`eval/stats.mjs`**：自助法工具抽成模块（`BOOT`、`makeRandom`、`clusterBootstrap`、`pairedInterval`、`fade`、`pct`、`top1Of`），`recall-grid.mjs` 改为引用它。
- **`eval/token-check.mjs`** 保留：实测 28 条笔记的 token 数（最小 356 / 中位 654 / 最大 1292，22 条超 512）。

### 变更

- `createVectors` / `createRecall` 接受 `chunkChars` 与 `vectorsDir`（后者供评测用，避免污染真索引）；`sync()` 的判脏条件增加「分块数是否相同」，改窗口大小也会重建。
- `vectors.status()` 新增 `chunks`、`chunkChars`；`count` 改为**笔记数**（行数是 `chunks`）。面板「语义索引」卡片的条数含义不变。

### 实测

- 真库 `demo-agent`（28 条笔记 / 45 条改写 + 14 条词法）：整条 157 行 → 420 字 435 行 → 260 字 735 行；建库 5.6 / 6.7 / 6.4 s（增量时只嵌脏条目）。
- 改写族 hybrid：0.247 → 0.253 → 0.266，配对区间分别为 +0.006 [-0.066, +0.088]、+0.019 [-0.078, +0.115]，**都跨 0**。
- 词法族 hybrid 100% 不动；噪声峰值 0.407 → 0.424（260 字 0.430），仍低于 0.45 下限，余量 0.026。

### 说明

- 5,085 个 token 此前从未进入编码器；分块后全部可见，这是上线的直接理由，而不是 MRR。
- 260 字版本 top-3 更高（42.2% vs 33.3%），但行数多 70%、噪声更靠近下限，故取 420 字。
- 宿主侧改动（`vectors.js` / `recall.js`）**必须完全重启 DSH** 才生效；重启后首次查询会自动重建向量库（旧 v1 文件作废）。

## 2.0.0-alpha.12 — 2026-10-30

把 alpha.11 的评测重做一遍：样本扩到 45 条，统计换成能区分噪声的口径，并因此**推翻 alpha.11 自己做出的那个改动**。

### 新增

- **改写用例 15 → 45 条，覆盖 24 条笔记**（`eval/cases.mjs`）。同一笔记的 1–3 种说法在注释里标明——这是后面「按笔记聚类」的前提。
- **`eval/results/2.0.0-alpha.12.txt`**：本轮网格的完整输出存档（每轴配对区间、仍未排第一的用例清单、推荐配置），便于以后对账。
- **灵敏度测量**：脚本最后打印「这套用例能看见多大的差异」。

### 变更

- **`eval/recall-grid.mjs` 重写**：从 150 组叉积改为**顺序轴**（权重 → `k` → 下限），每组都在当前选择上测，16 组配置约 10 秒。判定规则从「比较点估计」改为**配对自助法**（4000 次重采样、种子固定、按笔记聚类），95% 区间含 0 就不改动默认值。
- **余弦下限 0.40 → 0.45**（回退 alpha.11）。45 条上 0.40 与 0.45 的差值是 +0.006 [-0.047, +0.056]，不构成证据；而 0.40 比 0.45 更靠近噪声水平（无关查询峰值余弦 0.361）。alpha.11 依据一次点估计把它改成 0.40，样本量不足以支撑。
- **权重 0.6/0.4 与 `rrfK: 20` 保留**：所有候选与默认值的配对区间都含 0；`k` 的差值恰为 0.000，说明它在这套打分里几乎不起作用。

### 说明

- **这套评测的灵敏度是 ±0.128 MRR**（45 条 / 24 条笔记）。比这更小的差异在这里测不出来——alpha.11 那些「+0.008、+0.01」的结论都落在这个区间内，不该被当成证据。
- 改写族 hybrid 仍是 top-1 13.3%（6/45）、MRR 0.247；参数已无可调空间，瓶颈在检索质量（纯语义排名里目标排第一的只有 4/15，中位名次 6/25）。下一步是换模型 / 分块 / 标题加权，不是继续拧参数。
- 词法族 hybrid 100%（`mode:"lexical"` 92.9%）不动；跨 `k` 的词法路径逐条一致。

## 2.0.0-alpha.11 — 2026-10-29

把语义融合参数从「手定」变成「量出来的」：用例集中、可体检、可扫描，选值有策略。

### 新增

- **`eval/cases.mjs`**：评测用例的唯一定义处，拆 `LEXICAL_CASES`（14 条，词面可对）与 `PARAPHRASE_CASES`（15 条，几乎无字面重叠），另有 `DROPPED_CASES` 留档被剔除的用例。三个评测脚本改为读它，不再各自维护一份。
- **`eval/check-cases.mjs`**：用例体检，打印每条查询在**纯词法**下的真实名次。词法已排第一的改写用例量不出语义收益——这次据此剔掉 6 条（21 → 15）。
- **`eval/recall-grid.mjs`**：150 组网格（权重 × `rrfK` × 余弦下限），按写死的策略选值，并做三件对照：噪声探针（6 条无关查询的峰值余弦）、词法路径不变性（25 组参数下排名逐条一致）、逐条列出仍未排第一的用例。
- **`eval/embed-variants.mjs`**：嵌入输入对照（整篇 / 标题 + 240 字 / 仅标题），记录了一次被否掉的优化。
- **`recall.rrfK` 参数**：进 `settings.json`（`clampRrfK` 夹到 `[1,200]`），`agent_recall` / `memory.recall` 可按次覆盖。此前 `k` 硬编码为 20，无法实验。

### 变更

- **余弦下限 0.45 → 0.40**。依据：无关查询的峰值余弦 0.361，0.40 仍高于它；网格里 0.30/0.35 的平均 MRR 更高但都 ≤ 噪声水平，因此否决。改写族 MRR 0.278 → 0.286，词法族不变。
- **权重 0.6/0.4 与 `rrfK: 20` 保留**，但理由从「拍的」变成「扫过」：权重是 150 组的 argmax，`k` 的轴间差异只有 0.011 MRR。
- **用法例体检过的集合重测**：改写族从 21 条（含 6 条词法已答对）收敛到 15 条真正需要语义的查询，因此数字与 alpha.8 的 41.7% 不可比——那是含送分题的成绩。

### 说明

- 参数已无可调空间（±0.01 MRR）。卡住 top-1 的是检索质量本身，不是参数：纯语义排名下 15 条改写的目标仅 4 条能排第一。
- 试过只嵌「标题 + 前 240 字」：纯语义排名更好（0.358 → 0.438），但推高无关查询的余弦、下限被迫升到 0.45，端到端反而 0.286 → 0.256，已回退并在 `vectors.js` 留注释。

## 2.0.0-alpha.10 — 2026-10-29

面板「回忆」页签补上语义层的操作面：模型状态、向量准备与排序开关。

### 新增

- **「语义索引」卡片**：显示模型是否就绪（名称 + 维度）、向量条数、构建时间；不可用时显示原因（`model-missing` / ORT 加载失败等）。「准备向量」/「同步向量」走 `memory.model {action:"prepare"}`，加载模型并按内容 hash 增量同步 `index/vectors.bin`。
- **排序开关**：`混合` / `仅关键词` 两个按钮，经新 op `recall.save` 写进 `settings.json` 的 `recall.mode`，重启后保留；单次检索仍可用 `mode` 参数覆盖。
- **`recall.save` 宿主 op**：局部合并 `recall` 设置（`mode` 白名单、三个数值夹到 `[0,1]`），返回最新的 `memory.index` 状态。
- **`store.state()` 的 `recall` 字段**：面板与外部消费者不必再去读 `settings.json` 才能知道当前排序模式。

### 修复

- `settings.json` 的 `recall` 段此前会被 `store.settings()` 丢弃——`recall.lexicalWeight` / `semanticWeight` / `minCosine` 写了也不生效，`recall.mode` 更是无处可存。现在读取时归一化、写入时局部合并。

## 2.0.0-alpha.9 — 2026-10-29

面板新增「检查点」页签：交棒检查点从日志域里分出来单独陈览。

### 新增

- **面板「检查点」页签**：按时间倒序列出当前智能体的交棒检查点（标题 / 摘要 / id / 时间），点开看全文与元信息（触发时的 token 数、阈值、所属会话），并提供「复制全文」。检查点是权威状态，这里**只读**：没有新建，也没有删除按钮。
- **`journal.list` 的 `includeCheckpoints`**：宿主 op 接受该参数并透传给 `journals.list`；默认 `false`，日志页签因此只呈现笔记。返回的每条记录多了 `meta`（检查点的 `tokens` / `threshold` / `sessionId` 等）。

### 修复

- 日志页签此前没有入口能看到检查点（`journal.list` 默认过滤掉它们，而面板又不传 `includeCheckpoints`），只能从「接力」页签的会话卡片上看到一个 id 标签。

## 2.0.0-alpha.8 — 2026-10-29

语义检索：本地 BGE 模型 + 日志层向量 + RRF 混合排名。

### 新增

- **`embed.js`**：自写 BERT WordPiece 分词（`vocab.txt` 驱动、512 token 截断、CLS pooling、L2 归一化）+ `createEmbedder()`；`onnxruntime-node` 惰性 `require`，依赖缺失只让语义层降级，不影响插件加载。查询侧加 BGE 指令前缀（`为这个句子生成表示以用于检索相关文章：`），文档侧不加。
- **`vectors.js`**：`index/vectors.bin` + `index/vectors.json`，只嵌 `journal` / `log`；**按内容 sha256 前 16 位判脏**（日志是追加写，mtime 规则会让每次保存都全量重嵌）；增量嵌入、删除即重写收缩；写入走 tmp+rename；**全库一份、跨智能体共享**，日志条目 key 带智能体前缀（`log:<agentId>:m-3`，位置序号跨文件会撞键）。
- **`recall.js` 混合检索**：`mode: hybrid | lexical`（默认 hybrid），`settings.json` 的 `recall: {lexicalWeight, semanticWeight, minCosine}` 可调；融合用**倒数排名融合**（RRF，`0.6/(20+lexRank) + 0.4/(20+semRank)`），语义独有命中 `via:"semantic"` + `why.cosine`；余弦下限 0.45；图扩展只吃词法种子。`search()` 由同步改为 async（`await recall.search(...)`），`reindex()` 同时重建语义库。
- **`memory.model {action:"status" | "prepare"}` op** 与启动后 4 秒的后台预热（`timer.unref()`）。
- **`agent_recall` 的 `mode` 参数**。
- **`scripts/fetch-model.mjs`**：下载 BGE-small-zh-v1.5（6 个文件，逐个校验 size 与 sha256，hf-mirror → huggingface，可重跑续传）。
- **`eval/recall-paraphrase.mjs`**：12 条与目标笔记无字面重叠的改写查询，对照 lexical / hybrid 的 top-1、top-3、MRR、延迟与语义独有命中。
- **`test-embed.mjs`**：分词与 wordpiece、512 截断、向量库增量/删除、语义独有命中、余弦下限、`mode` 正交性、降级路径、以及**RRF 不许被词法量纲压住**的回归用例（假 embedder 给精确余弦，不依赖真模型）。

### 修复

- **跨智能体撞键导致反复重嵌**：日志条目在一个文件内是位置序号（`m-0`、`m-1`…），向量键 `log:<id>` 因此跨智能体冲突；同时 `logEntries()` 首次读取返回的是未贴 `agent` 的原始行、缓存里却是贴过的，两条路径给出不同键，实测每次查询重嵌 54 条（真库 1.8 s/次）。改为键带智能体前缀（`log:<agentId>:m-3`）、缓存与返回走同一份映射、按 key 排序后再比较，稳态回到 20 ms。
- 加权和融合的量纲缺陷：词法分数归一化后恒为 1.0（占 0.6），余弦 0.5–0.65（占 0.2–0.26），导致「有词法命中的错条目」永远压住「只靠语义的正确条目」。改写集实测 33.3% → RRF 后 41.7%。

### 说明

- 实测（真库 `demo-agent`，28 条 journal / 92 条向量）：lexical top-1 25.0% / MRR 0.403（1 ms）→ hybrid 41.7% / 0.528（20 ms，预热后；冷启动首次约 200 ms）；词法基线（14 条词面可对）保持 92.9% / 100% / 0.952。
- 模型 24 MB 不进 npm 包；`onnxruntime-node` 是唯一新增依赖（`^1.31.1`）。Electron 主进程加载已真机验证（Electron 44.7 / Node 24.21 / N-API 10，加载 150 ms，嵌入 3 条 8 ms，与系统 node 结果一致）。
- 面板的「语义索引」卡片与 `mode` 切换按钮留到 alpha.9。

## 2.0.0-alpha.7 — 2026-10-29

别名可写，日志命中可回到对话。

### 新增

- **`agent_alias` 工具**：`action: list | set | delete`，维护 `index/aliases.json`。
- **`memory.aliases` / `memory.alias {key, targets}` op**：面板与外部通道都能读写别名表；`remove: true` 删除，空目标列表同样删除。
- **面板「关联别名」卡片**：「回忆」页签下直接列出、新增、删除别名。
- **日志条目带会话**：`agent_memory_save` 在日志标题行末尾写 `[session: session-…]`；解析时剥掉后缀填 `sessionId`，日志命中因此也能「回到对话」。旧日志无需迁移。

### 说明

- 别名全局共享，不按智能体隔离；写后立即生效（mtime 判脏），不需要重建索引。
- 面板手写的记忆记 `panel`，没有会话可记时不加后缀。
## 2.0.0-alpha.6 — 2026-10-29

命中定位到具体消息（M5）。

### 新增

- **`transcripts.js` 保留消息边界**：解析时产出 `{seq, role, at, text}` 列表，`messagesOf(sessionId)` 可读；超出字符预算时按「留头 + 留尾、丢中间」裁剪（`trimMessages`），消息列表与正文共用同一子集。
- **`session` 命中带 `hit`**：`agent_recall` 与面板的结果多一个 `hit: {seq, role, at, text}`，指向得分最高的那条消息。
- **`memory.message` op**：按 `sessionId + seq` 取单条消息全文；会话不可读或消息未入索引分别返回 404。
- **面板**：结果行显示「命中消息 #N · 角色 · 原文摘要」，展开项显示该条全文与「复制该条」。

### 说明

- 宿主 `uiWorkspace.openSession` 不能定位到消息，所以没有「自动滚动到第 N 条」；「回到对话」仍只到会话。
- 消息列表只在内存缓存里，`memory.reindex` 重建。

## 2.0.0-alpha.5 — 2026-10-29

召回结果的可用性修补：片段定位与会话取舍。设计见 `docs/memory-recall-v2.md` §9。

### 新增

- **`rank.js` 的 `snippet(text, tokens, size)`**：返回命中词最密集的窗口（两侧补 `…`），无命中时退回正文开头。会话来源动辄上万字，原来按开头截取，预览几乎全是「继续」这类寒暄。
- **逐会话勾选**：`memory.sessions` 列出本智能体有权读的会话（标题、时间、字符数、是否入库），`memory.transcript` 按 `sessionId` 开关；被排除的会话记在 `settings.json` 的 `transcriptExclude`，检索与 `memory.reindex` 都不再计入，但 `memory.open` 与「回到对话」不受影响。
- 面板「回忆」页签新增「对话来源」卡片（勾选框 + 标题 + 时间 + 字符数），改动即时生效并刷新索引状态。
- `test-transcripts.mjs` 覆盖排除后的列表 / 检索差异；`test-recall.mjs` 覆盖片段窗口；`test-host.mjs` 覆盖两个新 op。

### 修复

- `/op` 的错误响应把 `not-found` 也映射成 400，现在返回 404（`memory.transcript` 传未知会话时会用到）。

## 2.0.0-alpha.4 — 2026-10-28

对话原文入索引（M3）。设计见 `docs/memory-recall-v2.md` §5.4。

### 新增

- **`transcripts.js`**：读取 `~/.dsh/sessions` 下**本智能体所属**的会话（它接力过的、或绑定声明归属它的），只抽 `user` / `assistant` 的文本，工具调用、工具结果与 `thinking` 一律丢弃；每会话累加到 12000 字符截断并附 `[truncated]`；入库前打码 `sk-` 密钥、`Bearer` token、`api_key=` / `token=` 赋值、`ghp_` / `github_pat_`。
- **`zstd-frames.mjs`**：约 70 行、只用 `node:zlib` 的 zstd 帧解析（可跳过帧 + 标准帧 + 块头），把 `.jsonl.zstd` 解成文本，不引入原生依赖。
- 召回新增来源 `session`：`agent_recall` 与面板都能按「对话」过滤，结果带「关联·会话」徽标；`memory.open` 对会话来源返回 `sessionId`，面板展开项出现「回到对话」按钮。
- **设置开关「对话入索引」**（`settings.json` 的 `transcripts`）：默认开；关掉后检索不再返回对话来源。`sessionsRoot` 可覆盖扫描根目录（默认 `~/.dsh/sessions`）。
- `test-transcripts.mjs`：打码、`thinking` 丢弃、归属隔离、字符上限、缓存复用、关开关后为空。

### 说明

- 归属判定只看 `journals` 的 `meta.sessionId`、`handoff` 配置与 `bindings`，不按目录结构猜，所以别的智能体的会话不会因为目录相邻而泄漏。
- 对话内容只在**索引缓存**里存在，不落盘、不进任何日志文件；`memory.reindex` 会重建。
- 首轮建索引要读一遍相关会话（真库约 1–2 秒），之后按 `(size, mtimeMs)` 只重建有变化的会话。
- 打码是正则替换，不保证穷尽任何格式；处理敏感会话前请先关掉开关。

## 2.0.0-alpha.3 — 2026-10-28

召回层的一跳关联（M2.5）。设计见 `docs/memory-recall-v2.md` §6.5。

### 新增

- **`graph.js`**：按形状抽取实体（Windows / Unix 路径、`agent-xxxx`、`j-xxxx`、文件名、带点的 op 名、带连字符的包/仓库名），通用词与纯数字不入实体；三类边——`ref` 0.9（正文引用了另一条的 id）、`entity` ≤ 0.6（共享实体，按数量饱和、按文档频率衰减）、`session` 0.5（同一 `sessionId`）；只走 1 跳、每查询最多 5 个邻居，邻居分数 = `seed × 边权 × 0.3`，每个邻居保留它最强的那条边并记下 `why: {hub, edge, weight}`。边不落盘，每次现算。
- **`agent_recall` 的 `expand` 变成真参数**：默认 `1`（别名展开 + 一跳关联），`0` 是纯词汇排名，方便对照基线。
- **`index/aliases.json`**：手写的别名表，如 `{"vault 插件": ["dsh-agent-vault"]}`。命中的条目以「关联·别名」出现；`memory.reindex` 会建一份空的。
- 面板「回忆」结果带「关联·实体 / 关联·引用 / 关联·别名 / 关联·会话」徽标，展开项里写明「关联自 X」。
- `memory.index` 的返回值增加 `expand`、`aliasFile`、`aliases`。

### 修复

- 单共享实体的边权原本是 `0.6 × 0.5 = 0.3`，低于 0.35 的边下限——最常见的桥永远不成立。改为 `0.6 × min(1, 0.5 + 共享/4)`，并给实体加文档频率衰减（`df ≥ 4` 起降、`≥ 7` 归零），否则「agent-memory」这种半库都提的词会把扩展变成噪声。

### 说明

- 真库实测（14 条人工标注查询，journal）：`expand:0` 与 `expand:1` 的 top-1 都是 92.9%、top-3 100%、MRR 0.952，rank changes: none；14 条共扩出 18 条邻居，单查询最多 2 条。图扩展在当前同质语料上只是补尾，不抢词汇命中的位置。
- 扩展在工具调用内部完成，返回仍是尾部工具消息：不触碰 system prompt，零缓存失效。

## 2.0.0-alpha.2 — 2026-10-28

召回层的面板与缓存修正（M2）。设计见 `docs/memory-recall-v2.md`。

### 新增

- **面板「回忆」页签**：关键词检索当前智能体的日志笔记、记忆审计与共享知识库；可按来源（日志 / 记忆 / 知识库）与起始日期过滤；结果带来源徽标、时间与得分，点开显示全文。
- **索引状态卡片**：条目总数、构建时间、各来源条数，附「重建索引」按钮（`memory.reindex` 后立即刷新）。
- **`memory.open` op**：按 `src + id` 取一条命中记录的全文，供面板展开视图使用；同一能力经 `recall.open()` 暴露给测试。

### 修复

- **handoff 提醒不再逐字变化**：提醒文本原本把实时 token 数拼进去，每步都改一次 system prompt（order 121）→ 整段前缀每步重付。现在只写阈值，文本逐字节稳定，只在跨过阈值/解除时各翻转一次。

### 说明

- 面板检索只在索引里查：不进 system prompt、不改缓存前缀、不消耗 token。
- 「回忆」页签里还没有「回到该对话」的反查链接（日志条目没有稳定的会话键），留到 M3 与对话原文层一起做。
## 2.0.0-alpha.1 — 2026-10-28

召回层落地（M1）。设计见 `docs/memory-recall-v2.md`；这是 alpha，返回结构可能还会动，beta 起冻结。

### 新增

- **`agent_recall` 工具**：按关键词检索调用方智能体的可召回材料——自己的日志笔记、自己的记忆审计（`memory/<id>.log.md`）、共享知识库；`source` 限定来源，`since` 按时间过滤，`limit` 1–25。
- **`rank.js`**：纯函数排序。标题命中 6、标签 4、正文命中按出现次数封顶 40；得分再乘「覆盖率平方」（`matched / tokens`），最后乘 30 天半衰期的时衰。中文按字符二元组索引、子串匹配，不需要词典；`dsh-agent-vault` 这类标识符整体保留。
- **`recall.js` + `index/state.json`**：按文件 `(size, mtimeMs)` 缓存，`journal.delete` 后下一次搜索即生效；`memory.reindex` 全量重建、`memory.index` 读构建记录、`memory.recall` 供面板使用。

### 变更（破坏性）

- **检查点与日志笔记分文件**：检查点写入 `checkpoints/<agentId>.jsonl`，`journal/<agentId>.jsonl` 只留笔记。读取时两个文件按时间合并，`agent_journal` 的 `list` 行为不变。
- **旧文件自动迁移**：2.0 之前的日志文件里两种条目混在一起，首次访问该智能体的日志时惰性拆成两个文件（幂等；拆分后笔记文件不再含检查点）。不会有数据丢失，也不需要手动跑迁移。
- **`agent_recall` 不含检查点**：检查点是权威状态（整段注入），旧的可能与当前状态矛盾，所以永不进入检索结果。

### 说明

- 检索结果的匹配是 **OR** 语义：查询被切成 token 后，任意 token 命中即计入得分，再用「命中数 / token 数」的平方把只覆盖一部分的条目压下去（近似软 AND，但不是严格 AND）。所以查询词越多，全覆盖条目的领先越明显；单 token 查询退化为普通命中。
- 检索结果通过**工具返回值**返回，而不是注入 system prompt：注入会改写记忆段（order 120）之后的整个缓存前缀。`agent_recall` 请求时 `expand` 参数已被接受，但语义固定为 0——图扩展在 `2.0.0-alpha.3` 落地（§6.5）。
- 里程碑顺延：`2.0.0-alpha.2` 面板「回忆」页签，`2.0.0-alpha.3` 关联扩展，`2.0.0-alpha.4` 对话原文入索引（可选）；`latest` 仍指向 1.3.x。


## 1.3.3 — 2026-10-27

首个正式版，汇总 `1.3.3-beta.1` ~ `1.3.3-beta.6`（beta.2 之后的 beta 没有单独发到 npm）。下面先是 beta.6 新增的侧栏右键菜单，beta.5 及更早的条目见后文。

### 新增

- **侧栏「智能体对话」右键菜单**：右键对话行可「打开 / 归档 / 转化为强归档 / 取消归档 / 在智能体名下创建新对话」，右键智能体行可「在它名下创建新对话 / 收起 / 展开」。动作作用于整个选中集合；Ctrl（⌘）点击切换选中、Shift 点击在同一智能体内区间多选；选中的行有底色，右键点在已选行内保留整个选区，否则选区重置为该行。菜单按选区状态禁用不可能的动作（全部已归档时「归档」变灰等），成功在底部短暂提示，失败弹出错误文本。
- `bound.list` 的每个会话条目新增 `workspaceId`：右键新建对话不必先打开面板，就落在该智能体上一次使用的目录。

### 说明

- 新对话走 `agent.newSession`（新建会话 + 立即绑定 + 切换过去），**不继承**审批策略与模式；需要继承时仍用面板「续会话」/ 交接意图（那条路径在 `agent/created` 窗口里应用 preset）。

## 1.3.3-beta.5 — 2026-10-26

### 修复

- **自动切换从来没真正触发过（三处独立原因，叠加在一起）**：
  1. **客户端拿不到 `uiWorkspace`**：cordis 只从声明了注入的 fiber 解析服务，`client.js` 的 `inject` 只有 `['slots','locale']`，所以 `ctx.get('uiWorkspace')` 失败，而外层 `catch {}` 把它吞了——每 5 秒轮询一次，一次也没走到 `startSession`。已把 `uiWorkspace` 加进注入，并让 `startSession` 的异常不再静默。
  2. **传了 `{ agentPreset }` 就走进了 DSH 的「复用空白会话」路径**：`uiWorkspace.startSession(workspaceId, options)` 在 `options` 非空时调用 `connectBlank(workspaceId, reuse)`，它会在同工作区里找一个已存在的 blank 复用之，只准备草稿——**不会创建 Agent**，于是 `agent/created` 不触发，绑定、归档、启动指令全都不发生。beta.4 把 preset 传给 `startSession` 的做法本身就是错的。现在客户端**不传 options**（保证走 `sessions.create` 真新建），preset 改为随交接意图传给宿主。
  3. **preset 由宿主在首回合前应用**：`agent/created` 里用 `agentPresets.select(agent, preset)` 继承源会话的模式（与已有的 model / approval 继承放在一起）。DSH 的该接口只允许在「会话还没开始第一回合」时调用，`agent/created` 正是唯一的窗口。

### 说明

- 判定新会话的模式不要读 session header：header 的 `agentPreset` 是创建时的不可变值，之后只会被 `agent-preset/selected` 事件推进。真值看会话投影（`session_projcache` 的 `record.rows.agentPreset.val`）或日志里的 `agent-preset/selected` 事件。
- 实测（2026-10-26 17:48）：自动切换建出 `session-332ee334`，`agent-preset/selected` 事件为 `cordis`，绑定 `demo-agent`，启动指令送达，旧会话弱归档。

## 1.3.3-beta.4 — 2026-10-26

### 修复

- **自动切换出来的新会话丢模式（标准模式）**：冷会话（没在当前进程加载过）读不到 `agentPreset` 投影，`agentPresetOf` 直接返回空，客户端就没给 `startSession` 传 preset。现在按「实时投影 → 持久化投影缓存 → session header」三级回退，冷会话也能拿到 `cordis` 这类实时切换过的模式。
- **只切「刚写下的检查点」**：`settledAt` 超过 30 分钟的会话不再自动切换。之前只要 arm 过，几天前就结算完、活早干完的会话也会被切走——那不是交接，是打扰。30 分钟与交接意图的 TTL 一致。

### 说明

- 「上下文过长 + 活没干完 / 来新活」里的「活没干完」现在由「检查点是刚写的」来近似：检查点是在回合收尾、上下文刚超阈值时写的，随后的切换正好把未完成的工作交给新会话（启动指令会读日志和检查点续上）。
- 老会话后来「来了新活」目前不会自动切（需要把用户的新消息转投到新会话，另做）。

## 1.3.3-beta.3 — 2026-10-26

### 修复

- **「只是打开」的会话永远等不到自动切换**：`handoff.status` 之前只遍历 `agents.list()`（已经加载进进程的 Agent），刚打开、还没跑回合的会话根本不在行里，所以选中检查点会话等 5 秒什么都不会发生。现在行集合来自「绑定 + 持久化会话摘要」，冷会话也能被看到，`cwd` 缺失时用摘要兜底，行里新增 `running`。
- **过期意图不再算作已武装**：交接意图超过 30 分钟就按未武装处理，避免客户端为它开一个最终绑不上智能体的空会话。

### 变更

- **不再要求检查点会话被选中**：客户端每 5 秒检查一次，只要发现某个会话「已结算 + 有效的交接意图 + 没有运行中的回合」，就为它新建会话并切过去（沿用它的工作区与模式，旧会话归档）。任何会话在跑回合时整轮跳过，不会把回答甩在旧会话里。

## 1.3.3-beta.2 — 2026-10-26

### 改进

- **侧栏「智能体对话」对齐工作区列表的视觉规格**：标题行与工作区一致（13px 标签、右侧 28px 图标按钮、悬停用 `--dsw-alias-interactive-bg-hover`）；14px 正文、`--dsw-radius-md` 圆角，去掉彩色头像块与竖引导线，改为与工作区相同的缩进节奏；图标换成内联描边 SVG，不再用文字符号。
- 间距整体放大一档：分区标题行 38px、智能体行 36px、对话行 34px，行间 2px，左右内边距 10px，分区上下留白与视图菜单内边距同步加大。
- 搜索改成工作区同款：标题栏里一个放大镜图标，点开后整行变成输入框（Esc 逐级退出），不再是常驻输入框。

## 1.3.3-beta.1 — 2026-10-26

### 新增

- **侧栏「智能体对话」补齐工具条**，对齐工作区那一侧的操作密度：
  - **搜索**：按智能体名、对话标题或工作区实时过滤，Esc 清空；
  - **视图选项**：排序（最近活动 / 按名称）、显示归档对话、全部收起 / 全部展开，选择记在 localStorage；
  - **添加智能体**：标题右侧「＋」直接打开面板并落在新建表单上（面板未挂载时会记住这次请求）。
- 侧栏折叠时会一并收起搜索框与视图菜单；无匹配时显示空状态。

## 1.3.2 — 2026-10-25

### 修复

- **自动切换从未触发（1.3.0 起的静默失效）**：客户端轮询先看 `/state` 的 `capabilities.arm` 才进入自动切换分支，但 host 的 `/state` 只声明了 `sessions/bound/archive`，`arm` 一直缺失——条件永远为假，插件的 5 秒自动切换整段被跳过，面板上的「续会话」和手写 arm 才是当时唯一的可用路径。现在 `/state` 同时声明 `arm` 与 `startPrompt`，并补了 host 测试防止再次漏掉。
- 连带修复：1.3.1 的「启动指令」因此从未发出；`/state` 声明 `startPrompt` 后，自动切换才会把 `startupPrompt` 写进交棒意图并由 `agent/created` 投递。

### 改进

- **侧栏「智能体对话」重做**：标题行带总数徽标与折叠按钮；每个智能体一行，带展开箭头、首字头像和对话数；对话行改为两行排版（标题 + 工作区），运行中显示圆点、归档显示「只读」标签，子项用左侧引导线归组，列表高度自适应（最高 52vh）。

## 1.3.1 — 2026-10-24

### 新增

- **自动开启新对话后自动发送「启动指令」**：开启「检查点后自动开启新对话」时，新会话继承完绑定、审批策略与模型后，会立刻收到一条启动指令作为第一条消息，智能体不再停在空白的输入框前等用户开口。
- 接力页签新增「启动指令」文本框（保存为 `handoff.json` 的 `startupPrompt`，上限 2000 字）。默认内容引导智能体先读日志/交棒检查点和共享知识库，再继续上次的进度；**留空则只打开新对话、不发送消息**。
- 新主机在 `handoff.status` 里暴露 `capabilities.startPrompt`，旧主机下这个输入框自动隐藏，不会留下一个保存后不生效的入口。

### 实现

- 客户端自动切换前调用 `handoff.arm` 并带 `autoStart: true`，主机把 `startupPrompt` 写进 30 分钟的「下一会话」意图；`agent/created` 消费意图后经 `sessionController.prompt` 投递，`requestId` 按会话固定，重试天然幂等。
- 只有自动切换会带这条指令：手动「续会话」、手动新建会话，以及 `resume` / 子会话都不会自动发消息。

### 修复

- **npm 包漏打包 `archive.js`**：1.2.0 和 1.3.0 的 `package.json` `files` 数组都没有 `archive.js`，而 `index.js` 静态导入它。npm 安装（以及同样按 `files` 打包的 GitHub 安装）得到的目录缺这个文件，Node 加载时直接抛 `ERR_MODULE_NOT_FOUND`，DSH 随即把插件标记为启动失败——记忆工具、知识库、交接/归档 API 全部不出现。1.3.1 已把 `archive.js` 加入 `files`。
- 新增 `test-package.mjs`：从 `exports` 入口沿相对 `import` 链逐个检查文件是否命中 `files` 的通配规则，防止再次漏打包；`pnpm pack` 实测 tarball 已包含 `archive.js`。

### 说明

- 启动指令不包含记忆正文，避免和用户手动载入的记忆重复；它只提示智能体去哪里找上下文。
- 已发布到 npm 的 1.2.0 / 1.3.0 tarball 无法原地修复，只能安装 1.3.1；在 1.3.1 发布前请用源码目录或 `link:` 安装。
- 客户端改动需要刷新页面（或重启应用）后生效。

## 1.3.0 — 2026-10-21

### 新增

- **自动开启新对话**：接力页签新增开关「检查点后自动开启新对话」。当前会话写下检查点、且该回合结束后，客户端自动新建一个会话并切过去——继承源会话的工作区、绑定、审批策略、模型与 Agent preset（模式），旧会话自动归档。
- 触发条件（客户端 5 秒轮询）：检查点会话必须是**当前选中**的会话、已生成检查点且带有交接意图、当前没有运行中的回合；只触发一次，不会在不同会话之间乱跳。
- `handoff.status` 每个会话新增 `workspaceId` 与 `agentPreset`，`handoff.arm` 响应同步带 `agentPreset`，供客户端切换时定位工作区并沿用模式。

### 修复

- 续会话 / 自动切换生成的新会话会丢掉当前模式：原来回落到默认 Agent preset（如 `standard`），现在沿用源会话当前的 preset（如「创造模式」）。preset 读取 `agentPreset` 投影（实时切换后的值），旧 host 回退到 session header。

### 说明

- 自动切换是客户端行为，需要 DSH 页面/面板在运行；关闭页面就不会触发。
- 与手动「续会话」走同一条继承链路，只是把点击省掉了。
- 客户端改动需要刷新页面（或重启应用）后生效。

## 1.2.0 — 2026-10-21

### 包名

- npm 包名改为 **`dsh-agent-vault`**（`dsh-agent-memory` 已被他人占用，无法发布）。Loader 条目 id 仍是 `agent-memory`；仓库目录同步改为 `E:\Projects\dsh-agent-vault`。

### 对话归属

- 绑定智能体的会话从左侧工作区列表隐藏（客户端展示层过滤，不改数据，可关）；搜索仍可命中。
- 侧栏工作区上方新增「智能体对话」区：按智能体分组列出绑定对话，点一条直接打开，可整体/按智能体折叠。
- 智能体面板新增「对话」页签：列出该智能体的对话（工作区、时间、运行状态），可打开、解绑。
- 「对话」页签的工作区下拉**选中即切换**；「新建对话」在所选工作区建会话并自动绑定。
- 「续会话」继承源会话所在的工作区。

### 自动归档

- 交接后（续会话 / 检查点后同目录新建会话接管），旧会话自动转为**归档**：只读、可查看、不能继续。
- 归档会话打开时显示「已归档（只读）」横幅，可直接取消归档。
- **强归档**：DSH 原生归档，侧栏隐藏、面板灰色、不可打开；可转回归档。
- 归档、取消归档、转强/转回，都在「对话」页签里操作；普通对话也可以手动归档。
- 术语说明：此前的「弱归档」在界面上统一叫「归档」，不再出现「弱」字（内部级别名仍是 `weak`）。

### 修复

- `agent.newSession` 不再同时传 `workspaceId` 与 `cwd`（DSH 会拒绝）。
- 归档调用改走 `workspaceRegistry.archiveSession(sessionId, options)`。
- 旧主机（未重启）下按能力开关隐藏新入口，不露出必然报错的按钮。

## 1.2.0-beta.5 — 2026-10-21

### 修复

- **弱归档改为插件层只读**：实测 DSH 原生归档的会话无法再被客户端打开（openSession 退回草稿页），不满足「可以查看」。现在弱归档不再调用 DSH 归档，会话保持可打开；由 `agent/pre-step` 返回 `{ kind: 'reject' }` 来阻止新的回合。
- **强归档保留原生归档**：侧栏隐藏、面板灰色、不可打开；转回弱归档时会真正 unarchive。
- 当前打开的弱归档会话会在底部显示「已归档（只读）」横幅，并带「取消归档」按钮。

## 1.2.0-beta.4 — 2026-10-21

### 修复

- **自动归档没有生效**：归档调用把 `sessionId` 直接传给了 `workspaceController.archiveSession`，但那个 Remote 接收的是请求对象，结果归档成 `'undefined'` 并失败。改用 `workspaceRegistry.archiveSession(sessionId, { stopActivity: true })`（顺手加了空 id 防御）。
- `archive.set` 同样改走 registry，取消归档时才真正 unarchive。

### 变更

- 面板「对话」页签：工作区下拉**选中即切换**（`uiWorkspace.openWorkspace`），不再需要单独的「切换过去」按钮。

## 1.2.0-beta.3 — 2026-10-20

### 新增

- **自动归档（弱归档）**：续会话、或检查点之后在同一目录新建的会话接管工作时，旧会话自动变成**弱归档**——复用 DSH 原生 archive，历史可查看，但不能继续对话（DSH 的 pre-step 门禁会拦截新的回合）。
- **归档级别**：弱归档显示在侧栏「智能体对话」和面板「对话」页签里；**强归档**在侧栏隐藏、在面板里灰色显示。
- **手动切换**：对话页签里，弱归档可以「取消归档」或「转为强归档」；强归档可以「转为弱归档」；普通对话也可以手动归档为弱归档。
- 新增 `archives.json` 记录级别（含 cwd/标题快照，归档后会话摘要不可用时仍能显示归属），以及 `archive.set` 主机操作。

### 说明

- 归档状态是 DSH 的工作区注册表在管；本插件只记录「弱/强」这一呈现级别。
- 「取消归档」会真正从归档集移除，会话恢复可继续对话。

## 1.2.0-beta.2 — 2026-10-20

### 新增

- **侧栏「智能体对话」区**：挂在工作区列表上方，按智能体分组列出已绑定对话（对话名 + 工作区 + 运行点），点一条直接打开；点标题打开智能体面板；可以整体折叠或按智能体折叠。数据来自新的 `bound.list` 主机操作。
- 该区只在主机支持 `bound.list` 时出现（旧进程里不会留下空壳）。

### 修复

- `agent.newSession` 之前同时传 `workspaceId` 和 `cwd`，DSH 会拒绝（`session.create accepts workspaceId or cwd, not both`）；现在只传工作区。

## 1.2.0-beta.1 — 2026-10-20

### 新增

- **绑定的对话不再挤在工作区列表里**：已绑定智能体的会话从左侧工作区列表隐藏，改在智能体面板的「对话」页签里按智能体查找。这是客户端展示层过滤（按会话 id 隐藏行），不改会话数据、不清选择、解除绑定即恢复；设置里可关闭。
- **「对话」页签**：列出该智能体的对话（标题、工作区、最近时间、运行中），可打开、解绑。
- **工作区选择**：在「对话」页签选择工作区，可「切换过去」（打开该工作区）或「新建对话」（在该工作区新建会话并自动绑定该智能体）。
- **续会话继承工作区**：交接时新建的会话落在源会话所在的工作区，而不是最近使用的工作区。

### 说明

- 「隐藏」不写入任何归档状态；搜索结果仍能命中已隐藏的会话。
- 主机新增 `workspace.list` / `agent.sessions` / `agent.newSession` 三个操作，和往常一样需要完整重启 DSH 才生效。

## 1.1.0 — 2026-10-20

首个 1.x 版本。相对 0.9.0：

### 新增

- **接力（交棒检查点）**：上下文压力到阈值时，在该步的系统提示里插入交接提醒；模型写完记忆和日志后，自动生成一条 `kind: "checkpoint"` 的私有日志，可选导出一份 markdown。
- **面板「接力」页签**：开关、token 阈值、提醒间隔（步）、导出目录；实时列出各会话的压力与阶段（观察中 / 已到阈值 / 等待沉淀 / 已生成检查点）。
- **重置**：等待沉淀或已生成检查点的会话可以单独重置阶段，检查点日志保留。
- **续会话**：检查点落盘时记一个 30 分钟内有效的「下一会话」意图；在这个目录里新建的会话会自动绑定同一智能体、继承审批策略与模型。面板对已生成检查点的会话提供「续会话」按钮，一步新建并切过去。
- 面板「日志」页签：查看、追加、删除该智能体的私有日志。
- 讨论室：多房间、成员由用户点选、发言带发言人。

### 测试

`node test-*.mjs` 共 7 套，覆盖 store / host / 数据迁移 / 对话绑定 / 讨论室 / 日志 / 接力。

### 已知限制

- 自动切换会话（不经点击）与旧会话自动归档尚未实现，计划放在下一个版本。
- 主机半边的改动需要完全退出重开 DSH 才生效；客户端半边的改动热更即可。
- 「续会话」继承模型走 DSH 的 `sessionController.selectModel`，它会同时把该选择存成全局默认——这是 DSH 现有行为。

## 0.9.0 及更早

见 npm 上的历史版本。
