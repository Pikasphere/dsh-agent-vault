/**
 * Paraphrase eval: queries a person actually types — no literal token from the
 * note they mean — run in `mode:lexical` and `mode:hybrid`. The point of the
 * pair is that semantics has to earn its 24 MB: if hybrid does not beat lexical
 * by a wide margin here, the local model is not worth shipping.
 *
 *   node eval/recall-paraphrase.mjs [--dir <memoryDir>] [--agent <agentId>] [--mode lexical|hybrid|both]
 *
 * Labels are entry ids from the author's own journal (demo-agent) as of
 * 2026-10-29; a deleted note invalidates its query, which is expected.
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
const only = ['lexical', 'hybrid'].includes(flag('mode')) ? flag('mode') : 'both'
const titleWeight = flag('title-weight') === '' ? null : Number(flag('title-weight'))

const store = createStore({ rootDir: memoryDir })
const journals = createJournals({ rootDir: store.root })
// access: false — a measurement run must not read or write the live heat counters,
// otherwise the second eval reports different numbers than the first.
const recall = createRecall({ rootDir: store.root, store, journals, access: false })

/**
 * Labels live in `eval/cases.mjs`. Cases the keyword path already answers are
 * excluded there (`DROPPED_CASES`), so this set is only the ones where
 * semantics has a chance to matter.
 */
const { PARAPHRASE_CASES: CASES } = await load('eval/cases.mjs')

async function measure(mode, limit = 5) {
  let top1 = 0
  let top3 = 0
  let mrr = 0
  let ms = 0
  const rows = []
  for (const [query, expected] of CASES) {
    const started = Date.now()
    const hits = await recall.search({ id: agentId, query, source: 'journal', limit, mode, ...(titleWeight === null ? {} : { titleWeight }) })
    ms += Date.now() - started
    const rank = hits.results.findIndex(item => item.id === expected) + 1
    const semantic = hits.results.filter(item => item.via === 'semantic')
    top1 += rank === 1 ? 1 : 0
    top3 += rank >= 1 && rank <= 3 ? 1 : 0
    mrr += rank === 0 ? 0 : 1 / rank
    rows.push({ query, rank, expected, got: hits.results[0]?.id ?? '-', semantic })
  }
  return {
    rows,
    mode,
    latency: ms / CASES.length,
    top1: (top1 / CASES.length) * 100,
    top3: (top3 / CASES.length) * 100,
    mrr: mrr / CASES.length,
  }
}

const summary = await recall.state().semantic
console.log(`paraphrase eval (${CASES.length} queries, agent ${agentId}, source journal)`)
console.log(`model: ${summary.present ? `${summary.model} · ${summary.dim}d · ${summary.count} vectors` : 'not built yet'}\n`)

// Warm the model and the vector store first: the plugin pre-warms at startup, so
// charging a cold build to the first timed query would misreport real latency.
await recall.search({ id: agentId, query: '预热', mode: 'hybrid' })

const lexical = only === 'hybrid' ? null : await measure('lexical')
const hybrid = only === 'lexical' ? null : await measure('hybrid')

const line = result => `top-1 ${result.top1.toFixed(1)}%  top-3 ${result.top3.toFixed(1)}%  MRR ${result.mrr.toFixed(3)}  ${result.latency.toFixed(0)} ms/query`
if (lexical) console.log(`lexical  ${line(lexical)}`)
if (hybrid) console.log(`hybrid   ${line(hybrid)}${titleWeight === null ? '' : `  (titleWeight ${titleWeight})`}`)

if (lexical && hybrid) {
  console.log(`\ndelta    top-1 ${(hybrid.top1 - lexical.top1).toFixed(1)} pt, MRR ${(hybrid.mrr - lexical.mrr).toFixed(3)}`)
  const changes = lexical.rows
    .map((row, index) => ({ query: row.query, before: row.rank, after: hybrid.rows[index].rank }))
    .filter(row => row.after !== row.before)
  console.log(`\nrank changes: ${changes.length === 0 ? 'none' : ''}`)
  for (const row of changes) console.log(`  ${row.query}: ${row.before || 'miss'} → ${row.after || 'miss'}`)
  const semanticRows = hybrid.rows.reduce((sum, row) => sum + row.semantic.length, 0)
  console.log(`\nsemantic-only hits shown: ${semanticRows}`)
  for (const row of hybrid.rows) {
    if (row.semantic.length === 0) continue
    console.log(`  ${row.query.padEnd(16)} +${row.semantic.map(item => item.id).join(', ')}`)
  }
}

if (hybrid && summary.present === false && only !== 'lexical') {
  console.log('\nnote: no vectors on disk — hybrid ran as lexical. Build them with `memory.reindex`.')
}

// The native ORT session keeps the event loop alive on some runs; exit
// explicitly so a finished eval does not hang the shell.
process.exit(0)
