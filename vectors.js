/**
 * Semantic vectors over the journal layer.
 *
 * Only `journal` and `log` entries are embedded: checkpoints and short memory
 * are authoritative state injected whole into the prompt, and the session
 * transcripts are too large (and too unredacted) to embed yet.
 *
 * Storage is two files under `index/`:
 *   - `vectors.bin`  — float32 little-endian, one row per entry, L2-normalised;
 *   - `vectors.json` — `{version, model, dim, builtAt, entries:[{key, src, at, hash}]}`.
 *
 * Freshness is keyed on a 16-hex sha256 of the entry text, not on file mtime:
 * the memory log is append-only, so its mtime changes on every save and an
 * mtime rule would re-embed all 150 entries each time.
 *
 * @module vectors
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { entryKey } from './graph.js'

export const VECTOR_SOURCES = ['journal', 'log']

export function hashText(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16)
}

function sourceText(entry) {
  return `${entry.title ?? ''}\n${entry.text ?? ''}`
}

export function createVectors({ rootDir, embedder = null, model = '' } = {}) {
  const dir = path.join(rootDir, 'index')
  const binPath = path.join(dir, 'vectors.bin')
  const metaPath = path.join(dir, 'vectors.json')
  const modelName = model || (embedder === null ? '' : path.basename(path.dirname(embedder.modelPath)))
  let lastError = ''
  let memory = null // {model, dim, builtAt, keys:string[], rows:Float32Array, hashOf:Map}
  let writing = Promise.resolve()

  function readMeta() {
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    } catch {
      return null
    }
  }

  function load() {
    if (memory !== null) return memory
    const meta = readMeta()
    if (meta === null || meta.model !== modelName) return null
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
    memory = {
      model: meta.model,
      dim,
      builtAt: meta.builtAt ?? '',
      keys: entries.map(entry => String(entry.key)),
      meta: entries,
      rows,
    }
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
    const meta = { version: 1, model: modelName, dim, builtAt, entries: metas }
    const tempMeta = `${metaPath}.${process.pid}.tmp`
    fs.writeFileSync(tempMeta, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    fs.renameSync(tempMeta, metaPath)
    memory = { model: modelName, dim, builtAt, keys, meta: metas, rows: flat }
  }

  /** Only entries whose text changed get re-embedded; stale rows are dropped. */
  async function sync(entries) {
    // Sorted by key so an unchanged corpus produces an unchanged file: without a
    // stable order the `changed` check below fires on every call and rewrites
    // 300 KB per query just because two agents were visited in another order.
    const wanted = entries
      .filter(entry => VECTOR_SOURCES.includes(entry.src) && sourceText(entry).trim() !== '')
      .sort((a, b) => entryKey(a).localeCompare(entryKey(b)))
    const current = load()
    const known = new Map()
    if (current !== null) {
      for (let i = 0; i < current.keys.length; i += 1) {
        const dim = current.dim
        known.set(current.keys[i], { hash: current.meta[i]?.hash ?? '', vector: current.rows.subarray(i * dim, (i + 1) * dim) })
      }
    }
    const keys = []
    const metas = []
    const vectors = []
    const pending = []
    for (const entry of wanted) {
      const key = entryKey(entry)
      const hash = hashText(sourceText(entry))
      const hit = known.get(key)
      if (hit !== undefined && hit.hash === hash) {
        keys.push(key)
        metas.push({ key, src: entry.src, at: entry.at, hash })
        vectors.push(Float32Array.from(hit.vector))
      } else {
        keys.push(key)
        metas.push({ key, src: entry.src, at: entry.at, hash })
        vectors.push(null)
        pending.push({ index: keys.length - 1, entry })
      }
    }
    if (pending.length > 0) {
      if (embedder === null) throw new Error('embedder-missing')
      const texts = pending.map(item => sourceText(item.entry))
      const fresh = await embedder.embed(texts)
      for (let i = 0; i < pending.length; i += 1) vectors[pending[i].index] = fresh[i]
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
    return { count: keys.length, embedded: pending.length, dropped: current === null ? 0 : Math.max(0, current.keys.length - keys.length) }
  }

  function scoreMap(entries, queryVector) {
    const current = load()
    if (current === null || queryVector === null) return new Map()
    const at = new Map()
    for (let i = 0; i < current.keys.length; i += 1) at.set(current.keys[i], i)
    const out = new Map()
    const dim = current.dim
    for (const entry of entries) {
      const index = at.get(entryKey(entry))
      if (index === undefined) continue
      let sum = 0
      const base = index * dim
      for (let i = 0; i < dim; i += 1) sum += current.rows[base + i] * queryVector[i]
      out.set(entryKey(entry), sum)
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
  async function score(entries, query) {
    if (embedder === null) return new Map()
    try {
      const queryVector = await embedder.embedOne(query)
      lastError = ''
      return scoreMap(entries, queryVector)
    } catch (error) {
      lastError = String(error?.message ?? error)
      return new Map()
    }
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
    return {
      present: current !== null,
      model: modelName,
      available: embedder !== null,
      dim: current?.dim ?? 0,
      count: current?.keys.length ?? 0,
      builtAt: current?.builtAt ?? '',
      lastError,
      binFile: binPath,
      metaFile: metaPath,
    }
  }

  return { status, sync, score, similarities, rebuild, VECTOR_SOURCES }
}
