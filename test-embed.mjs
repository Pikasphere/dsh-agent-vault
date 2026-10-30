/** Local embedding: tokenizer, vector store freshness, and hybrid ranking. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = name => import(`file://${path.join(here, name).replace(/\\/g, '/')}`)
const { basicTokenize, wordPiece, createEmbedder, cosine, QUERY_PREFIX } = await load('embed.js')
const { createVectors, hashText, chunksOf, CHUNK_CHARS } = await load('vectors.js')
const { createStore } = await load('store.js')
const { createJournals } = await load('journal.js')
const { createRecall, RECALL_DEFAULTS } = await load('recall.js')

/** A tiny vocabulary: enough to exercise the greedy ##-matching, no model needed. */
const vocab = new Map([
  ['[PAD]', 0], ['[UNK]', 1], ['[CLS]', 2], ['[SEP]', 3],
  ['hello', 4], ['world', 5], ['##s', 6], ['##ing', 7], ['##ed', 8],
])
const ids = text => {
  const out = [vocab.get('[CLS]')]
  for (const word of basicTokenize(text)) out.push(...(wordPiece(word, vocab) ?? [vocab.get('[UNK]')]))
  out.push(vocab.get('[SEP]'))
  return out
}

// ── tokenizer ───────────────────────────────────────────────────────────────
assert.deepEqual(basicTokenize('你好 world foo-bar'), ['你', '好', 'world', 'foo', '-', 'bar'])
assert.deepEqual(basicTokenize('  hello\nworld  '), ['hello', 'world'])
assert.deepEqual(basicTokenize('HTTPServer'), ['HTTPServer'], 'case is preserved (do_lower_case=false)')
assert.deepEqual(wordPiece('hello', vocab), [4])
assert.deepEqual(wordPiece('hellos', vocab), [4, 6], '##s extends a known prefix')
assert.equal(wordPiece('nowhere', vocab), null, 'unknown word reports null')
assert.deepEqual(ids('hello worlds'), [2, 4, 5, 6, 3], 'greedy longest match, then ##-continuation')
assert.deepEqual(ids('hello nowhere'), [2, 4, 1, 3], 'unmatched word becomes [UNK]')
assert.ok(ids('x'.repeat(4000)).length <= 512, 'input is truncated to the model limit')

// ── a deterministic stand-in embedder (no model, no native dependency) ─────
const DIM = 8
const AXES = [
  [/归档|存档|archive/, 0],
  [/鲸鱼|whale|桌宠/, 1],
  [/别名|alias/, 2],
]
function vectorFor(text) {
  const out = new Float32Array(DIM)
  let hit = false
  for (const [pattern, axis] of AXES) {
    if (pattern.test(text)) {
      out[axis] = 1
      hit = true
    }
  }
  out[7] = hit ? 0.15 : 1
  let sum = 0
  for (const value of out) sum += value * value
  const norm = Math.sqrt(sum) || 1
  for (let i = 0; i < DIM; i += 1) out[i] /= norm
  return out
}
const fakeEmbedder = {
  modelPath: '/fake/onnx/model_quantized.onnx',
  dim: DIM,
  embed: async texts => texts.map(vectorFor),
  embedOne: async text => vectorFor(String(text).startsWith(QUERY_PREFIX) ? String(text).slice(QUERY_PREFIX.length) : text),
}

// ── vector store ────────────────────────────────────────────────────────────
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-embed-'))
const store = createStore({ rootDir: path.join(scratch, 'mem'), knowledgeDir: path.join(scratch, 'kb') })
const journals = createJournals({ rootDir: store.root })
const agent = store.createAgent({ name: 'Embed' })
const vectors = createVectors({ rootDir: store.root, embedder: fakeEmbedder, model: 'fake' })

const first = journals.write({ id: agent.id, title: '归档动作', text: '右键把会话收进归档' })
const second = journals.write({ id: agent.id, title: '桌宠', text: '小鲸鱼的泡泡在动' })
const entries = () => journals.notes(agent.id).map(row => ({
  id: row.id, src: 'journal', at: String(row.at), title: String(row.title), text: String(row.text), tags: [],
}))

