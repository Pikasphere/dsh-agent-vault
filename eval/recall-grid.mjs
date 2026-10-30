/**
 * Parameter sweep for the lexical/semantic fusion, plus the policy that picks
 * the values.
 *
 * The fusion constants (0.6/0.4, RRF k=20, cosine floor) were hand-picked in
 * alpha.8: one tuned query set, no harness to search with. alpha.11 ran a full
 * cross product over them, which was both slow and methodologically wrong:
 * picking the argmax of point estimates over 15 queries reported noise as
 * signal. alpha.12 fixes both:
 *
 * - **Sequential axes instead of a cross product.** Each axis is measured at the
 *   current choice, one axis at a time (weights, then k, then floor). That is
 *   what "tuning" was always doing by hand; running it as a script makes it
 *   reproducible, and it needs 16 configurations instead of 150.
 * - **Paired bootstrap instead of a margin.** A value only moves off its default
 *   when the difference against the default, resampled **by note** (the queries
 *   are 1-3 phrasings of the same notes), has a 95 % interval that excludes
 *   zero. Otherwise the default stays, however good another point estimate
 *   looks. "No evidence to move" is a result.
 *
 * Method, and what each column is allowed to claim:
 *
 * - `lexical` family measured in **hybrid** mode. That is production: the
 *   keyword baseline must survive the semantic layer being on.
 * - `paraphrase` family measured in **hybrid** mode; the only place a semantic
 *   parameter may move a number.
 * - a third check reruns the lexical family in `lexical` mode across the axis
 *   values and asserts the ranking is identical: parameters must not leak into
 *   the keyword path.
 * - the cosine floor is additionally bounded by a **separation probe**: six
 *   off-topic queries ("tell me a joke") with the floor at 0, recording the
 *   highest cosine in the corpus. A floor below that admits junk on every
 *   unrelated query, whatever the paraphrase MRR says.
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
console.log(`model ${loaded.model} dim ${loaded.dim}, ${loaded.count} vectors, synced`)
console.log(
  `${LEXICAL_CASES.length} lexical + ${PARAPHRASE_CASES.length} paraphrase queries over ` +
    `${new Set(PARAPHRASE_CASES.map(item => item[1])).size} notes (agent ${agentId}, source journal)`,
)
console.log('')

const DEFAULT_WEIGHTS = [0.6, 0.4]
const DEFAULT_K = 20
const DEFAULT_COS = 0.45

const WEIGHTS = quick
  ? [[0.6, 0.4], [0.7, 0.3], [0.5, 0.5]]
  : [[0.4, 0.6], [0.5, 0.5], [0.6, 0.4], [0.7, 0.3], [0.8, 0.2]]
const KS = quick ? [10, 20, 40] : [5, 10, 20, 40, 60]
const COSINES = quick ? [0.4, 0.45, 0.5] : [0.3, 0.35, 0.4, 0.45, 0.5, 0.6]
const LIMIT = 5

/** Queries with no correct answer in the corpus: whatever they match is junk. */
const OFF_TOPIC = ['今天天气怎么样', '给我讲个笑话', '晚饭吃什么好', '汇率怎么算', '明天股市开盘吗', '推荐一部电影']

const pct = value => `${value.toFixed(1)}%`

/**
 * Statistics. A point estimate over a few dozen queries is not a measurement of
 * a parameter: the 95 % interval on MRR with 45 cases is roughly +/-0.06, so a
 * difference of 0.01-0.03 between two parameter sets is indistinguishable from
 * noise. Resampling is therefore **by note**, not by query: the queries are 1-3
 * phrasings of the same notes, and treating them as independent cases would
 * understate the interval. Seeded, so two runs print the same numbers.
 */
const BOOT = 4000
const makeRandom = seed => {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 4294967296
  }
}

function clusterBootstrap(values, clusters, seed = 0x9e3779b9) {
  const rnd = makeRandom(seed ^ values.length)
  const cells = new Map()
  values.forEach((value, index) => {
    const key = clusters[index]
    if (!cells.has(key)) cells.set(key, [])
    cells.get(key).push(value)
  })
  const units = [...cells.values()]
  const draws = []
  for (let round = 0; round < BOOT; round += 1) {
    let sum = 0
    let count = 0
    for (let pick = 0; pick < units.length; pick += 1) {
      const cell = units[Math.floor(rnd() * units.length)]
      for (const value of cell) sum += value
      count += cell.length
    }
    draws.push(sum / count)
  }
  draws.sort((a, b) => a - b)
  return { lo: draws[Math.floor(0.025 * BOOT)], hi: draws[Math.floor(0.975 * BOOT)] }
}

