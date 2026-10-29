/**
 * Parameter sweep for the lexical/semantic fusion, plus the policy that picks
 * the values.
 *
 * The fusion constants (0.6/0.4, RRF k=20, cosine floor 0.45) were hand-picked
 * in alpha.8: one tuned query set, no harness to search with. This script runs
 * the grid and reports what the data says. It also refuses to tune the cosine
 * floor purely by recall, because that floor has a job the query set cannot see.
 *
 * Method, and what each column is allowed to claim:
 *
 * - `lexical` family measured in **hybrid** mode. That is production: the
 *   keyword baseline must survive the semantic layer being on.
 * - `paraphrase` family measured in **hybrid** mode; the only place a semantic
 *   parameter may move a number.
 * - a cheap third check reruns the lexical family in `lexical` mode across the
 *   grid and asserts the ranking is identical: parameters must not leak into
 *   the keyword path.
 * - the cosine floor is chosen against a **separation probe**: six off-topic
 *   queries ("tell me a joke") with the floor at 0, recording the highest
 *   cosine in the corpus. A floor below that admits junk on every unrelated
 *   query, whatever the paraphrase MRR says.
 *
 *   node eval/recall-grid.mjs [--dir <memoryDir>] [--agent <agentId>] [--quick]
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = name => import(`file://${path.join(here, '..', name).replace(/\\/g, '/')}`)
const { createStore } = await load('store.js')
const { createJournals } = await load('journal.js')
const { createRecall } = await load('recall.js')
const { LEXICAL_CASES, PARAPHRASE_CASES } = await load('eval/cases.mjs')

const argv = process.argv.slice(2)
const flag = name => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? '' : String(argv[at + 1] ?? '')
}
const memoryDir = flag('dir') || process.env.AGENT_MEMORY_DIR || path.join(os.homedir(), '.dsh', 'agent-memory')
const agentId = flag('agent') || 'demo-agent'
const quick = argv.includes('--quick')

const store = createStore({ rootDir: memoryDir })
const journals = createJournals({ rootDir: store.root })
const recall = createRecall({ rootDir: store.root, store, journals })

const loaded = await recall.prepare()
if (!loaded.ok) {
  console.log(`semantic layer unavailable: ${loaded.error}`)
  console.log('grid needs the embeddings; run `node scripts/fetch-model.mjs` first.')
  process.exit(1)
}
console.log(`model ${loaded.model} dim ${loaded.dim}, ${loaded.count} vectors, synced\n`)

const WEIGHTS = quick
  ? [[0.6, 0.4], [0.7, 0.3], [0.5, 0.5]]
  : [[0.4, 0.6], [0.5, 0.5], [0.6, 0.4], [0.7, 0.3], [0.8, 0.2]]
const KS = quick ? [10, 20, 40] : [5, 10, 20, 40, 60]
const COSINES = quick ? [0.40, 0.45, 0.50] : [0.30, 0.35, 0.40, 0.45, 0.50, 0.60]
const LIMIT = 5

/** Queries with no correct answer in the corpus: whatever they match is junk. */
const OFF_TOPIC = ['今天天气怎么样', '给我讲个笑话', '晚饭吃什么好', '汇率怎么算', '明天股市开盘吗', '推荐一部电影']

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
const pct = value => `${value.toFixed(1)}%`

async function measure(cases, options) {
  let top1 = 0
  let top3 = 0
  let mrr = 0
  const ranks = []
  for (const [query, expected] of cases) {
    const hits = await recall.search({ id: agentId, query, source: 'journal', limit: LIMIT, expand: 0, ...options })
    const rank = hits.results.findIndex(item => item.id === expected) + 1
    ranks.push(rank === 0 ? Number.POSITIVE_INFINITY : rank)
    top1 += rank === 1 ? 1 : 0
    top3 += rank >= 1 && rank <= 3 ? 1 : 0
    mrr += rank === 0 ? 0 : 1 / rank
  }
  return { ranks, top1: (top1 / cases.length) * 100, top3: (top3 / cases.length) * 100, mrr: mrr / cases.length }
}

