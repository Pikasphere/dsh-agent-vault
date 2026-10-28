/**
 * Recall over the journal layer.
 *
 * Three sources feed one index:
 *   - `journal`   — the calling agent's own notes (`journal/<id>.jsonl`);
 *   - `log`       — that agent's memory audit trail (`memory/<id>.log.md`);
 *   - `knowledge` — the shared knowledge library.
 *
 * Checkpoints are deliberately absent: they are authoritative state that is
 * injected whole into the prompt, and an old checkpoint surfaced next to the
 * current one is exactly the kind of stale instruction that misleads a model.
 * `room` is absent too (2.0 leaves the discussion rooms out of recall).
 *
 * The index is a per-process cache keyed on `(size, mtimeMs)` of each file.
 * That is enough for this corpus — a cold rebuild of everything takes a few
 * milliseconds — and it makes `journal.delete` correct without any incremental
 * bookkeeping. `index/state.json` records what was last built, for the panel and
 * for `memory.reindex` diagnostics.
 *
 * @module recall
 */

import fs from 'node:fs'
import path from 'node:path'

import { rank, round, preview as makePreview } from './rank.js'

export const SOURCES = ['journal', 'log', 'knowledge']
export const DEFAULT_BOOST = { journal: 1, log: 1, knowledge: 0.8, room: 0.7, checkpoint: 0 }

const clamp = (value, low, high) => Math.min(Math.max(value, low), high)

