/**
 * Semantic vectors over the journal layer.
 *
 * Only `journal` and `log` entries are embedded: checkpoints and short memory
 * are authoritative state injected whole into the prompt, and the session
 * transcripts are too large (and too unredacted) to embed yet.
 *
 * Storage is two files under `index/`:
 *   - `vectors.bin`  — float32 little-endian, one row per **chunk**, L2-normalised;
 *   - `vectors.json` — `{version, model, dim, builtAt, entries:[{key, src, at, hash, chunk, chunks}]}`.
 *
 * A note is split into ~`chunkChars` windows before embedding, and a note's
 * similarity is the **maximum** over its chunks. Reason (measured, see
 * `eval/token-check.mjs`): BGE's context is 512 tokens, the median note in this
 * vault is 654 tokens and 79 % of notes exceed the limit, so a single row per
 * note throws away the tail of most notes — the part that usually holds the
 * concrete detail a query is asking about. One row per chunk also keeps each
 * embedding specific instead of averaging several topics into one vector.
 *
 * Freshness is keyed on a 16-hex sha256 of the entry text, not on file mtime:
 * the memory log is append-only, so its mtime changes on every save and an
 * mtime rule would re-embed all entries each time. The chunk count is compared
 * as well, so changing `chunkChars` invalidates rows even when text is equal.
 *
 * @module vectors
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { entryKey } from './graph.js'

// `knowledge` is deliberately absent: measured 2026-10-30, embedding the 25
// shared entries left top-1 unchanged (78.6%) while the unrelated-query cosine
// peaked at 0.471 — above the 0.45 floor — so it would only leak. See
// `eval/knowledge-eval.mjs` and README "知识库为什么不走语义".
export const VECTOR_SOURCES = ['journal', 'log']

/**
 * Characters per chunk. The ratio measured on this vault is ~1.9 chars per
 * token (CJK), so 420 chars ≈ 220 tokens — comfortably inside the 512-token
 * window, with the title repeated on every chunk.
 */
export const CHUNK_CHARS = 420
const CHUNK_OVERLAP = 60

export function hashText(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16)
}

/**
 * The whole note gets embedded — but split, not truncated. Truncating to
 * "title + 240 chars" looked better on semantic-only ranking
 * (`eval/embed-variants.mjs`: MRR 0.438 vs 0.358) yet lifted similarity between
 * *unrelated* notes, pushing the off-topic probe above the cosine floor and
 * costing more end-to-end than it gained (0.256 vs 0.286). Chunking keeps the
 * whole text and keeps each vector specific, which is why it is the variant
 * that shipped.
 */
function sourceText(entry) {
  return `${entry.title ?? ''}\n${entry.text ?? ''}`
}

const BOUNDARIES = ['\n', '。', '！', '？', '；', '.', '!', '?', ';']

/** Split on a sentence boundary near the window end when one is available. */
function splitText(text, size, overlap) {
  const out = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + size)
    if (end < text.length) {
      const window = text.slice(start, end)
      let cut = -1
      for (const mark of BOUNDARIES) {
        const at = window.lastIndexOf(mark)
        if (at > cut) cut = at
      }
      if (cut > size * 0.5) end = start + cut + 1
    }
    out.push(text.slice(start, end))
    if (end >= text.length) break
    start = Math.max(start + 1, end - overlap)
  }
  return out
}

/** The chunks of one note; `chunkChars <= 0` means "one chunk, no splitting". */
export function chunksOf(entry, chunkChars = CHUNK_CHARS) {
  const title = String(entry.title ?? '').trim()
  const body = String(entry.text ?? '').trim()
  const withTitle = piece => (title === '' ? piece : `${title}\n${piece}`)
  if (!Number.isFinite(chunkChars) || chunkChars <= 0) {
    const whole = `${title}\n${body}`.trim()
    return whole === '' ? [] : [whole]
  }
  if (body === '') return title === '' ? [] : [title]
  const pieces = body.length <= chunkChars ? [body] : splitText(body, chunkChars, CHUNK_OVERLAP)
  return pieces.map(piece => piece.trim()).filter(piece => piece !== '').map(withTitle)
}