const row = (label, result) =>
  `${label.padEnd(34)} top-1 ${pct(result.top1).padStart(6)}  top-3 ${pct(result.top3).padStart(6)}  MRR ${result.mrr.toFixed(3)}`

const baselineLex = await measure(LEXICAL_CASES, { mode: 'lexical' })
const defaultLex = await measure(LEXICAL_CASES, { mode: 'hybrid' })
const defaultPara = await measure(PARAPHRASE_CASES, { mode: 'hybrid' })

console.log(`sweep: ${LEXICAL_CASES.length} lexical + ${PARAPHRASE_CASES.length} paraphrase, agent ${agentId}, source journal\n`)
console.log('## reference')
console.log(row('lexical family, mode=lexical', baselineLex))
console.log(row('lexical family, mode=hybrid (default)', defaultLex))
console.log(row('paraphrase family, mode=hybrid (default)', defaultPara))
console.log('')

const results = []
const combos = WEIGHTS.length * KS.length * COSINES.length
let done = 0
for (const [lexicalWeight, semanticWeight] of WEIGHTS) {
  for (const rrfK of KS) {
    for (const minCosine of COSINES) {
      const options = { mode: 'hybrid', weights: { lexicalWeight, semanticWeight }, rrfK, minCosine }
      const lex = await measure(LEXICAL_CASES, options)
      const para = await measure(PARAPHRASE_CASES, options)
      results.push({ lexicalWeight, semanticWeight, rrfK, minCosine, lex, para })
      done += 1
      if (done % 10 === 0 || done === combos) process.stdout.write(`\r  swept ${done}/${combos}`)
    }
  }
}
process.stdout.write('\n\n')

const eligible = results.filter(
  item => item.lex.top1 >= baselineLex.top1 && item.lex.mrr >= baselineLex.mrr - 0.02,
)
const byPara = [...eligible].sort((a, b) => b.para.mrr - a.para.mrr || a.minCosine - b.minCosine)

console.log(`## best by paraphrase MRR (${eligible.length}/${results.length} combos keep lexical top-1 ≥ ${pct(baselineLex.top1)})`)
for (const item of byPara.slice(0, 6)) {
  const tag = `w=${item.lexicalWeight}/${item.semanticWeight} k=${item.rrfK} cos=${item.minCosine}`
  console.log(`${tag.padEnd(34)} para top-1 ${pct(item.para.top1).padStart(6)} MRR ${item.para.mrr.toFixed(3)}   lex top-1 ${pct(item.lex.top1).padStart(6)}`)
}

console.log('\n## axis sensitivity (mean paraphrase MRR)')
function axis(label, values, pick) {
  for (const value of values) {
    const subset = results.filter(item => pick(item) === value)
    const meanMrr = mean(subset.map(item => item.para.mrr))
    const best = Math.max(...subset.map(item => item.para.mrr))
    console.log(`  ${label}=${String(value).padEnd(6)} mean MRR ${meanMrr.toFixed(3)}  best ${best.toFixed(3)}  (${subset.length} combos)`)
  }
}
axis('cos', COSINES, item => item.minCosine)
axis('k', KS, item => item.rrfK)
axis('w', WEIGHTS.map(weights => weights.join('/')), item => `${item.lexicalWeight}/${item.semanticWeight}`)

/** Parameters must not leak into the keyword path: rankings must be identical. */
const signatures = new Set()
for (const item of results.slice(0, 25)) {
  const run = await measure(LEXICAL_CASES, { mode: 'lexical', rrfK: item.rrfK, minCosine: item.minCosine })
  signatures.add(run.ranks.join(','))
}
console.log('\n## lexical-path invariance')
console.log(signatures.size === 1 ? '  ok: every combo produced the same lexical ranking' : `  FAIL: ${signatures.size} distinct rankings`)

/**
 * Separation probe: junk level. This is why the floor cannot be picked by MRR
 * alone — the paraphrase set only contains queries that *have* an answer.
 */
