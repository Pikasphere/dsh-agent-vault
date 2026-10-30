/**
 * Title-vs-body diagnostic: does a note's title carry a *better* signal than
 * its body?
 *
 * The lexical path already weights the title (6 points vs 1 per body hit, see
 * `rank.js`). The semantic path does not: alpha.13 only repeats the title at the
 * head of every chunk, so a title match competes with body chunks at equal
 * weight. Adding "title weighting" is only worth code if titles are actually
 * closer to the queries — otherwise it just doubles the same text and lifts the
 * off-topic similarity floor.
 *
 * This script answers three questions without touching production code:
 *   1. for the note a query is about, is cosine(query, title) > cosine(query, body)?
 *   2. does ranking notes by title alone beat ranking them by body chunks?
 *   3. does folding a title row into the chunk score (a few coefficients) move
 *      top-1 / MRR, i.e. is there anything to gain at all?
 *
 *   node eval/title-vs-body.mjs [--dir <memoryDir>] [--agent <agentId>] [--limit <n>]
 *
 * Pure semantics here (no lexical, no RRF): the question is about the vector
 * space, and mixing the keyword path in would blur which side moved.
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { pairedInterval, fade, pct, clusterBootstrap } from './stats.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = name => import(`file://${path.join(here, '..', name).replace(/\\/g, '/')}`)
const { createStore } = await load('store.js')
const { createJournals } = await load('journal.js')
const { createEmbedder, cosine } = await load('embed.js')
const { chunksOf, CHUNK_CHARS } = await load('vectors.js')
const { PARAPHRASE_CASES, LEXICAL_CASES } = await import('./cases.mjs')

const argv = process.argv.slice(2)
const flag = name => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? '' : String(argv[at + 1] ?? '')
}
const memoryDir = flag('dir') || process.env.AGENT_MEMORY_DIR || path.join(os.homedir(), '.dsh', 'agent-memory')
const agentId = flag('agent') || 'demo-agent'

const store = createStore({ rootDir: memoryDir })
const journals = createJournals({ rootDir: store.root })
const notes = journals.notes(agentId).filter(note => String(note.text ?? '').trim() !== '')
if (notes.length === 0) {
  console.error(`没有笔记：${agentId} @ ${memoryDir}`)
  process.exit(1)
}

const embedder = createEmbedder({ modelDir: path.join(store.root, 'models', 'bge-small-zh-v1.5') })
await embedder.load()
console.error(`载入 ${notes.length} 条笔记，维度 ${embedder.dim}`)

// One vector per title, one per chunk. Titles are document-side text; the query
// prefix belongs on the query only, hence `embed` for one and `embedOne` for
// the other.
const titleVectors = await embedder.embed(notes.map(note => String(note.title ?? '').trim()))
const chunkVectors = []
for (const note of notes) {
  const pieces = chunksOf(note, CHUNK_CHARS)
  chunkVectors.push(await embedder.embed(pieces))
}

const bestBody = (index, query) => {
  let best = Number.NEGATIVE_INFINITY
  for (const vector of chunkVectors[index]) {
    const value = cosine(query, vector)
    if (value > best) best = value
  }
  return best
}

const variants = [
  ['A 仅正文分块', (index, body) => body[index]],
  ['B 并入标题 ×1.00', (index, body, title) => Math.max(body[index], title[index])],
  ['C 并入标题 ×1.15', (index, body, title) => Math.max(body[index], Math.min(1, title[index] * 1.15))],
  ['D 仅标题', (index, body, title) => title[index]],
  ['E 加权和 0.85/0.15', (index, body, title) => 0.85 * Math.max(0, body[index]) + 0.15 * Math.max(0, title[index])],
]

async function run(cases, label) {
  const rows = []
  for (const [query, target] of cases) {
    const index = notes.findIndex(note => String(note.id) === String(target))
    if (index === -1) continue
    const queryVector = await embedder.embedOne(query)
    // Per-note scores for this query, once — the variants are then pure
    // reshuffles of these two columns, which keeps them comparable.
    const body = notes.map((_, i) => bestBody(i, queryVector))
    const title = notes.map((_, i) => cosine(queryVector, titleVectors[i]))
    const columns = variants.map(([, score]) => notes.map((_, i) => score(i, body, title)))
    const ranks = columns.map(values => {
      const order = notes.map((_, i) => i).sort((a, b) => values[b] - values[a])
      return order.indexOf(index) + 1
    })
    rows.push({ query, titleCos: title[index], bodyCos: body[index], ranks })
  }
  if (rows.length === 0) {
    console.log(`${label}: 没有可用的用例`)
    return
  }
  const rr = rows.map(row => row.ranks.map(rank => 1 / rank))
  const top1 = rows.map(row => row.ranks.map(rank => (rank === 1 ? 1 : 0)))
  const top3 = rows.map(row => row.ranks.map(rank => (rank <= 3 ? 1 : 0)))
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
  const clusters = rows.map(row => row.query)

  console.log(`\n## ${label}（${rows.length} 条）`)
  console.log('\n| 变体 | top-1 | top-3 | MRR | ΔMRR vs A |')
  console.log('|---|---|---|---|---|')
  const baseline = rr.map(pair => pair[0])
  variants.forEach(([name], k) => {
    const column = rr.map(pair => pair[k])
    const delta = k === 0 ? '参考' : `${(mean(column) - mean(baseline) >= 0 ? '+' : '') + (mean(column) - mean(baseline)).toFixed(3)} ${fade(pairedInterval(baseline, column, clusters).band)}`
    console.log(`| ${name} | ${pct(mean(top1.map(pair => pair[k])) * 100)} | ${pct(mean(top3.map(pair => pair[k])) * 100)} | ${mean(column).toFixed(3)} | ${delta} |`)
  })

  // The diagnostic proper: same note, two texts.
  const deltas = rows.map(row => row.titleCos - row.bodyCos)
  const better = deltas.filter(value => value > 0).length
  const band = clusterBootstrap(deltas, clusters)
  const meanDelta = mean(deltas)
  console.log(`\n标题 vs 正文（同一条目标笔记）：标题余弦均值 ${mean(rows.map(r => r.titleCos)).toFixed(3)}、正文 ${mean(rows.map(r => r.bodyCos)).toFixed(3)}，差值 ${meanDelta >= 0 ? '+' : ''}${meanDelta.toFixed(3)} ${fade(band)}；${better}/${rows.length} 条标题更高。`)
  const sorted = [...rows].sort((a, b) => b.titleCos - b.bodyCos - (a.titleCos - a.bodyCos))
  console.log('\n标题优势最大的三条：')
  for (const row of sorted.slice(0, 3)) {
    console.log(`- 「${row.query}」标题 ${row.titleCos.toFixed(3)} / 正文 ${row.bodyCos.toFixed(3)}（${(row.titleCos - row.bodyCos >= 0 ? '+' : '') + (row.titleCos - row.bodyCos).toFixed(3)}）`)
  }
  console.log('\n标题劣势最大的三条：')
  for (const row of sorted.slice(-3)) {
    console.log(`- 「${row.query}」标题 ${row.titleCos.toFixed(3)} / 正文 ${row.bodyCos.toFixed(3)}（${(row.titleCos - row.bodyCos >= 0 ? '+' : '') + (row.titleCos - row.bodyCos).toFixed(3)}）`)
  }
}

await run(LEXICAL_CASES, '词法族（对照，应当被标题主导）')
await run(PARAPHRASE_CASES, '改写族（语义真正要赢的那一族）')

// The native ORT session keeps the event loop alive on some runs; exit
// explicitly so a finished eval does not hang the shell.
process.exit(0)
