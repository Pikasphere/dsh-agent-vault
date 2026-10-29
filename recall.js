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
import { createEmbedder } from './embed.js'
import { createVectors } from './vectors.js'

export const SOURCES = ['journal', 'log', 'knowledge', 'session']
export const DEFAULT_BOOST = { journal: 1, log: 1, knowledge: 0.8, session: 0.9, room: 0.7, checkpoint: 0 }
export const DEFAULT_MODEL = 'bge-small-zh-v1.5'
/**
 * Defaults chosen by `eval/recall-grid.mjs` (2.0.0-alpha.11): weights 0.6/0.4
 * is the argmax over 150 combinations; RRF's k makes no measurable difference
 * (spread 0.010 MRR) so it stays 20; the cosine floor moved 0.45 → 0.40 because
 * the off-topic probe peaks at 0.359, so 0.40 keeps a margin of 0.04 while
 * admitting targets the 0.45 floor was throwing away.
 */
export const RECALL_DEFAULTS = { mode: 'hybrid', lexicalWeight: 0.6, semanticWeight: 0.4, minCosine: 0.4, rrfK: 20 }
export const MODES = ['hybrid', 'lexical']

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

  /**
   * The local embedder is optional by construction: a missing model directory or
   * a native-loading failure leaves `embedder` null and the whole recall layer
   * falls back to lexical ranking. `embedderError` explains why in the panel.
   */
  let embedderError = ''
  const embedder =
    options.embedder === null
      ? null
      : options.embedder !== undefined
        ? options.embedder
        : (() => {
            try {
              return createEmbedder({ modelDir: path.join(root, 'models', options.model ?? DEFAULT_MODEL) })
            } catch (error) {
              embedderError = String(error?.message ?? error)
              return null
            }
          })()
  const vectors =
    options.vectors === false || embedder === null
      ? null
      : createVectors({ rootDir: root, embedder, model: options.model ?? DEFAULT_MODEL })

  function recallSettings() {
    const raw = store.settings().recall
    const merged = { ...RECALL_DEFAULTS, ...(typeof raw === 'object' && raw !== null ? raw : {}) }
    if (!MODES.includes(merged.mode)) merged.mode = RECALL_DEFAULTS.mode
    const minCosine = Number(merged.minCosine)
    merged.minCosine = Number.isFinite(minCosine) ? Math.min(Math.max(minCosine, 0), 1) : RECALL_DEFAULTS.minCosine
    const rrfK = Number(merged.rrfK)
    merged.rrfK = Number.isFinite(rrfK) ? Math.min(Math.max(Math.round(rrfK), 1), 200) : RECALL_DEFAULTS.rrfK
    return merged
  }

  /** Load the model ahead of the first query so a search does not pay the 150 ms. */
  async function warm() {
    if (embedder === null) return { ok: false, error: embedderError || 'model-missing' }
    try {
      await embedder.load()
      return { ok: true, dim: embedder.dim }
    } catch (error) {
      embedderError = String(error?.message ?? error)
      return { ok: false, error: embedderError }
    }
  }

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
    let parsed = []
    try {
      parsed = parseLog(fs.readFileSync(file, 'utf8'))
    } catch {
      parsed = []
    }
    // The agent has to be stamped before anything keyed on the entry: log ids
    // (`m-3`) are positional per file, so without it every agent collides in the
    // vector store. Return the stamped rows too — returning `parsed` here made
    // the first read after an edit use unqualified keys while the cache held
    // qualified ones, re-embedding dozens of rows on every other query.
    const entries = parsed.map(item => decorate({ sessionId: '', ...item, agent: agentId }))
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
   * The vector store is one global file: the log layer of every agent, embedded
   * with the same model. Syncing only the querying agent would rewrite the file
   * per agent (and re-embed ~100 rows whenever two agents alternate), so callers
   * sync this union first and then score a single agent's rows from it.
   */
  function vectorEntries() {
    const entries = []
    for (const vault of store.state().vaults) {
      entries.push(...journalEntries(vault.id), ...logEntries(vault.id))
    }
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
  async function search(input = {}) {
    const agentId = String(input.id ?? '')
    const query = String(input.query ?? '').trim()
    const limit = clamp(Number(input.limit) || 8, 1, 25)
    const source = SOURCES.includes(input.source) ? input.source : ''
    const since = Number.isFinite(Date.parse(String(input.since ?? ''))) ? Date.parse(String(input.since)) : 0
    const graph = !(input.expand === 0 || input.expand === '0' || input.expand === false)
    const settings = recallSettings()
    // Per-call overrides exist for the tuning harness (`eval/recall-paraphrase.mjs`):
    // the weights are a calibration knob, and hard-coding them into the store
    // would make every experiment rewrite the user's settings file.
    if (input.minCosine !== undefined) {
      const value = Number(input.minCosine)
      if (Number.isFinite(value) && value >= 0 && value <= 1) settings.minCosine = value
    }
    if (typeof input.weights === 'object' && input.weights !== null) {
      const lexical = Number(input.weights.lexicalWeight)
      const semantic = Number(input.weights.semanticWeight)
      if (Number.isFinite(lexical) && lexical >= 0) settings.lexicalWeight = lexical
      if (Number.isFinite(semantic) && semantic >= 0) settings.semanticWeight = semantic
    }
    if (input.rrfK !== undefined) {
      const value = Number(input.rrfK)
      if (Number.isFinite(value) && value >= 1) settings.rrfK = Math.min(Math.round(value), 200)
    }
    const mode = MODES.includes(input.mode) ? input.mode : settings.mode
    const hybrid = mode === 'hybrid' && vectors !== null
    const tokens = tokenize(query)
    const entries = collect(agentId, source).filter(entry => {
      if (since === 0) return true
      const time = Date.parse(entry.at)
      return Number.isFinite(time) && time >= since
    })
    const boost = src => DEFAULT_BOOST[src] ?? 1
    const rows = rank(entries, query, { boost })

    /**
     * Semantic similarity is computed over the agent's whole journal layer (not
     * the current filter), then looked up per candidate: filtering must not
     * change a vector, only which rows show up.
     */
    let sims = new Map()
    if (hybrid && query !== '') {
      await vectors.sync(vectorEntries())
      sims = await vectors.score(collect(agentId, ''), query)
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

    /**
     * Hybrid fusion is rank-based (reciprocal rank fusion), not score-based.
     *
     * Score fusion was tried first and measurably lost: lexical scores are
     * unbounded and get normalised to their own best hit (1.0 × 0.6), while a
     * cosine sits around 0.5–0.65 (≈0.24 after the 0.4 prior), so *any* lexical
     * hit outranked a better semantic one — the paraphrase eval sat at top-1
     * 33.3 % with weights 0.6/0.4 and at 50 % when semantics ranked alone. RRF
     * compares ranks per channel and cannot have that scale mismatch.
     *
     * `minCosine` still gates semantic-only rows: below it a document may be a
     * lexical hit but never enters on similarity alone.
     */
    const RRF_K = settings.rrfK
    let fusedCache = null
    function fuse() {
      if (fusedCache !== null) return fusedCache
      const lexicalRank = new Map()
      ;[...scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .forEach(([key], index) => lexicalRank.set(key, index + 1))
      const semanticRank = new Map()
      if (hybrid) {
        ;[...entries]
          .map(entry => ({ key: entryKey(entry), cosine: cosineOf(entryKey(entry)) }))
          .filter(item => item.cosine >= settings.minCosine)
          .sort((a, b) => b.cosine - a.cosine)
          .forEach((item, index) => semanticRank.set(item.key, index + 1))
      }
      const fused = new Map()
      const fusedReason = new Map()
      for (const key of new Set([...lexicalRank.keys(), ...semanticRank.keys()])) {
        const lexical = lexicalRank.get(key)
        const semantic = semanticRank.get(key)
        const value =
          (lexical === undefined ? 0 : settings.lexicalWeight / (RRF_K + lexical)) +
          (semantic === undefined ? 0 : settings.semanticWeight / (RRF_K + semantic))
        if (value === 0) continue
        fused.set(key, value)
        const base = reason.get(key) ?? null
        if (lexical !== undefined && base !== null) {
          const cosine = cosineOf(key)
          fusedReason.set(key, cosine >= settings.minCosine ? { ...base, why: { ...(base.why ?? {}), cosine: round(cosine) } } : base)
        } else if (semantic !== undefined) {
          fusedReason.set(key, { via: 'semantic', why: { cosine: round(cosineOf(key)) } })
        } else {
          fusedReason.set(key, { via: 'lexical' })
        }
      }
      fusedCache = { scores: fused, reason: fusedReason }
      return fusedCache
    }
    function cosineOf(key) {
      const value = sims.get(key)
      return typeof value === 'number' ? value : 0
    }

    const effective = hybrid ? fuse() : { scores, reason }
    const ranked = [...effective.scores.entries()]
      .map(([key, score]) => ({ entry: byKey.get(key), score, ...(effective.reason.get(key) ?? { via: 'lexical' }) }))
      .filter(row => row.entry !== undefined)
      .sort((a, b) => b.score - a.score)

    if (!graph) {
      return {
        query,
        mode,
        total: ranked.length,
        expand: 0,
        results: ranked
          .slice(0, limit)
          .map(row => withHit(resultOf(row.entry, row.score, row.via, row.why, tokens), row.entry, tokens)),
      }
    }

    // Graph expansion reads only lexical seeds: a neighbour of a semantic-only
    // hit has no textual link to the query, so the two extensions would stack
    // two independent sources of drift (§6.5 keeps them separate on purpose).
    const seeds = ranked.filter(row => row.via !== 'semantic').slice(0, SEED_COUNT)
    const extras = expandGraph(seeds, entries).filter(row => !effective.scores.has(entryKey(row.entry)))
    const final = [...ranked, ...extras].sort((a, b) => b.score - a.score)
    return {
      query,
      mode,
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
  async function reindex() {
    cache.clear()
    const sources = {}
    let total = 0
    const all = []
    for (const vault of store.state().vaults) {
      const journal = journalEntries(vault.id)
      const log = logEntries(vault.id)
      sources[`journal:${vault.id}`] = journal.length
      sources[`log:${vault.id}`] = log.length
      total += journal.length + log.length
      all.push(...journal, ...log)
    }
    const knowledge = knowledgeEntries().length
    sources.knowledge = knowledge
    total += knowledge
    const sessions = sessionEntries('')
    sources.session = sessions.length
    total += sessions.length
    aliases.ensure()
    let semantic = null
    if (vectors !== null) {
      try {
        const built = await vectors.rebuild(all)
        semantic = { model: vectors.status().model, dim: built.dim, count: built.count, builtAt: built.builtAt }
      } catch (error) {
        semantic = { model: vectors.status().model, error: String(error?.message ?? error) }
      }
    }
    const state = {
      version: 1,
      builtAt: new Date().toISOString(),
      total,
      sources,
      aliases: aliases.read().length,
      expand: 1,
      transcripts: transcripts !== null,
      semantic,
    }
    writeState(state)
    return state
  }

  function state() {
    const persisted = readState()
    const cached = [...cache.entries()].map(([key, value]) => ({ key, entries: value.entries.length, size: value.size }))
    const settings = recallSettings()
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
      mode: settings.mode,
      semantic: vectors === null
        ? { available: false, model: '', error: embedderError || 'model-missing' }
        : { available: true, embedderError, ...vectors.status() },
    }
  }

  /** Load the local model ahead of the first search (called from plugin startup). */
  async function prepare() {
    const result = await warm()
    if (!result.ok) return result
    try {
      await vectors.sync(vectorEntries())
      return { ok: true, dim: result.dim, ...vectors.status() }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
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
    prepare,
    SOURCES,
  }
}
