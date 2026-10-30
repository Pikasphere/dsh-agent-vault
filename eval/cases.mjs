/**
 * Labelled queries for the recall evals. One file, because three scripts read
 * them and a query that exists in only one of them is how baselines drift.
 *
 * Labels are entry ids from the author's own journal (agent `demo-agent`) as of
 * 2026-10-29. They are a snapshot: a deleted note invalidates its query, and
 * that is expected — re-label after the note goes away.
 *
 * Two families, on purpose:
 *
 * - `lexical` — the query shares vocabulary with the note it is about. This is
 *   the keyword baseline: `mode:"lexical"` must keep scoring 92.9 % top-1 here,
 *   and no parameter change is allowed to move it.
 * - `paraphrase` — the query shares (almost) no token with the note it is
 *   about: a person describing the thing in their own words. This is the set
 *   the semantic layer has to earn its 24 MB on; `recall-grid.mjs` refuses to
 *   count a case whose overlap is too high, because such a case measures the
 *   keyword path while pretending to measure semantics.
 */

export const LEXICAL_CASES = [
  ['弱归档打不开会话', 'j-mvhmznvxht'],
  ['为什么包名要改', 'j-mvhpevfwfj'],
  ['改名之后启动崩溃', 'j-mvi09989v2'],
  ['自动切换的三个 bug', 'j-mvp2s6bs8i'],
  ['preset 还是 standard', 'j-mvp1rnqbnc'],
  ['续会话 自动绑定', 'j-mvgtec7g9w'],
  ['模型继承实测', 'j-mvgu47yxa6'],
  ['Qwen 文本编码器 Xet', 'j-mvqa3oslon'],
  ['hf-mirror 续传 9B', 'j-mvqmackkpk'],
  ['num_ctx 65536 凭据', 'j-mvqmnzkuyw'],
  ['6144 窗口 8192', 'j-mvqmvhhf9x'],
  ['mmproj 视觉', 'j-mvqqd0f3pt'],
  ['侧栏 DOM 注入', 'j-mvgv0njbvu'],
  ['工作区选中即切换', 'j-mvhmoxlset'],
]