let built = await vectors.sync(entries())
assert.equal(built.count, 2)
assert.equal(built.embedded, 2)
assert.ok(fs.existsSync(path.join(store.root, 'index', 'vectors.bin')), 'vectors.bin written')
const meta = JSON.parse(fs.readFileSync(path.join(store.root, 'index', 'vectors.json'), 'utf8'))
assert.equal(meta.dim, DIM)
assert.equal(meta.entries.length, 2)
// Rows are sorted by entry key, so look the note up instead of indexing the file.
const archiveRow = meta.entries.find(entry => entry.key === `journal:${first.id}`)
assert.ok(archiveRow, 'the archive note has a row')
assert.equal(archiveRow.hash, hashText(["归档动作","右键把会话收进归档"].join(String.fromCharCode(10))))
assert.equal(archiveRow.chunk, 0, 'a short note is a single chunk')

built = await vectors.sync(entries())
assert.equal(built.embedded, 0, 'unchanged text is not re-embedded')

journals.write({ id: agent.id, title: '桌宠声音', text: '小鲸鱼的泡泡在动，还加了声音' })
built = await vectors.sync(entries())
assert.equal(built.count, 3)
assert.equal(built.embedded, 1, 'only the new entry is embedded')

journals.remove({ id: agent.id, entry: first.id })
journals.remove({ id: agent.id, entry: second.id })
built = await vectors.sync(entries())
assert.equal(built.count, 1, 'deleted entries leave the vector store')
assert.equal(built.dropped, 2)

// ── hybrid ranking: semantics finds what keywords cannot ───────────────────
const recall = createRecall({ rootDir: store.root, store, journals, embedder: fakeEmbedder })
// Only journal notes and memory-log lines are embedded: knowledge stays lexical.
const archiveNote = journals.write({ id: agent.id, title: '归档入口', text: '会话可以从右键菜单收进归档' })

const lexical = await recall.search({ id: agent.id, query: '存档了没', mode: 'lexical' })
assert.equal(lexical.results.length, 0, 'no keyword overlap in lexical mode')

const hybrid = await recall.search({ id: agent.id, query: '存档了没', mode: 'hybrid' })
assert.ok(hybrid.results.length >= 1, 'semantic mode finds the archive note')
assert.equal(hybrid.mode, 'hybrid')
const semanticRow = hybrid.results.find(row => row.via === 'semantic')
assert.ok(semanticRow, 'a row only semantics found reports via=semantic')
assert.equal(semanticRow.id, archiveNote.id)
assert.ok(Number.isFinite(semanticRow.why.cosine), 'why.cosine is reported')
assert.ok(semanticRow.why.cosine >= RECALL_DEFAULTS.minCosine)
assert.ok(semanticRow.score > 0 && semanticRow.score <= 1)

// The cosine floor keeps unrelated rows out even when they clear the dot product.
const below = await recall.search({ id: agent.id, query: '完全不相关的一句话', mode: 'hybrid' })
assert.equal(below.results.filter(row => row.via === 'semantic').length, 0, 'minCosine filters noise')

// mode is orthogonal to expand: lexical + expand still skips semantics.
const lexicalGraph = await recall.search({ id: agent.id, query: '鲸鱼', mode: 'lexical', expand: 1 })
assert.ok(lexicalGraph.results.every(row => row.via !== 'semantic'))

