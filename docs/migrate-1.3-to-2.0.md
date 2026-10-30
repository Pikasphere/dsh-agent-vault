# 从 1.3.x 升级到 2.0.0

一句话：**只增不改**。记忆、知识库、绑定、讨论室、面板里的东西原地可用；磁盘上唯一会主动动你的是「检查点从日志文件里拆出去」，而这一步是幂等的、可回退的（见 §3）。

## 1. 升级步骤

1. **备份**（30 秒，值得做）：

   ```bash
   cp -r ~/.dsh/agent-memory ~/.dsh/agent-memory.bak-1.3
   ```

   顺带记下 profile 里这个插件是怎么装的（目录 / `link:` / npm），回退时要用。

2. **更新包**。npm 渠道的 `latest` 从 2.0.0 起指向本项目自己的 2.0：

   ```bash
   dsh plugin --profile <你的 profile> add dsh-agent-vault
   ```

   目录安装或 `link:` 安装的，在源码目录 `git pull` 即可（Node 侧没有构建步骤）。

3. **完全退出 DSH 再重开**（托盘图标也要退）。工具注册、提示词段落、面板 bundle 都在启动时装配；只刷新网页拿不到新工具，热加载这类插件还会让工具执行上下文失效。

4. **浏览器 Ctrl+F5**，然后看面板是不是 8 个页签：记忆、回忆、对话、知识库、日志、检查点、接力、设置。

5. 按下表自检。

## 2. 自检清单

| 检查项 | 期望 |
|---|---|
| 工具列表 | 多出 `agent_recall`、`agent_alias` 两个工具 |
| 面板「回忆」 | 「索引」卡片显示笔记/日志条数；「语义索引」卡片显示模型未就绪（**正常**，模型 24 MB 不随 npm 包发布） |
| 面板「日志」 | 只剩笔记；检查点搬到「检查点」页签。两个页签加起来 = 升级前「日志」里的总条数 |
| 面板「检查点」 | 升级前的交棒检查点都在，只读、没有删除按钮 |
| 侧栏「智能体对话」 | 右键对话出现菜单：打开 / 归档 / 转化为强归档 / 取消归档 / 新建对话 |
| 绑定关系 | 各对话的智能体绑定没变（`bindings.json` 没被改写） |

想试语义检索（可选，24 MB 本地模型）。顺序是「先下模型，再建向量」——2.0.0 里 `memory.model` 只有 `status` 与 `prepare` 两个动作，**不会替你下载**；模型缺失时面板的「准备向量」按钮是禁用的，卡片上写着缺什么。

下载脚本在插件的 `scripts/` 里（profile 安装的在 `<profile>/node_modules/dsh-agent-vault/scripts/`；源码安装的在仓库里）。`--dir` 是**模型目录**，默认 `~/.dsh/agent-memory/models/bge-small-zh-v1.5`：

```bash
node scripts/fetch-model.mjs              # 默认目录，逐文件校验 size + sha256，可续传
node scripts/fetch-model.mjs --dir <modelsDir> --force
```

下完重启 DSH（或等面板刷新），再点「准备向量」。任何一步失败都只是降级成纯词法，并在面板显示原因——不会报错，也不会让检索不可用。

## 3. 磁盘上会变什么

```
<memoryDir>/journal/<agentId>.jsonl         ← 首访时被重写：只留笔记
<memoryDir>/checkpoints/<agentId>.jsonl     ← 新增：检查点搬到这里
<memoryDir>/index/state.json                ← 新增：索引构建记录
<memoryDir>/index/aliases.json              ← 新增：别名表（初始 {}）
<memoryDir>/index/vectors.bin|vectors.json  ← 新增：只有建过语义索引才有
<memoryDir>/index/access.json               ← 新增：引用/打开/曝光计数（2.0.0-beta.4 起）
<memoryDir>/models/<model>/                 ← 新增：只有下载过模型才有
<memoryDir>/settings.json                   ← 新增 recall 段
```

### 检查点拆分：怎么发生的

1.3 的 `journal/<agentId>.jsonl` 里，笔记和检查点是同一行格式（`kind: 'note'` / `'checkpoint'`）混着存的。2.0 **首次读取或写入**某个智能体的日志时（`readAll` / `write` 都会触发）：

1. 把 `kind === 'checkpoint'` 的行**追加**到 `checkpoints/<agentId>.jsonl`；
2. 重写 `journal/<agentId>.jsonl`，只留笔记；
3. 之后读日志时两个文件**合并后按 `at` 排序**，所以「日志 + 检查点」两个页签加起来与升级前的总条数一致。

这一步是幂等的：已经拆过的文件再读不会有第二次动作（探测 `raw.includes('"kind":"checkpoint"')`）。风险只有一处——**拆完再用 1.3 读，检查点就不显示了**（不会写坏数据）。

### 回退到 1.3

想退回去，先把检查点并回日志（先备份！）：

```bash
cd ~/.dsh/agent-memory
cat checkpoints/*.jsonl >> journal/<agentId>.jsonl   # 一个智能体一条命令
rm -rf checkpoints
```

合并后的顺序无所谓：1.3 与 2.0 都按 `at` 时间戳排序，而不是文件顺序。`index/` 与 `models/` 可以直接删——前者能重建，后者能重下。

### settings.json

新增 `recall` 段（`mode` / 两个权重 / `minCosine` / `rrfK` / `titleWeight` / `heat` / `dedupe` / `mmr`），缺哪个键就按默认值补齐，**不需要手写迁移脚本**。

注意：插件保存设置时只写它认识的键。1.3 的 `settings.json` 里本来就只有这些键，所以通常无影响；如果你手工加过自定义键，记得另存一份。

## 4. 2.0 相比 1.3.3 多了什么

| 面 | 新增 |
|---|---|
| 工具 | `agent_recall`（按当前智能体检索日志 / 审计日志 / 知识库 / 对话原文）、`agent_alias`（别名增删查） |
| 面板 | 「回忆」页签（检索、展开全文、索引状态、语义索引、排序微调、别名表）、「检查点」页签（只读） |
| 侧栏 | 右键菜单 + Ctrl/⌘ 多选 + Shift 区间选择 |
| 检索 | 词法 + 一跳关联扩展 + 别名 + 本地语义（BGE-small-zh，可选）+ RRF 融合；会话原文入索引（可逐会话排除） |
| 写入 | 相对时间提醒（`time.js`）：正文写「今天/昨天」且没写绝对日期时，工具结果追加一行提醒 |
| 设置 | 上面那组 `recall.*` 键 |

## 5. 已知的破坏面（2.0.0 相对 1.3.3）

- **磁盘**：`journal` 拆分（单向，见 §3）；新增目录不影响旧版本读取。
- **工具列表**：多了两个工具，提示词里的工具清单变化会影响模型的选择方式——这是升级后最容易被察觉的行为差异。
- **依赖**：`onnxruntime-node` 进 `optionalDependencies`（加载失败就降级为词法，不会让插件装不上）。
- **设置键**：不接受未知键（保存时丢弃）。

没有移除任何工具、op 或面板功能；1.3.3 的数据文件 2.0 都能读，2.0 写出的记忆 / 审计日志 / 知识条目 1.3.3 也能读。