export function createVectors({ rootDir, embedder = null, model = '', chunkChars = CHUNK_CHARS, titleWeight = 0 } = {}) {
  const dir = path.join(rootDir, 'index')
  const binPath = path.join(dir, 'vectors.bin')
  const metaPath = path.join(dir, 'vectors.json')
  const modelName = model || (embedder === null ? '' : path.basename(path.dirname(embedder.modelPath)))
  let lastError = ''
  let titleBlend = Math.max(0, Math.min(0.5, Number(titleWeight) || 0))
  let memory = null // {model, dim, builtAt, keys:string[], meta:[], rows:Float32Array, at:Map<entryKey, number[]>}
  let writing = Promise.resolve()

  function readMeta() {
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    } catch {
      return null
    }
  }

  /** Row ids carry the chunk index; the entry key stays in the meta row. */
  const rowId = (key, chunk) => `${key}#${chunk}`

  function indexMemory({ builtAt, dim, keys, meta, rows }) {
    const at = new Map()
    for (let i = 0; i < keys.length; i += 1) {
      const key = String(meta[i]?.key ?? keys[i])
      if (!at.has(key)) at.set(key, [])
      at.get(key).push(i)
    }
    return { model: modelName, dim, builtAt, keys, meta, rows, at }
  }

  function load() {
    if (memory !== null) return memory
    const meta = readMeta()
    // version 1 was one row per note; the row ids and the pooling differ, so it
    // is simply stale and gets rebuilt rather than parsed.
    if (meta === null || meta.version !== 2 || meta.model !== modelName) return null
    let bin
    try {
      bin = fs.readFileSync(binPath)
    } catch {
      return null
    }
    const dim = Number(meta.dim) || 0
    const entries = Array.isArray(meta.entries) ? meta.entries : []
    if (dim <= 0 || entries.length * dim * 4 !== bin.length) return null
    const rows = new Float32Array(bin.buffer, bin.byteOffset, entries.length * dim)
    memory = indexMemory({
      builtAt: meta.builtAt ?? '',
      dim,
      keys: entries.map((entry, index) => String(entry.row ?? rowId(entry.key, entry.chunk ?? index))),
      meta: entries,
      rows,
    })
    return memory
  }

  function write(keys, metas, vectors) {
    const dim = vectors[0]?.length ?? 0
    const flat = new Float32Array(keys.length * dim)
    for (let i = 0; i < vectors.length; i += 1) flat.set(vectors[i], i * dim)
    fs.mkdirSync(dir, { recursive: true })
    const tempBin = `${binPath}.${process.pid}.tmp`
    fs.writeFileSync(tempBin, Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength))
    fs.renameSync(tempBin, binPath)
    const builtAt = new Date().toISOString()
    const meta = { version: 2, model: modelName, dim, builtAt, entries: metas }
    const tempMeta = `${metaPath}.${process.pid}.tmp`
    fs.writeFileSync(tempMeta, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    fs.renameSync(tempMeta, metaPath)
    memory = indexMemory({ builtAt, dim, keys, meta: metas, rows: flat })
  }

  /** Only entries whose text (or chunk split) changed get re-embedded. */
  async function sync(entries, options = {}) {
    const size = options.chunkChars ?? chunkChars
    // Sorted by key so an unchanged corpus produces an unchanged file: without a
    // stable order the `changed` check below fires on every call and rewrites
    // 300 KB per query just because two agents were visited in another order.
    const wanted = entries
      .filter(entry => VECTOR_SOURCES.includes(entry.src) && sourceText(entry).trim() !== '')
      .sort((a, b) => entryKey(a).localeCompare(entryKey(b)))
    const current = load()
    const known = new Map() // entry key -> {hash, chunkRows:[Float32Array], titleRow: Float32Array|null}
    if (current !== null) {
      const dim = current.dim
      for (const [key, indices] of current.at) {
        const chunkRows = []
        let titleRow = null
        for (const index of indices) {
          const vector = current.rows.subarray(index * dim, (index + 1) * dim)
          if (Number(current.meta[index]?.chunk) === -1) titleRow = vector
          else chunkRows.push(vector)
        }
        known.set(key, { hash: String(current.meta[indices[0]]?.hash ?? ''), chunkRows, titleRow })
      }
    }
    const keys = []
    const metas = []
    const vectors = []
    const pending = []
    for (const entry of wanted) {
      const key = entryKey(entry)
      const chunks = chunksOf(entry, size)
      if (chunks.length === 0) continue
      const hash = hashText(sourceText(entry))
      // The title can also get its own row (`chunk: -1`): it is the same text
      // every query sees once, and blending it in is a score-side decision. The
      // row is only materialised when the weight is non-zero — see the comment
      // in `scoreMap` for why the default is zero (measured: it hurts).
      const titleText = String(entry.title ?? '').trim()
      const titleRow = titleBlend > 0 && titleText !== '' ? titleText : null
      const hit = known.get(key)
      const reusable =
        hit !== undefined &&
        hit.hash === hash &&
        hit.chunkRows.length === chunks.length &&
        (hit.titleRow === null) === (titleRow === null)
      if (reusable) {
        chunks.forEach((_, chunk) => {
          keys.push(rowId(key, chunk))
          metas.push({ key, row: rowId(key, chunk), src: entry.src, at: entry.at, hash, chunk, chunks: chunks.length })
          vectors.push(Float32Array.from(hit.chunkRows[chunk]))
        })
        if (titleRow !== null) {
          keys.push(rowId(key, 'title'))
          metas.push({ key, row: rowId(key, 'title'), src: entry.src, at: entry.at, hash, chunk: -1, chunks: chunks.length })
          vectors.push(Float32Array.from(hit.titleRow))
        }
      } else {
        chunks.forEach((_, chunk) => {
          keys.push(rowId(key, chunk))
          metas.push({ key, row: rowId(key, chunk), src: entry.src, at: entry.at, hash, chunk, chunks: chunks.length })
          vectors.push(null)
        })
        if (titleRow !== null) {
          keys.push(rowId(key, 'title'))
          metas.push({ key, row: rowId(key, 'title'), src: entry.src, at: entry.at, hash, chunk: -1, chunks: chunks.length })
          vectors.push(null)
        }
        pending.push({ key, entry, chunks, title: titleRow, first: keys.length - chunks.length - (titleRow === null ? 0 : 1) })
      }
    }
    if (pending.length > 0) {
      if (embedder === null) throw new Error('embedder-missing')
      const texts = pending.flatMap(item => (item.title === null ? item.chunks : [...item.chunks, item.title]))
      const fresh = await embedder.embed(texts)
      let cursor = 0
      for (const item of pending) {
        for (let chunk = 0; chunk < item.chunks.length; chunk += 1) vectors[item.first + chunk] = fresh[cursor + chunk]
        cursor += item.chunks.length
        if (item.title !== null) {
          vectors[item.first + item.chunks.length] = fresh[cursor]
          cursor += 1
        }
      }
    }
    const changed =
      current === null ||
      current.keys.length !== keys.length ||
      pending.length > 0 ||
      current.keys.some((key, i) => key !== keys[i])
    if (changed) {
      writing = writing.then(() => write(keys, metas, vectors))
      await writing
    }
    const entryCount = new Set(keys.map(key => key.slice(0, key.lastIndexOf('#')))).size
    const before = current === null ? 0 : new Set(current.keys.map(key => key.slice(0, key.lastIndexOf('#')))).size
    const chunkRows = metas.filter(meta => Number(meta.chunk) !== -1).length
    return {
      count: entryCount,
      chunks: chunkRows,
      titles: keys.length - chunkRows,
      embedded: pending.reduce((sum, item) => sum + item.chunks.length + (item.title === null ? 0 : 1), 0),
      dropped: current === null ? 0 : Math.max(0, before - entryCount),
    }
  }

  function scoreMap(entries, queryVector, weight = titleWeight) {
    const current = load()
    if (current === null || queryVector === null) return new Map()
    const out = new Map()
    const dim = current.dim
    const blend = Math.max(0, Math.min(0.5, Number(weight) || 0))
    for (const entry of entries) {
      const key = entryKey(entry)
      const indices = current.at.get(key)
      if (indices === undefined) continue
      // Max over chunks: a note is usually about one thing, so the best-matching
      // window speaks for it. Averaging would dilute a short, precise chunk with
      // the note's other topics and sink exactly the hits chunking is here for.
      let best = Number.NEGATIVE_INFINITY
      let title = Number.NEGATIVE_INFINITY
      for (const index of indices) {
        let sum = 0
        const base = index * dim
        for (let i = 0; i < dim; i += 1) sum += current.rows[base + i] * queryVector[i]
        if (Number(current.meta[index]?.chunk) === -1) title = sum
        else if (sum > best) best = sum
      }
      if (!Number.isFinite(best)) best = title
      // `titleWeight` blends the note's score towards its title-only vector. It
      // exists because the title is a better summary than any single chunk in
      // isolation (`eval/title-vs-body.mjs`: using titles alone beats body
      // chunks on both families, and 0.85/0.15 blending beat the chunk score on
      // the paraphrase set). It defaults to **0** because in the real pipeline
      // that gain disappears: the lexical path already weighs titles 6:1, so
      // folding them into the semantic column double-counts them and the fused
      // result got worse (13.3 % → 11.1 % → 8.9 % top-1 at 0 / 0.15 / 0.25 on
      // the 45-query set). Kept as a knob with evidence on both sides.
      if (blend > 0 && Number.isFinite(title)) best = (1 - blend) * best + blend * title
      out.set(key, best)
    }
    return out
  }

  async function similarities(entries, query) {
    if (embedder === null) return new Map()
    try {
      await sync(entries)
      return await score(entries, query)
    } catch (error) {
      lastError = String(error?.message ?? error)
      return new Map()
    }
  }

  /**
   * Score against the vectors already on disk, without syncing first.
   *
   * The store is global (every agent's log layer lives in one file), so the
   * caller syncs the union once and then asks for one agent's rows. Syncing per
   * agent here would make two agents invalidate each other on every other
   * query, re-embedding ~100 entries each time.
   */
  async function score(entries, query, weight = titleBlend) {
    if (embedder === null) return new Map()
    try {
      const queryVector = await embedder.embedOne(query)
      lastError = ''
      return scoreMap(entries, queryVector, weight)
    } catch (error) {
      lastError = String(error?.message ?? error)
      return new Map()
    }
  }

  /** The recall layer reads the weight from settings on every query, so this is
   * the one place a settings change has to land. */
  function setTitleWeight(value) {
    titleBlend = Math.max(0, Math.min(0.5, Number(value) || 0))
    return titleBlend
  }

  async function rebuild(entries) {
    memory = null
    try {
      fs.rmSync(binPath, { force: true })
      fs.rmSync(metaPath, { force: true })
    } catch {
      // nothing to clear
    }
    const result = await sync(entries)
    return { ...result, builtAt: memory?.builtAt ?? '', dim: memory?.dim ?? 0 }
  }

  function status() {
    const current = load()
    const rows = current?.keys.length ?? 0
    const titles = current === null ? 0 : [...current.at.values()].filter(indices => indices.some(index => Number(current.meta[index]?.chunk) === -1)).length
    return {
      present: current !== null,
      model: modelName,
      available: embedder !== null,
      dim: current?.dim ?? 0,
      count: current?.at.size ?? 0,
      chunks: rows - titles,
      titles,
      chunkChars,
      titleWeight: titleBlend,
      builtAt: current?.builtAt ?? '',
      lastError,
      binFile: binPath,
      metaFile: metaPath,
    }
  }

  return { status, sync, score, similarities, rebuild, setTitleWeight, VECTOR_SOURCES, chunkChars }
}