// ── fusion is rank-based, not score-based ──────────────────────────────────
// The regression this guards: with score fusion the top lexical hit normalises
// to 0.6, so even a perfect cosine (max 0.4 after the prior) cannot overtake it
// once the lexical share drops below a third — which is how the paraphrase eval
// stalled at top-1 33 %. Here the noise note repeats the query token four times
// (lexical rank 1, semantic ~0) while the answer note matches once but is the
// semantic match (cosine 1.0). RRF must rank the answer first.
const fuseScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-fuse-'))
const fuseStore = createStore({ rootDir: path.join(fuseScratch, 'mem'), knowledgeDir: path.join(fuseScratch, 'kb') })
const fuseJournals = createJournals({ rootDir: fuseStore.root })
const fuseAgent = fuseStore.createAgent({ name: 'Fuse' })
const noiseNote = fuseJournals.write({ id: fuseAgent.id, title: 'lexical noise', text: 'AAA AAA AAA AAA' })
const answerNote = fuseJournals.write({ id: fuseAgent.id, title: 'semantic answer', text: 'BBB' })
const VECTORS = { 'lexical noise\nAAA AAA AAA AAA': [0, 1], 'semantic answer\nBBB': [1, 0] }
const stubEmbedder = {
  modelPath: '/stub/onnx/model_quantized.onnx',
  dim: 2,
  embed: async texts => texts.map(text => Float32Array.from(VECTORS[text] ?? [0.5, 0.5])),
  embedOne: async () => Float32Array.from([1, 0]),
}
const fuseRecall = createRecall({ rootDir: fuseStore.root, store: fuseStore, journals: fuseJournals, embedder: stubEmbedder })
const fusion = await fuseRecall.search({ id: fuseAgent.id, query: 'AAA BBB', mode: 'hybrid', minCosine: 0.2 })
assert.equal(fusion.results[0].id, answerNote.id, `RRF puts the semantic answer first (got ${fusion.results[0].id})`)
assert.equal(fusion.results[0].via, 'lexical', 'a row both channels found keeps its lexical identity')
assert.ok(fusion.results[0].why?.cosine >= 0.9, 'why.cosine still travels with a fused row')
assert.ok(fusion.results.find(row => row.id === noiseNote.id), 'the lexical-only row stays in the list')
fs.rmSync(fuseScratch, { recursive: true, force: true })

// ── one global vector file, shared by every agent ──────────────────────────
// Regression: syncing only the querying agent's rows made two agents invalidate
// each other, re-embedding the whole log layer on every other query.
const multiScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-multi-'))
const multiStore = createStore({ rootDir: path.join(multiScratch, 'mem'), knowledgeDir: path.join(multiScratch, 'kb') })
const multiJournals = createJournals({ rootDir: multiStore.root })
const multiFirst = multiStore.createAgent({ name: 'First' })
const multiSecond = multiStore.createAgent({ name: 'Second' })
multiJournals.write({ id: multiFirst.id, title: '归档一', text: '右键收进归档' })
multiJournals.write({ id: multiFirst.id, title: '归档二', text: '取消归档' })
multiJournals.write({ id: multiSecond.id, title: '鲸鱼一', text: '桌宠的泡泡' })
multiJournals.write({ id: multiSecond.id, title: '鲸鱼二', text: '小鲸鱼表情' })
let embeddedDocs = 0
const counting = {
  modelPath: '/stub/onnx/model_quantized.onnx',
  dim: DIM,
  embed: async texts => {
    embeddedDocs += texts.length
    return texts.map(vectorFor)
  },
  embedOne: async text => vectorFor(String(text).startsWith(QUERY_PREFIX) ? String(text).slice(QUERY_PREFIX.length) : text),
}
const multi = createRecall({ rootDir: multiStore.root, store: multiStore, journals: multiJournals, embedder: counting })
await multi.search({ id: multiFirst.id, query: '归档', mode: 'hybrid' })
assert.equal(multi.state().semantic.count, 4, 'the store holds both agents rows')
const afterFirst = embeddedDocs
await multi.search({ id: multiSecond.id, query: '鲸鱼', mode: 'hybrid' })
assert.equal(multi.state().semantic.count, 4, 'switching agents keeps both agents rows')
assert.equal(embeddedDocs, afterFirst, 'the other agent does not trigger a re-embed')
await multi.search({ id: multiFirst.id, query: '归档', mode: 'hybrid' })
assert.equal(embeddedDocs, afterFirst, 'switching back does not re-embed either')
fs.rmSync(multiScratch, { recursive: true, force: true })

// ── graceful degradation ───────────────────────────────────────────────────
const noModel = createRecall({ rootDir: store.root, store, journals, embedder: null })
const fallback = await noModel.search({ id: agent.id, query: '归档' })
assert.ok(fallback.mode === 'hybrid', 'mode still reports the request')
assert.ok(fallback.results.every(row => row.via !== 'semantic'), 'no embedder means no semantic rows')
assert.equal(noModel.state().semantic.available, false)

const missingDir = createRecall({ rootDir: path.join(scratch, 'empty-mem'), store, journals })
assert.equal(missingDir.state().semantic.available, false, 'a missing model directory degrades, it does not throw')

