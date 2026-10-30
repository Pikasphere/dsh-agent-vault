/**
 * How often does the top-3 of one query contain two notes that say the same
 * thing? This is the measurement the dedupe step (recall.dedupe) is supposed to
 * fix, so it has to be taken *before* the fix and reported honestly — if the
 * rate is already low, shipping a reorder pass buys nothing.
 *
 *   node eval/dupe-rate.mjs [--dir <memoryDir>] [--agent <agentId>] [--threshold 0.75]
 *
 * Similarity is Jaccard over `tokenize(title + preview)`, the same cheap proxy
 * the dedupe pass uses; it is deliberately not cosine, because the pass has to
 * work for rows that have no vector (knowledge, session hits).
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = name => import(`file://${path.join(here, '..', name).replace(/\\/g, '/')}`)
const { createStore } = await load('store.js')
const { createJournals } = await load('journal.js')
const { createRecall } = await load('recall.js')
const { tokenize } = await load('rank.js')

const argv = process.argv.slice(2)
const flag = name => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? '' : String(argv[at + 1] ?? '')
}
const memoryDir = flag('dir') || process.env.AGENT_MEMORY_DIR || path.join(os.homedir(), '.dsh', 'agent-memory')
const agentId = flag('agent') || 'demo-agent'
const threshold = Number(flag('threshold')) || 0.75
const top = Number(flag('top')) || 3

const store = createStore({ rootDir: memoryDir })
const journals = createJournals({ rootDir: store.root })
// access: false — a measurement run must not read or write the live heat counters,
// otherwise the second eval reports different numbers than the first.
const recall = createRecall({ rootDir: store.root, store, journals, access: false })

const { LEXICAL_CASES, PARAPHRASE_CASES } = await load('eval/cases.mjs')

function bag(row) {
  return new Set(tokenize(`${row.title ?? ''} ${row.preview ?? ''}`))
}

function similarity(left, right) {
  const a = bag(left)
  const b = bag(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / (a.size + b.size - shared)
}

async function measure(label, cases, mode) {
  let dirty = 0
  let pairs = 0
  const examples = []
  for (const [query] of cases) {
    const hits = await recall.search({ id: agentId, query, source: 'journal', limit: top, mode })
    const rows = hits.results
    let worst = 0
    let worstPair = null
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const value = similarity(rows[i], rows[j])
        pairs += 1
        if (value > worst) {
          worst = value
          worstPair = [rows[i].id, rows[j].id]
        }
      }
    }
    if (worst >= threshold) {
      dirty += 1
      if (examples.length < 6) examples.push({ query, worst: worst.toFixed(2), worstPair, titles: rows.map(row => row.title) })
    }
  }
  return { label, mode, total: cases.length, dirty, pairs, examples }
}

const results = []
for (const [label, cases] of [['词汇族', LEXICAL_CASES], ['改写族', PARAPHRASE_CASES]]) {
  for (const mode of ['lexical', 'hybrid']) {
    results.push(await measure(label, cases, mode))
  }
}

for (const item of results) {
  const rate = item.total === 0 ? 0 : (item.dirty / item.total) * 100
  console.log(`${item.label} · ${item.mode}：${item.dirty}/${item.total} 条查询的 top-${top} 内有 ≥${threshold} 的近似重复（${rate.toFixed(1)}%），比较了 ${item.pairs} 对`)
  for (const example of item.examples) {
    console.log(`  · ${example.query} → ${example.worst} ${example.worstPair?.join(' ~ ')}`)
  }
}
console.log('')
const worst = results.reduce((left, right) => (right.dirty / Math.max(1, right.total) > left.dirty / Math.max(1, left.total) ? right : left))
console.log(`最严重的组合：${worst.label} · ${worst.mode} → ${((worst.dirty / Math.max(1, worst.total)) * 100).toFixed(1)}%`)
process.exit(0)