const junk = []
for (const query of OFF_TOPIC) {
  const hits = await recall.search({ id: agentId, query, source: 'journal', limit: LIMIT, expand: 0, mode: 'hybrid', minCosine: 0 })
  junk.push(hits.results[0]?.why?.cosine ?? 0)
}
const junkMax = Math.max(...junk)
console.log('\n## separation probe (off-topic cosine)')
console.log(`  max ${junkMax.toFixed(3)}  median ${mean([...junk].sort((a, b) => a - b)).toFixed(3)}`)
console.log(`  floors that admit junk: ${COSINES.filter(value => value <= junkMax).join(', ') || 'none'}`)

/**
 * Policy, in order:
 * 1. weights: argmax of mean paraphrase MRR (tie → heavier lexical, the channel
 *    that is trustworthy everywhere).
 * 2. k: RRF's k only shifts how fast reward decays with rank; keep 20 unless
 *    the axis shows a spread of more than 0.02 MRR (i.e. real evidence).
 * 3. cosine floor: best paraphrase MRR among the floors strictly above the
 *    junk level. No extra margin constant: the grid step is already the
 *    cushion, and an invented margin only makes the answer flip when a
 *    six-query probe sample moves by 0.002.
 */
const weightAxis = WEIGHTS.map(weights => {
  const subset = results.filter(item => item.lexicalWeight === weights[0] && item.semanticWeight === weights[1])
  return { weights, meanMrr: mean(subset.map(item => item.para.mrr)) }
}).sort((a, b) => b.meanMrr - a.meanMrr || b.weights[0] - a.weights[0])
const chosenWeights = weightAxis[0].weights

const kAxis = KS.map(k => ({ k, meanMrr: mean(results.filter(item => item.rrfK === k).map(item => item.para.mrr)) }))
const kSpread = Math.max(...kAxis.map(item => item.meanMrr)) - Math.min(...kAxis.map(item => item.meanMrr))
const chosenK = kSpread < 0.02 ? 20 : [...kAxis].sort((a, b) => b.meanMrr - a.meanMrr)[0].k

const safeFloors = COSINES.filter(value => value > junkMax)
const chosenCos = [...safeFloors]
  .map(value => ({
    value,
    mrr: mean(
      results
        .filter(item => item.minCosine === value && item.lexicalWeight === chosenWeights[0] && item.semanticWeight === chosenWeights[1] && item.rrfK === chosenK)
        .map(item => item.para.mrr),
    ),
  }))
  .sort((a, b) => b.mrr - a.mrr || b.value - a.value)[0]?.value

console.log('\n## policy')
console.log(`  weights: ${weightAxis.map(item => `${item.weights.join('/')}=${item.meanMrr.toFixed(3)}`).join('  ')}`)
console.log(`  k: axis spread ${kSpread.toFixed(3)} → ${kSpread < 0.02 ? 'no evidence to move, keep 20' : `move to ${chosenK}`}`)
console.log(`  cosine floor: safe set ${safeFloors.join(', ')} → ${chosenCos}`)

const finalOptions = {
  mode: 'hybrid',
  weights: { lexicalWeight: chosenWeights[0], semanticWeight: chosenWeights[1] },
  rrfK: chosenK,
  minCosine: chosenCos,
}
const finalLex = await measure(LEXICAL_CASES, finalOptions)
const finalPara = await measure(PARAPHRASE_CASES, finalOptions)
console.log('\n## chosen configuration')
console.log(row('lexical family, mode=hybrid', finalLex))
console.log(row('paraphrase family, mode=hybrid', finalPara))
console.log(`  vs defaults: paraphrase MRR ${defaultPara.mrr.toFixed(3)} → ${finalPara.mrr.toFixed(3)}, top-1 ${pct(defaultPara.top1)} → ${pct(finalPara.top1)}`)

const unsolved = PARAPHRASE_CASES.filter(([, expect], index) => finalPara.ranks[index] !== 1)
console.log(`\n## paraphrase cases still not rank 1 (${unsolved.length}/${PARAPHRASE_CASES.length})`)
for (const [query, expect] of unsolved) console.log(`  ${query.padEnd(20)} ${expect}`)

console.log('\n## recommended (paste into settings.json → recall)')
console.log(JSON.stringify(finalOptions.mode === 'hybrid' ? { mode: 'hybrid', lexicalWeight: chosenWeights[0], semanticWeight: chosenWeights[1], minCosine: chosenCos, rrfK: chosenK } : {}, null, 2))