const fade = ({ lo, hi }) => `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`

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
  return {
    ranks,
    rr: ranks.map(rank => (rank === 0 ? 0 : 1 / rank)),
    top1: (top1 / cases.length) * 100,
    top3: (top3 / cases.length) * 100,
    mrr: mrr / cases.length,
  }
}

const row = (label, result) =>
  `${label.padEnd(32)} top-1 ${pct(result.top1).padStart(6)}  top-3 ${pct(result.top3).padStart(6)}  MRR ${result.mrr.toFixed(3)}`

const PARA_CLUSTERS = PARAPHRASE_CASES.map(item => item[1])
const LEX_CLUSTERS = LEXICAL_CASES.map(item => item[1])
const top1Of = result => result.rr.map(value => (value === 1 ? 1 : 0))

const optionsOf = ({ weights = DEFAULT_WEIGHTS, rrfK = DEFAULT_K, minCosine = DEFAULT_COS }) => ({
  mode: 'hybrid',
  weights: { lexicalWeight: weights[0], semanticWeight: weights[1] },
  rrfK,
  minCosine,
})

const baselineLex = await measure(LEXICAL_CASES, { mode: 'lexical' })
const startedAt = Date.now()
const defaultRun = {
  lex: await measure(LEXICAL_CASES, optionsOf({})),
  para: await measure(PARAPHRASE_CASES, optionsOf({})),
}

console.log(`## reference (${Date.now() - startedAt} ms)`)
console.log(row('lexical family, mode=lexical', baselineLex))
console.log(row('lexical family, mode=hybrid (default)', defaultRun.lex))
console.log(row('paraphrase family, mode=hybrid', defaultRun.para))
console.log(
  `  paraphrase MRR ${defaultRun.para.mrr.toFixed(3)} ${fade(clusterBootstrap(defaultRun.para.rr, PARA_CLUSTERS))}  ` +
    `top-1 ${pct(defaultRun.para.top1)}`,
)

/**
 * Sequentially: weights at the default k and floor, then k at the chosen
 * weights, then the floor at the chosen weights and k. One axis moves at a time,
 * and only when the paired interval against the default says so.
 */
async function chooseAxis({ title, candidates, reference, labelOf }) {
  console.log('')
  console.log(`## ${title} (paired against default, resampled by note)`)
  let winner = null
  for (const candidate of candidates) {
    const started = Date.now()
    const lex = await measure(LEXICAL_CASES, optionsOf(candidate))
    const para = await measure(PARAPHRASE_CASES, optionsOf(candidate))
    const elapsed = Date.now() - started
    const diffs = para.rr.map((value, index) => value - reference.para.rr[index])
    const band = clusterBootstrap(diffs, PARA_CLUSTERS)
    const covers = band.lo <= 0 && band.hi >= 0
    const delta = para.mrr - reference.para.mrr
    console.log(
      `  ${labelOf(candidate).padEnd(12)} MRR ${para.mrr.toFixed(3)} [${band.lo.toFixed(3)}, ${band.hi.toFixed(3)}]  ` +
        `delta ${(delta >= 0 ? '+' : '') + delta.toFixed(3)}  ` +
        (covers ? 'not distinguishable from 0' : band.lo > 0 ? 'better' : 'worse') +
        `  ${elapsed} ms`,
    )
    if (!covers && band.lo > 0 && (!winner || band.lo > winner.band.lo)) winner = { candidate, band, label: labelOf(candidate) }
    if (lex.top1 < baselineLex.top1) console.log(`    WARNING: lexical top-1 dropped to ${pct(lex.top1)}`)
  }
  return winner
}

const weightCandidates = WEIGHTS.filter(weights => weights[0] !== DEFAULT_WEIGHTS[0] || weights[1] !== DEFAULT_WEIGHTS[1])
const weightWinner = await chooseAxis({
  title: 'weights',
  candidates: weightCandidates.map(weights => ({ weights })),
  reference: defaultRun,
  labelOf: candidate => `w=${candidate.weights.join('/')}`,
})
const chosenWeights = weightWinner ? weightWinner.candidate.weights : DEFAULT_WEIGHTS
console.log(`  -> ${weightWinner ? `move to ${weightWinner.label}` : `keep ${DEFAULT_WEIGHTS.join('/')}`}`)

const kWinner = await chooseAxis({
  title: 'RRF k',
  candidates: KS.filter(rrfK => rrfK !== DEFAULT_K).map(rrfK => ({ weights: chosenWeights, rrfK })),
  reference: defaultRun,
  labelOf: candidate => `k=${candidate.rrfK}`,
})
const chosenK = kWinner ? kWinner.candidate.rrfK : DEFAULT_K
console.log(`  -> ${kWinner ? `move to ${kWinner.label}` : `keep k=${DEFAULT_K}`}`)