function statOf(file) {
  try {
    const stat = fs.statSync(file)
    return { size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

export function createRecall(options = {}) {
  const root = path.resolve(options.rootDir || '.')
  const store = options.store
  const journals = options.journals
  const indexDir = path.join(root, 'index')
  const statePath = path.join(indexDir, 'state.json')
  const cache = new Map()

  const logFileOf = agentId => path.join(root, 'memory', `${agentId}.log.md`)

  /** Notes of one agent, rebuilt only when the journal file actually changed. */
  function journalEntries(agentId) {
    const file = journals.fileOf(agentId)
    const key = `journal:${agentId}`
    const stat = statOf(file)
    const known = cache.get(key)
    if (stat === null) {
      cache.delete(key)
      return []
    }
    if (known !== undefined && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.entries
    const entries = journals.notes(agentId).map(entry => ({
      id: entry.id,
      src: 'journal',
      at: String(entry.at ?? ''),
      title: String(entry.title ?? ''),
      text: String(entry.text ?? ''),
      tags: [],
    }))
    cache.set(key, { ...stat, entries })
    return entries
  }

  /** Parse the append-only memory audit log: `## <iso> — <note>` blocks. */
  function parseLog(raw) {
    const entries = []
    for (const chunk of String(raw).split(/^## /m)) {
      const text = chunk.trim()
      if (text === '') continue
      const newline = text.indexOf('\n')
      const head = (newline === -1 ? text : text.slice(0, newline)).trim()
      const body = newline === -1 ? '' : text.slice(newline + 1).trim()
      const [stamp, ...rest] = head.split(' — ')
      const time = Date.parse(stamp.trim())
      entries.push({
        id: `m-${entries.length}`,
        src: 'log',
        at: Number.isFinite(time) ? new Date(time).toISOString() : '',
        title: rest.join(' — ').trim() || 'memory save',
        text: body === '(cleared)' ? '' : body,
        tags: [],
      })
    }
    return entries
  }

  function logEntries(agentId) {
    const file = logFileOf(agentId)
    const key = `log:${agentId}`
    const stat = statOf(file)
    const known = cache.get(key)
    if (stat === null) {
      cache.delete(key)
      return []
    }
    if (known !== undefined && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.entries
    let entries = []
    try {
      entries = parseLog(fs.readFileSync(file, 'utf8'))
    } catch {
      entries = []
    }
    cache.set(key, { ...stat, entries })
    return entries
  }

  function knowledgeEntries() {
    const dir = store.knowledgeRoot()
    const stat = statOf(dir)
    const known = cache.get('knowledge')
    if (stat === null) {
      cache.delete('knowledge')
      return []
    }
    if (known !== undefined && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.entries
    const entries = store.allKnowledge().map(entry => ({
      id: entry.id,
      src: 'knowledge',
      at: String(entry.updated ?? entry.created ?? ''),
      title: String(entry.title ?? ''),
      text: String(entry.body ?? ''),
      tags: Array.isArray(entry.tags) ? entry.tags : [],
    }))
    cache.set('knowledge', { ...stat, entries })
    return entries
  }

  function collect(agentId, source) {
    const entries = []
    if (source === '' || source === 'journal') entries.push(...journalEntries(agentId))
    if (source === '' || source === 'log') entries.push(...logEntries(agentId))
    if (source === '' || source === 'knowledge') entries.push(...knowledgeEntries())
    return entries
  }

  /**
   * Search the calling agent's recallable material.
   *
   * `expand` is accepted already and always behaves as `0` — the graph layer
   * lands in 2.0.0-alpha.3 (docs/memory-recall-v2.md §6.5). Requesting it now
   * is not an error, it simply returns the lexical result set with `via` set.
   */
  function search(input = {}) {
    const agentId = String(input.id ?? '')
    const query = String(input.query ?? '').trim()
    const limit = clamp(Number(input.limit) || 8, 1, 25)
    const source = SOURCES.includes(input.source) ? input.source : ''
    const since = Number.isFinite(Date.parse(String(input.since ?? ''))) ? Date.parse(String(input.since)) : 0
    const entries = collect(agentId, source).filter(entry => {
      if (since === 0) return true
      const time = Date.parse(entry.at)
      return Number.isFinite(time) && time >= since
    })
    const rows = rank(entries, query, { boost: src => DEFAULT_BOOST[src] ?? 1 })
    return {
      query,
      total: rows.length,
      expand: 0,
      results: rows.slice(0, limit).map(row => ({
        id: row.entry.id,
        src: row.entry.src,
        at: row.entry.at,
        title: row.entry.title,
        preview: makePreview(row.entry.text),
        score: round(row.score),
        via: 'lexical',
      })),
    }
  }

  /**
   * One full record behind a search hit, for the panel's expand view. The id is
   * only unique inside its own source (the log uses positional ids), so `src`
   * is required alongside it.
   */
  function open(input = {}) {
    const agentId = String(input.id ?? '')
    const src = SOURCES.includes(input.src) ? input.src : ''
    const entry = String(input.entry ?? '')
    if (src === '' || entry === '') return null
    const found = collect(agentId, src).find(item => item.id === entry)
    if (found === undefined) return null
    return { id: found.id, src: found.src, at: found.at, title: found.title, text: found.text, tags: found.tags }
  }

  function writeState(state) {
    fs.mkdirSync(indexDir, { recursive: true })
    const temp = `${statePath}.${process.pid}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    fs.renameSync(temp, statePath)
  }

  function readState() {
    try {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'))
    } catch {
      return null
    }
  }

  /** Drop every cache and rebuild from disk, recording what was built. */
  function reindex() {
    cache.clear()
    const sources = {}
    let total = 0
    for (const vault of store.state().vaults) {
      const journal = journalEntries(vault.id).length
      const log = logEntries(vault.id).length
      sources[`journal:${vault.id}`] = journal
      sources[`log:${vault.id}`] = log
      total += journal + log
    }
    const knowledge = knowledgeEntries().length
    sources.knowledge = knowledge
    total += knowledge
    const state = { version: 1, builtAt: new Date().toISOString(), total, sources }
    writeState(state)
    return state
  }

  function state() {
    const persisted = readState()
    const cached = [...cache.entries()].map(([key, value]) => ({ key, entries: value.entries.length, size: value.size }))
    return {
      indexFile: statePath,
      builtAt: persisted?.builtAt ?? '',
      total: persisted?.total ?? null,
      sources: persisted?.sources ?? {},
      cached,
    }
  }

  return { search, open, reindex, state, SOURCES }
}
