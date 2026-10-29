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
]

/**
 * Cases that turned out to be answerable by the keyword path alone: the target
 * is already rank 1 with `mode:"lexical"` (checked by `eval/check-cases.mjs`), so
 * they cannot show any semantic lift and would only dilute the mean. Kept here
 * as a record — a future re-labelling can restore them if the notes change.
 */
export const DROPPED_CASES = [
  ['包名被别人占了', 'j-mvhpevfwfj'],
  ['换了对话模型还认得吗', 'j-mvgu47yxa6'],
  ['工作区一选就换过去了', 'j-mvhmoxlset'],
  ['发布时漏了文件别人装不上', 'j-mvnyyuucjh'],
  ['凭据明明没配却也能发请求', 'j-mvqmnzkuyw'],
  ['工具用到一半全报同一个错', 'j-mvp1rnqbnc'],
]

/** Both families in one place, for scripts that do not care which is which. */
export const ALL_CASES = { lexical: LEXICAL_CASES, paraphrase: PARAPHRASE_CASES }