/**
 * Separation probe before the floor test: the floor is not a free parameter.
 * Junk above the probe level is a bug whatever the query set says.
 */
const junk = []
for (const query of OFF_TOPIC) {
  const hits = await recall.search({ id: agentId, query, source: 'journal', limit: LIMIT, expand: 0, mode: 'hybrid', minCosine: 0 })
  junk.push(hits.results[0]?.why?.cosine ?? 0)
}
const junkMax = Math.max(...junk)
const junkMedian = [...junk].sort((a, b) => a - b)[Math.floor(junk.length / 2)]
console.log('')
console.log('## separation probe (off-topic cosine, floor at 0)')
console.log(
  `  max ${junkMax.toFixed(3)}  median ${junkMedian.toFixed(3)}  -> floors that admit junk: ` +
    `${COSINES.filter(value => value <= junkMax).join(', ') || 'none'}`,
)

const floorCandidates = COSINES.filter(value => value > junkMax && value !== DEFAULT_COS)
const cosWinner = await chooseAxis({
  title: 'cosine floor',
  candidates: floorCandidates.map(minCosine => ({ weights: chosenWeights, rrfK: chosenK, minCosine })),
  reference: defaultRun,
  labelOf: candidate => `cos=${candidate.minCosine}`,
})
const chosenCos = cosWinner ? cosWinner.candidate.minCosine : DEFAULT_COS
console.log(
  `  -> ${cosWinner ? `move to ${cosWinner.label}` : `keep cos=${DEFAULT_COS}`}  (safe set ${COSINES.filter(value => value > junkMax).join(', ')})`,
)

const finalLex = await measure(LEXICAL_CASES, optionsOf({ weights: chosenWeights, rrfK: chosenK, minCosine: chosenCos }))
const finalPara = await measure(PARAPHRASE_CASES, optionsOf({ weights: chosenWeights, rrfK: chosenK, minCosine: chosenCos }))

console.log('')
console.log('## chosen configuration')
console.log(row('lexical family, mode=hybrid', finalLex))
console.log(row('paraphrase family, mode=hybrid', finalPara))
console.log(
  `  paraphrase MRR ${finalPara.mrr.toFixed(3)} ${fade(clusterBootstrap(finalPara.rr, PARA_CLUSTERS))}  ` +
    `top-1 ${pct(finalPara.top1)}`,
)

/** Parameters must not leak into the keyword path: rankings must be identical. */
const signatures = new Set()
for (const rrfK of KS) {
  const probe = await measure(LEXICAL_CASES, { mode: 'lexical', rrfK })
  signatures.add(probe.ranks.join(','))
}
console.log('')
console.log('## lexical-path invariance')
console.log(signatures.size === 1 ? '  ok: the keyword ranking is identical across k values' : `  FAIL: ${signatures.size} distinct rankings`)

const unsolved = PARAPHRASE_CASES.filter(([, expect], index) => finalPara.ranks[index] !== 1)
console.log('')
console.log(`## paraphrase cases still not rank 1 (${unsolved.length}/${PARAPHRASE_CASES.length})`)
for (const [query, expect] of unsolved) console.log(`  ${query.padEnd(22)} ${expect}`)

/**
 * How big a difference could this set even see? Half the 95 % interval on the
 * reference MRR is the honest answer, and it is the number to quote when someone
 * asks whether a change helped.
 */
const referenceBand = clusterBootstrap(defaultRun.para.rr, PARA_CLUSTERS)
const top1Band = clusterBootstrap(top1Of(defaultRun.para), PARA_CLUSTERS)
console.log('')
console.log('## sensitivity of this set')
console.log(
  `  ${PARAPHRASE_CASES.length} queries over ${new Set(PARA_CLUSTERS).size} notes -> ` +
    `anything smaller than +/-${((referenceBand.hi - referenceBand.lo) / 2).toFixed(3)} MRR is not measurable here`,
)
console.log(
  `  top-1 ${PARAPHRASE_CASES.length - unsolved.length}/${PARAPHRASE_CASES.length} = ${pct(defaultRun.para.top1)}, ` +
    `95 % interval ${pct(top1Band.lo * 100)} .. ${pct(top1Band.hi * 100)}`,
)

console.log('')
console.log('## recommended (paste into settings.json -> recall)')
console.log(JSON.stringify({ mode: 'hybrid', lexicalWeight: chosenWeights[0], semanticWeight: chosenWeights[1], minCosine: chosenCos, rrfK: chosenK }, null, 2))