export const PARAPHRASE_CASES = [
  ['会话怎么被收起来', 'j-mvgva9bdbd'],
  ['两个会话之间怎么接上', 'j-mvgqxcdas7'],
  ['装大模型踩了什么坑', 'j-mvqmackkpk'],
  ['改完名字就打不开', 'j-mvi09989v2'],
  ['侧栏那块是自己画的吗', 'j-mvgv0njbvu'],
  ['下载卡住不动', 'j-mvqa3oslon'],
  ['上下文怎么这么短', 'j-mvqmvhhf9x'],
  ['这个对话算谁的', 'j-mvgumrcv76'],
  ['点开归档的对话是空白', 'j-mvhmznvxht'],
  // added 2026-10-29 for the parameter sweep
  ['接手的人从哪读起', 'j-mvgsum3yow'],
  ['把整个界面推倒重来按哪里', 'j-mvgt465qut'],
  ['换到新对话还记得刚才的安排吗', 'j-mvgt7pwseu'],
  ['把难听的字眼从界面上拿掉', 'j-mvhnyi2v9p'],
  ['给模型加个看图的附件', 'j-mvqqd0f3pt'],
  ['它自己换了窗口却没人知道', 'j-mvp1eh79qd'],
  // added 2026-10-29 (second batch): n was 15, which puts the 95 % interval on
  // a 13 % top-1 somewhere around [2 %, 40 %] — wide enough that a 0.02 MRR
  // difference between two parameter sets is indistinguishable from noise.
  // One to three queries per note, covering all 28 notes; ambiguity is allowed
  // but marked: a query with two plausible answers caps every strategy at 2,
  // which is honest hardness, not a measurement bug.
  ['一句话交代不完时怎么把话传下去', 'j-mvgqxcdas7'],
  ['写给后来者的一份现状说明', 'j-mvgsum3yow'],
  ['第一次亲眼看到界面时做的检查', 'j-mvgt465qut'],
  ['把方案推倒重写第二版的起因', 'j-mvgt465qut'],
  ['按一下就能接着上次说', 'j-mvgt7pwseu'],
  ['真的关掉再打开看它自己做对没有', 'j-mvgtec7g9w'],
  ['把上次用的那个选择沿用下来', 'j-mvgtzwnuqo'],
  ['发版前先把最要紧的一项做完', 'j-mvgtzwnuqo'],
  ['实测它确实照抄了上次的选择', 'j-mvgu47yxa6'],
  ['对话全堆在一个地方太乱', 'j-mvgumrcv76'],
  ['转手的时候把环境一起带过去', 'j-mvgumrcv76'],
  ['原生位置加不进去只好自己画一块', 'j-mvgv0njbvu'],
  ['旧对话自动收进抽屉但还能翻', 'j-mvgva9bdbd'],
  ['收起来和彻底藏起来是两档', 'j-mvgva9bdbd'],
  ['一个参数传错整件事没反应', 'j-mvhmoxlset'],
  ['收起来的对话点开是空白', 'j-mvhmznvxht'],
  ['链接断了要重新接一遍', 'j-mvhpm9ce8h'],
  ['一启动就自己退出', 'j-mvi09989v2'],
  ['几个启动失败日志说的是什么', 'j-mvi09989v2'],
  ['照着别人的仓库重新装一份', 'j-mvnyyuucjh'],
  ['提示让它换它却始终不动', 'j-mvp1eh79qd'],
  ['新开的这段启动配置不对', 'j-mvp1rnqbnc'],
  ['一个文件传到一半不走了', 'j-mvqa3oslon'],
  ['断了从上次的地方接着下', 'j-mvqmackkpk'],
  ['把它挂到本机的模型服务上', 'j-mvqmackkpk'],
  ['一天干完五件事的流水账', 'j-mvqmhhdda9'],
  ['没有钥匙却被放行', 'j-mvqmnzkuyw'],
  ['只装一半的知识范围', 'j-mvqmnzkuyw'],
  ['它以为我只能装那么多', 'j-mvqmvhhf9x'],
  ['多装一个配件就能读图', 'j-mvqqd0f3pt'],
]

/**
 * Cases that turned out to be answerable by the keyword path alone: the target
 * is already rank 1 with `mode:"lexical"` (checked by `eval/check-cases.mjs`), so
 * they cannot show any semantic lift and would only dilute the mean. Kept here
 * as a record — a future re-labelling can restore them if the notes change.
 */
export const DROPPED_CASES = [
  // added 2026-10-29 (third batch): the second batch's queries that the keyword
  // path already ranks first, found by `check-cases.mjs`. Same reason as above.
  ['接力的机制最早是怎么接进来的', 'j-mvgqxcdas7'],
  ['下一段继承上一段的进度', 'j-mvgt7pwseu'],
  ['按谁在管分类显示对话', 'j-mvgumrcv76'],
  ['选中一个就偷偷切过去', 'j-mvhmoxlset'],
  ['第四次重开才验完的清单', 'j-mvhnm0z1i3'],
  ['正式版最后一天改了哪些字', 'j-mvhnyi2v9p'],
  ['起名字前把候选一个个查过', 'j-mvhpevfwfj'],
  ['别人先占了同样的名字', 'j-mvhpevfwfj'],
  ['把文件夹也换个名字', 'j-mvhpm9ce8h'],
  ['聊太长了自己开一段新的', 'j-mvi17n28da'],
  ['没有网络也要能从头验一遍', 'j-mvnyyuucjh'],
  ['三个毛病叠在一起', 'j-mvp2s6bs8i'],
  ['包名被别人占了', 'j-mvhpevfwfj'],
  ['换了对话模型还认得吗', 'j-mvgu47yxa6'],
  ['工作区一选就换过去了', 'j-mvhmoxlset'],
  ['发布时漏了文件别人装不上', 'j-mvnyyuucjh'],
  ['凭据明明没配却也能发请求', 'j-mvqmnzkuyw'],
  ['工具用到一半全报同一个错', 'j-mvp1rnqbnc'],
]

/** Both families in one place, for scripts that do not care which is which. */
export const ALL_CASES = { lexical: LEXICAL_CASES, paraphrase: PARAPHRASE_CASES }
