/**
 * Baseline for recall: hand-labelled queries against a real, private corpus,
 * measured twice — `expand:0` (pure lexical, the M1 numbers) and `expand:1`
 * (one graph hop + aliases, the M2.5 numbers). Both run `mode:lexical`: this is
 * the keyword baseline, so the semantic layer must not be able to move it.
 * The point of the pair is that
 * expansion must not cost top-1 accuracy; if it does, the graph is noise.
 *
 *   node eval/recall-baseline.mjs [--dir <memoryDir>] [--agent <agentId>]
 *
 * The labels are entry ids from the author's own journal (demo-agent) as of
 * 2026-10-28. They are a *snapshot*: a note that gets deleted invalidates its
 * query, and that is expected — rerun after re-labelling.
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
// access: false — a measurement run must not read or write the live heat counters,
// otherwise the second eval reports different numbers than the first.
const recall = createRecall({ rootDir: store.root, store, journals, access: false })

/** Labels live in `eval/cases.mjs`: three scripts read the same list. */
const { LEXICAL_CASES: CASES } = await load('eval/cases.mjs')

async function measure(expand, limit = 5) {
  let top1 = 0
  let top3 = 0
  let mrr = 0
  const rows = []
  for (const [query, expected] of CASES) {
    const hits = await recall.search({ id: agentId, query, source: 'journal', limit, expand, mode: 'lexical' })
    const rank = hits.results.findIndex(item => item.id === expected) + 1
    const extras = hits.results.filter(item => item.via !== 'lexical')
    top1 += rank === 1 ? 1 : 0
    top3 += rank >= 1 && rank <= 3 ? 1 : 0
    mrr += rank === 0 ? 0 : 1 / rank
    rows.push({ query, rank, expected, got: hits.results[0]?.id ?? '-', extras })
  }
  return {
    rows,
    top1: (top1 / CASES.length) * 100,
    top3: (top3 / CASES.length) * 100,
    mrr: mrr / CASES.length,
  }
}

const lexical = await measure(0)
const graph = await measure(1)

const line = result =>
  `top-1 ${result.top1.toFixed(1)}%  top-3 ${result.top3.toFixed(1)}%  MRR ${result.mrr.toFixed(3)}`
console.log(`journal baseline (${CASES.length} queries, agent ${agentId}, source journal)\n`)
console.log(`expand:0  ${line(lexical)}`)
console.log(`expand:1  ${line(graph)}`)

const regressions = lexical.rows
  .map((row, index) => ({ before: row.rank, after: graph.rows[index].rank, query: row.query }))
  .filter(row => row.after !== row.before)
console.log(`\nrank changes: ${regressions.length === 0 ? 'none' : ''}`)
for (const row of regressions) console.log(`  ${row.query}: ${row.before || 'miss'} → ${row.after || 'miss'}`)

const extras = graph.rows.reduce((sum, row) => sum + row.extras.length, 0)
const noisy = graph.rows.filter(row => row.extras.length > 2)
console.log(`\nextras pulled in: ${extras} over ${CASES.length} queries`)
for (const row of graph.rows) {
  if (row.extras.length === 0) continue
  const labels = row.extras.map(item => `${item.id}/${item.via}`).join(', ')
  console.log(`  ${row.query.padEnd(22)} +${row.extras.length}: ${labels}`)
}
if (noisy.length > 0) {
  console.log(`\nsuspect (more than two unrelated neighbours): ${noisy.map(row => row.query).join(', ')}`)
}

// The native ORT session keeps the event loop alive on some runs; exit
// explicitly so a finished eval does not hang the shell.
process.exit(0)
