/**
 * Knowledge eval: does the 24 MB local model help on the *shared* knowledge base?
 *
 *   node eval/knowledge-eval.mjs [--dir <memoryDir>] [--agent <agentId>] [--limit 5]
 *
 * The knowledge layer is 25 entries with slug ids and long titles; the keyword
 * path leans on those titles heavily, so the interesting question is whether a
 * person's phrasing (no slug words) lands on the right entry. Same structure as
 * `eval/recall-paraphrase.mjs`: lexical vs hybrid on identical queries, plus a
 * junk probe that measures how high an unrelated query scores, which is what
 * decides the cosine floor.
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = name => import(`file://${path.join(here, '..', name).replace(/\\/g, '/')}`)
const { createStore } = await load('store.js')
const { createJournals } = await load('journal.js')
const { createRecall } = await load('recall.js')
const { KNOWLEDGE_CASES } = await import(`file://${here.replace(/\\/g, '/')}/cases.mjs`)

const argv = process.argv.slice(2)
const flag = name => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? '' : String(argv[at + 1] ?? '')
}
const memoryDir = flag('dir') || process.env.AGENT_MEMORY_DIR || path.join(os.homedir(), '.dsh', 'agent-memory')
const agentId = flag('agent') || 'demo-agent'
const limit = Number(flag('limit') || 5)

const store = createStore({ rootDir: memoryDir })
const journals = createJournals({ rootDir: memoryDir })
const recall = createRecall({ rootDir: memoryDir, store, journals })

await recall.search({ id: agentId, query: '预热', source: 'knowledge', mode: 'hybrid' })

async function measure(mode) {
  const started = Date.now()
  const ranks = []
  const rows = []
  for (const [query, expected] of KNOWLEDGE_CASES) {
    const hits = await recall.search({ id: agentId, query, source: 'knowledge', limit, mode })
    const ids = hits.results.map(item => item.id)
    const rank = ids.indexOf(expected) + 1
    ranks.push(rank)
    rows.push({ query, expected, rank, ids, results: hits.results })
  }
  const ms = (Date.now() - started) / KNOWLEDGE_CASES.length
  return { mode, rows, ms, ...score(ranks) }
}

function score(ranks) {
  const n = ranks.length
  const top1 = ranks.filter(rank => rank === 1).length / n
  const top3 = ranks.filter(rank => rank > 0 && rank <= 3).length / n
  const mrr = ranks.reduce((sum, rank) => sum + (rank > 0 ? 1 / rank : 0), 0) / n
  return { n, top1, top3, mrr }
}

const pct = value => `${(value * 100).toFixed(1)}%`
const lexical = await measure('lexical')
const hybrid = await measure('hybrid')

console.log(`knowledge eval — ${memoryDir}`)
console.log(`agent ${agentId}, ${KNOWLEDGE_CASES.length} queries, limit ${limit}\n`)
for (const report of [lexical, hybrid]) {
  console.log(
    `${report.mode.padEnd(8)} top-1 ${pct(report.top1).padStart(6)}  top-3 ${pct(report.top3).padStart(6)}  ` +
      `MRR ${report.mrr.toFixed(3)}  ${report.ms.toFixed(0)} ms/query`,
  )
}

let moved = 0
let fixed = 0
for (let index = 0; index < lexical.rows.length; index += 1) {
  const left = lexical.rows[index]
  const right = hybrid.rows[index]
  if (left.rank === right.rank) continue
  moved += 1
  const before = left.rank > 0 ? left.rank : 'miss'
  const after = right.rank > 0 ? right.rank : 'miss'
  if (left.rank !== 1 && right.rank === 1) fixed += 1
  console.log(`  rank ${String(before).padStart(4)} → ${String(after).padEnd(4)}  «${right.query}»  ${right.expected}`)
}
console.log(`\nmoved: ${moved}/${lexical.rows.length}, moved to rank 1: ${fixed}`)

const broken = hybrid.rows.filter(row => row.rank === 0).map(row => row.query)
if (broken.length > 0) console.log(`\nstill missing (hybrid): ${broken.map(q => `«${q}»`).join(', ')}`)

// Junk probe: unrelated questions with the floor disabled. The highest cosine
// here is the value a floor must stay above, or every unrelated query returns
// knowledge entries.
const JUNK = ['今天天气怎么样', '红烧肉怎么做', '明天的股票会涨吗', '一首轻音乐推荐', '怎么练好书法', '火车票什么时候放票']
let peak = 0
let peakEntry = ''
for (const query of JUNK) {
  const hits = await recall.search({ id: agentId, query, source: 'knowledge', mode: 'hybrid', minCosine: 0, limit: 20 })
  for (const hit of hits.results) {
    const cosine = Number(hit.why?.cosine ?? 0)
    if (cosine > peak) {
      peak = cosine
      peakEntry = `${hit.id} «${hit.title}»`
    }
  }
}
console.log(`\njunk probe: max cosine ${peak.toFixed(3)} (${peakEntry || 'none'})`)
if (peak > 0) console.log(`floor must stay above that; current floor decides whether these leak in`)

// The native ORT session keeps the event loop alive on some runs; exit
// explicitly so a finished eval does not hang the shell.
process.exit(0)
