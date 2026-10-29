/**
 * Recall over the journal layer.
 *
 * Three sources feed one index:
 *   - `journal`   — the calling agent's own notes (`journal/<id>.jsonl`);
 *   - `log`       — that agent's memory audit trail (`memory/<id>.log.md`);
 *   - `knowledge` — the shared knowledge library;
 *   - `session`   — conversation transcripts of the sessions this vault already
 *                   knows (handoff checkpoints and current bindings), redacted
 *                   and capped; tool results and reasoning never enter the index.
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

import { rank, round, scoreEntry, snippet, tokenize } from './rank.js'
import { SEED_COUNT, createAliases, entryKey, expand as expandGraph, extractEntities } from './graph.js'
import { createTranscripts } from './transcripts.js'

export const SOURCES = ['journal', 'log', 'knowledge', 'session']
export const DEFAULT_BOOST = { journal: 1, log: 1, knowledge: 0.8, session: 0.9, room: 0.7, checkpoint: 0 }

const clamp = (value, low, high) => Math.min(Math.max(value, low), high)

/** One tool/panel row; `why` only exists for expanded hits. */
function resultOf(entry, score, via, why, tokens) {
  const row = {
    id: entry.id,
    src: entry.src,
    at: entry.at,
    title: entry.title,
    preview: snippet(entry.text, tokens ?? []),
    score: round(score),
    via,
  }
  if (typeof entry.sessionId === 'string' && entry.sessionId !== '') row.sessionId = entry.sessionId
  if (why !== undefined) row.why = why
  return row
}

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
  const aliases = createAliases({ rootDir: root })
  const transcripts =
    options.transcripts === false
      ? null
      : typeof options.transcripts === 'object' && options.transcripts !== null
        ? options.transcripts
        : createTranscripts({
            rootDir: root,
            store,
            sessionsRoot: options.sessionsRoot,
            exclude: options.exclude ?? (() => store.settings().transcriptExclude ?? []),
          })

  /** Entities are derived once per rebuild, never stored: graph edges cannot rot. */
  function decorate(entry) {
    const tags = Array.isArray(entry.tags) ? entry.tags : []
    const text = `${entry.title ?? ''}\n${tags.join(' ')}\n${entry.text ?? ''}`
    return { ...entry, entities: extractEntities(text) }
  }

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
    const entries = journals.notes(agentId).map(entry =>
      decorate({
        id: entry.id,
        src: 'journal',
        at: String(entry.at ?? ''),
        title: String(entry.title ?? ''),
        text: String(entry.text ?? ''),
        tags: [],
        sessionId: String(entry.meta?.sessionId ?? ''),
      }),
    )
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
      const tagged = head.match(/\[session:\s*([^\]]+)\]\s*$/)
      const sessionId = tagged === null ? '' : tagged[1].trim()
      const clean = tagged === null ? head : head.slice(0, tagged.index).trim()
      const [stamp, ...rest] = clean.split(' — ')
      const time = Date.parse(stamp.trim())
      entries.push({
        id: `m-${entries.length}`,
        src: 'log',
        at: Number.isFinite(time) ? new Date(time).toISOString() : '',
        title: rest.join(' — ').trim() || 'memory save',
        text: body === '(cleared)' ? '' : body,
        tags: [],
        sessionId,
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
    cache.set(key, { ...stat, entries: entries.map(item => decorate({ sessionId: '', ...item })) })
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
    const entries = store.allKnowledge().map(entry =>
      decorate({
        id: entry.id,
        src: 'knowledge',
        at: String(entry.updated ?? entry.created ?? ''),
        title: String(entry.title ?? ''),
        text: String(entry.body ?? ''),
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        sessionId: '',
      }),
    )
    cache.set('knowledge', { ...stat, entries })
    return entries
  }

  /** Transcripts of the sessions this agent owns; `transcripts.js` has its own cache. */
  function sessionEntries(agentId) {
    if (transcripts === null) return []
    return transcripts.entries(agentId).map(entry =>
      decorate({
        id: entry.id,
        src: 'session',
        at: entry.at,
        title: entry.title,
        text: entry.text,
        tags: [],
        sessionId: entry.sessionId,
      }),
    )
  }

  function collect(agentId, source) {
    const entries = []
    if (source === '' || source === 'journal') entries.push(...journalEntries(agentId))
    if (source === '' || source === 'log') entries.push(...logEntries(agentId))
    if (source === '' || source === 'knowledge') entries.push(...knowledgeEntries())
    if (source === '' || source === 'session') entries.push(...sessionEntries(agentId))
    return entries
  }

  /**
   * The single message a session hit actually came from. `uiWorkspace` cannot
   * scroll to a message, so a hit carries the message's role/seq/preview and the
   * caller decides what to do with it — never the message's whole session.
   */
  function bestMessage(sessionId, tokens) {
    const messages = transcripts === null ? [] : transcripts.messagesOf(sessionId)
    let best = null
    for (const message of messages) {
      const score = scoreEntry({ title: '', text: message.text, tags: [] }, tokens)
      if (score > 0 && (best === null || score > best.score)) best = { message, score }
    }
    return best
  }

  /** Attach `hit` to a session row so a big session can be traced to one message. */
  function withHit(row, entry, tokens) {
    if (entry.src !== 'session' || transcripts === null || tokens.length === 0) return row
    if (typeof entry.sessionId !== 'string' || entry.sessionId === '') return row
    const best = bestMessage(entry.sessionId, tokens)
    if (best === null) return row
    return {
      ...row,
      hit: {
        seq: best.message.seq,
        role: best.message.role,
        at: best.message.at,
        text: snippet(best.message.text, tokens, 240),
      },
    }
  }

  /** The alias table behind `expand:1`, readable and writable through ops. */
  function aliasTable() {
    return { file: aliases.file, table: aliases.map() }
  }

  function aliasSet(input = {}) {
    const key = String(input.key ?? '')
    const raw = Array.isArray(input.targets) ? input.targets : typeof input.targets === 'string' ? input.targets.split(/[,，\s]+/) : []
    if (key.trim() === '') throw new Error('an alias key is required')
    const written = aliases.set(key, raw)
    return { ...written, file: aliases.file, table: aliases.map() }
  }

  function aliasRemove(input = {}) {
    const removed = aliases.remove(String(input.key ?? ''))
    return { key: String(input.key ?? '').trim(), removed, file: aliases.file, table: aliases.map() }
  }

  /** Every session this agent may read, with its indexed state (panel list). */
  /** Indexed messages of one session, for a message-level open. */
  function messagesOf(sessionId) {
    return transcripts === null ? [] : transcripts.messagesOf(sessionId)
  }

  function sessions(agentId = '') {
    if (transcripts === null) return []
    return transcripts.list(agentId)
  }

  /**
   * Search the calling agent's recallable material.
   *
   * `expand` defaults to 1: aliases from `index/aliases.json` are folded into
   * the query and the lexical seeds get one graph hop (docs §6.5). Pass
   * `expand: 0` for the pure lexical ranking — the baseline numbers in the
   * design doc were measured that way.
   */
  function search(input = {}) {
    const agentId = String(input.id ?? '')
    const query = String(input.query ?? '').trim()
    const limit = clamp(Number(input.limit) || 8, 1, 25)
    const source = SOURCES.includes(input.source) ? input.source : ''
    const since = Number.isFinite(Date.parse(String(input.since ?? ''))) ? Date.parse(String(input.since)) : 0
    const graph = !(input.expand === 0 || input.expand === '0' || input.expand === false)
    const tokens = tokenize(query)
    const entries = collect(agentId, source).filter(entry => {
      if (since === 0) return true
      const time = Date.parse(entry.at)
      return Number.isFinite(time) && time >= since
    })
    const boost = src => DEFAULT_BOOST[src] ?? 1
    const rows = rank(entries, query, { boost })
    if (!graph) {
      return {
        query,
        total: rows.length,
        expand: 0,
        results: rows
          .slice(0, limit)
          .map(row => withHit(resultOf(row.entry, row.score, 'lexical', undefined, tokens), row.entry, tokens)),
      }
    }

    const byKey = new Map(entries.map(entry => [entryKey(entry), entry]))
    const scores = new Map()
    const reason = new Map()
    for (const row of rows) {
      const key = entryKey(row.entry)
      scores.set(key, row.score)
      reason.set(key, { via: 'lexical' })
    }
    // An alias is a hand-written equivalence: "vault 插件" means `dsh-agent-vault`.
    // Entries it turns up enter as weaker seeds, and lexical hits it confirms
    // get a nudge, mirroring §6.5's "seed weight ×1.2".
    for (const alias of aliases.expandQuery(query)) {
      for (const row of rank(entries, alias.target, { boost })) {
        const key = entryKey(row.entry)
        const known = scores.get(key)
        if (known === undefined) {
          scores.set(key, row.score * 0.5)
          reason.set(key, { via: 'alias', why: { hub: alias.key, edge: 'alias', weight: 1.2 } })
        } else if (reason.get(key).via === 'lexical') {
          scores.set(key, known * 1.2)
        }
      }
    }
    const ranked = [...scores.entries()]
      .map(([key, score]) => ({ entry: byKey.get(key), score, ...(reason.get(key) ?? { via: 'lexical' }) }))
      .filter(row => row.entry !== undefined)
      .sort((a, b) => b.score - a.score)
    const seeds = ranked.slice(0, SEED_COUNT)
    const extras = expandGraph(seeds, entries).filter(row => !scores.has(entryKey(row.entry)))
    const final = [...ranked, ...extras].sort((a, b) => b.score - a.score)
    return {
      query,
      total: final.length,
      expand: 1,
      results: final
        .slice(0, limit)
        .map(row => withHit(resultOf(row.entry, row.score, row.via, row.why, tokens), row.entry, tokens)),
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
    const entryOut = { id: found.id, src: found.src, at: found.at, title: found.title, text: found.text, tags: found.tags }
    if (typeof found.sessionId === 'string' && found.sessionId !== '') entryOut.sessionId = found.sessionId
    return entryOut
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
    const sessions = sessionEntries('')
    sources.session = sessions.length
    total += sessions.length
    aliases.ensure()
    const state = {
      version: 1,
      builtAt: new Date().toISOString(),
      total,
      sources,
      aliases: aliases.read().length,
      expand: 1,
      transcripts: transcripts !== null,
    }
    writeState(state)
    return state
  }

  function state() {
    const persisted = readState()
    const cached = [...cache.entries()].map(([key, value]) => ({ key, entries: value.entries.length, size: value.size }))
    return {
      indexFile: statePath,
      aliasFile: aliases.file,
      expand: 1,
      aliases: aliases.read().length,
      transcripts: transcripts !== null,
      sessionsRoot: transcripts?.root ?? '',
      builtAt: persisted?.builtAt ?? '',
      total: persisted?.total ?? null,
      sources: persisted?.sources ?? {},
      cached,
    }
  }

  return {
    search,
    open,
    sessions,
    messages: messagesOf,
    aliases: aliasTable,
    aliasSet,
    aliasRemove,
    reindex,
    state,
    SOURCES,
  }
}
