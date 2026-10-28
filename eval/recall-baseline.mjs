/**
 * Lexical baseline for recall (M1 acceptance): hand-labelled queries against a
 * real, private corpus.
 *
 * Run it against a memory directory that contains the corpus:
 *
 *   node eval/recall-baseline.mjs [--dir <memoryDir>] [--agent <agentId>]
 *
 * The labels are entry ids from the author's own journal (demo-agent) as of
 * 2026-10-28. They are a *snapshot*: a note that gets deleted invalidates its
 * query, and that is expected — rerun after re-labelling. The point of the
 * number is to have something to compare `expand:1` against once the graph
 * layer lands in 2.0.0-alpha.3 (docs/memory-recall-v2.md §6.4).
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = name => import(`file://${path.join(here, '..', name).replace(/\\/g, '/')}`)
const { createStore } = await load('store.js')
const { createJournals } = await load('journal.js')
const { createRecall } = await load('recall.js')

const argv = process.argv.slice(2)
const flag = name => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? '' : String(argv[at + 1] ?? '')
}
const memoryDir = flag('dir') || process.env.AGENT_MEMORY_DIR || path.join(os.homedir(), '.dsh', 'agent-memory')
const agentId = flag('agent') || 'demo-agent'

const store = createStore({ rootDir: memoryDir })
const journals = createJournals({ rootDir: store.root })
const recall = createRecall({ rootDir: store.root, store, journals })

/** query → the entry that a human would call the right answer. */
const CASES = [
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

let top1 = 0
let top3 = 0
let mrr = 0
const rows = []
for (const [query, expected] of CASES) {
  const hits = recall.search({ id: agentId, query, source: 'journal', limit: 5 })
  const rank = hits.results.findIndex(item => item.id === expected) + 1
  top1 += rank === 1 ? 1 : 0
  top3 += rank >= 1 && rank <= 3 ? 1 : 0
  mrr += rank === 0 ? 0 : 1 / rank
  rows.push({ query, rank, expected, got: hits.results[0]?.id ?? '-' })
}
rows.forEach(row =>
  console.log(`${row.rank === 1 ? '✓' : row.rank === 0 ? '✗' : '~'} ${row.query.padEnd(24)} rank=${row.rank} → ${row.got}`),
)
console.log(
  `\njournal baseline (${CASES.length} queries, agent ${agentId}): top-1 ${(top1 / CASES.length * 100).toFixed(1)}%  ` +
    `top-3 ${(top3 / CASES.length * 100).toFixed(1)}%  MRR ${(mrr / CASES.length).toFixed(3)}`,
)