// ── the real model, when it happens to be installed ───────────────────────
const realDir = path.join(os.homedir(), '.dsh', 'agent-memory', 'models', 'bge-small-zh-v1.5')
if (fs.existsSync(path.join(realDir, 'onnx', 'model_quantized.onnx'))) {
  const real = createEmbedder({ modelDir: realDir })
  await real.load()
  const [a, b, c] = await real.embed(['右键把会话归档', '可以从右键菜单归档会话', '小鲸鱼的泡泡'])
  assert.equal(real.dim, 512)
  assert.ok(cosine(a, b) > cosine(a, c) + 0.05, `same topic embeds closer (${cosine(a, b).toFixed(3)} vs ${cosine(a, c).toFixed(3)})`)
  console.log('  real model: dim 512, related', cosine(a, b).toFixed(3), 'unrelated', cosine(a, c).toFixed(3))
} else {
  console.log('  real model not installed, skipped the native check')
}

// ── chunking: a long note spans several rows, and its score is the best one ─
// BGE reads 512 tokens and the median note in this vault is ~654, so alpha.13
// embeds ~420-character windows instead of truncating. A note's similarity is
// the max over its chunks: averaging would let the note's other topics dilute
// the one precise paragraph a query is after.
const cutScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-chunk-'))
const cutStore = createStore({ rootDir: path.join(cutScratch, 'mem'), knowledgeDir: path.join(cutScratch, 'kb') })
const cutJournals = createJournals({ rootDir: cutStore.root })
const cutAgent = cutStore.createAgent({ name: 'Chunks' })
const cutTitle = '长笔记'
const cutBody = `${'这一段在讲离题的话。'.repeat(100)}最后一句才是答案。`
cutJournals.write({ id: cutAgent.id, title: cutTitle, text: cutBody })
const cutEntries = () =>
  cutJournals.notes(cutAgent.id).map(row => ({
    id: row.id,
    src: 'journal',
    at: String(row.at),
    title: String(row.title),
    text: String(row.text),
    tags: [],
  }))
const pieces = chunksOf({ title: cutTitle, text: cutBody }, CHUNK_CHARS)
assert.ok(pieces.length >= 2, `a long note splits (${pieces.length} chunks)`)
const pieceVectors = new Map(
  pieces.map((piece, index) => [piece, index === pieces.length - 1 ? [0.9, 0.43589] : [0.2, 0.9798]]),
)
const chunkEmbedder = {
  modelPath: '/stub/onnx/model_quantized.onnx',
  dim: 2,
  embed: async texts => texts.map(text => Float32Array.from(pieceVectors.get(text) ?? [0, 1])),
  embedOne: async () => Float32Array.from([1, 0]),
}
const cutVectors = createVectors({ rootDir: cutStore.root, embedder: chunkEmbedder, model: 'chunked' })
const cutBuilt = await cutVectors.sync(cutEntries())
assert.equal(cutBuilt.count, 1, 'count is notes, not rows')
assert.equal(cutBuilt.chunks, pieces.length, 'one row per chunk')
assert.equal(cutBuilt.embedded, pieces.length)
const cutMeta = JSON.parse(fs.readFileSync(path.join(cutStore.root, 'index', 'vectors.json'), 'utf8'))
assert.equal(cutMeta.version, 2, 'version 2 marks the chunked layout')
assert.deepEqual(
  cutMeta.entries.map(entry => entry.chunk),
  pieces.map((_, index) => index),
  'chunk indices are contiguous',
)
const cutScores = await cutVectors.score(cutEntries(), '任意查询')
const cutScore = [...cutScores.values()][0]
assert.ok(Math.abs(cutScore - 0.9) < 0.02, `a note scores as its best chunk (${cutScore.toFixed(3)})`)
const rewritten = await cutVectors.sync(cutEntries(), { chunkChars: 200 })
assert.ok(rewritten.embedded > 0, 'a different chunkChars rebuilds the note')
fs.rmSync(cutScratch, { recursive: true, force: true })

fs.rmSync(scratch, { recursive: true, force: true })
console.log('ALL EMBED TESTS PASSED')
