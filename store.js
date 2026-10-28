/**
 * Agent memory and knowledge storage.
 *
 * Plain Node file storage, no Cordis dependency, so the same functions serve
 * the browser UI (through the host's HTTP surface) and the model tools.
 *
 * Layout:
 *   <memoryRoot>/agents.json                  registry
 *   <memoryRoot>/settings.json                knowledge dir + active vault
 *   <memoryRoot>/memory/<agentId>.md          the inheritable memory (one per agent)
 *   <memoryRoot>/memory/<agentId>.log.md      append-only audit of memory saves
 *   <knowledgeDir>/<entryId>.md               the shared knowledge base
 *
 * Memory is per agent and short enough to inherit. Knowledge is one shared
 * library: every agent reads and writes the same entries, and each entry records
 * which agent contributed it.
 *
 * @module store
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Default memory ceiling. Long enough for a real handoff, short enough to inherit. */
export const MEMORY_LIMIT = 4000
/** One knowledge entry can be much longer; this only stops runaway writes. */
export const ENTRY_LIMIT = 48000

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const ENTRY_ID = /^[a-z0-9][a-z0-9-]{0,79}$/

export function defaultRoot() {
  return path.join(os.homedir(), '.dsh', 'agent-memory')
}

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, text, 'utf8')
  fs.renameSync(temp, file)
}

function latin(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function randomId() {
  return Math.random().toString(36).slice(2, 6)
}

function soon() {
  return new Date().toISOString()
}

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function clamp(value, low, high, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.round(number), low), high)
}

function snippet(body, length = 180) {
  const text = collapse(String(body ?? '').replace(/^---[\s\S]*?---/, ''))
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

function parseEntry(id, raw) {
  const text = String(raw ?? '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  const meta = {}
  let body = text
  if (match) {
    body = text.slice(match[0].length)
    for (const line of match[1].split(/\r?\n/)) {
      const at = line.indexOf(':')
      if (at <= 0) continue
      meta[line.slice(0, at).trim()] = line.slice(at + 1).trim()
    }
  }
  return {
    id,
    title: meta.title || id,
    tags: (meta.tags ?? '').split(',').map(item => item.trim()).filter(Boolean),
    agent: meta.agent ?? '',
    created: meta.created ?? '',
    updated: meta.updated ?? '',
    source: meta.source ?? '',
    body,
  }
}

function renderEntry(entry) {
  const tags = entry.tags.join(', ')
  return [
    '---',
    `title: ${entry.title.replace(/\r?\n/g, ' ')}`,
    `tags: ${tags}`,
    `agent: ${entry.agent ?? ''}`,
    `created: ${entry.created}`,
    `updated: ${entry.updated}`,
    `source: ${entry.source.replace(/\r?\n/g, ' ')}`,
    '---',
    '',
    entry.body.replace(/\r\n/g, '\n').replace(/\s+$/, ''),
    '',
  ].join('\n')
}

function score(entry, tokens) {
  if (tokens.length === 0) return 1
  const title = entry.title.toLowerCase()
  const tags = entry.tags.join(' ').toLowerCase()
  const body = entry.body.toLowerCase()
  let total = 0
  for (const token of tokens) {
    let hit = 0
    if (title.includes(token)) hit += 6
    if (tags.includes(token)) hit += 4
    let from = 0
    while (hit < 40) {
      const at = body.indexOf(token, from)
      if (at < 0) break
      hit += 1
      from = at + token.length
    }
    if (hit === 0) return 0
    total += hit
  }
  return total
}

/**
 * One store bound to one memory root.
 * Every mutating method returns the new state the callers render.
 */
export function createStore(options = {}) {
  const root = path.resolve(options.rootDir || defaultRoot())
  const fallbackKnowledge = path.resolve(options.knowledgeDir || path.join(root, 'knowledge'))
  const memoryLimit = clamp(options.memoryLimit, 500, 20000, MEMORY_LIMIT)
  const entryLimit = clamp(options.entryLimit, 2000, 200000, ENTRY_LIMIT)
  const resolveTitle = typeof options.resolveTitle === 'function' ? options.resolveTitle : () => ''
  const titleCache = new Map()

  /** A conversation title is presentation only: never let it fail a read. */
  function titleOf(sessionId) {
    const now = Date.now()
    const cached = titleCache.get(sessionId)
    if (cached !== undefined && now - cached.at < 10000) return cached.title
    let title = ''
    try {
      title = String(resolveTitle(sessionId) ?? '').trim()
    } catch {
      title = ''
    }
    titleCache.set(sessionId, { title, at: now })
    return title
  }

  const files = {
    agents: path.join(root, 'agents.json'),
    settings: path.join(root, 'settings.json'),
    bindings: path.join(root, 'bindings.json'),
  }

  const migrated = new Set()

  function settings() {
    const raw = readJson(files.settings, {})
    return {
      version: 1,
      knowledgeDir: typeof raw.knowledgeDir === 'string' ? raw.knowledgeDir : '',
      activeVault: typeof raw.activeVault === 'string' ? raw.activeVault : '',
      hideBoundSessions: raw.hideBoundSessions !== false,
      transcripts: raw.transcripts !== false,
      sessionsRoot: typeof raw.sessionsRoot === 'string' ? raw.sessionsRoot : '',
    }
  }

  function resolveKnowledgeRoot() {
    const configured = settings().knowledgeDir.trim()
    return configured === '' ? fallbackKnowledge : path.resolve(configured)
  }

  function registry() {
    const raw = readJson(files.agents, {})
    const list = Array.isArray(raw.agents) ? raw.agents : []
    return list.filter(item => item && AGENT_ID.test(String(item.id ?? '')))
  }

  function saveRegistry(list) {
    writeAtomic(files.agents, `${JSON.stringify({ version: 1, agents: list }, null, 2)}\n`)
  }

  // ── session ↔ agent binding ────────────────────────────────────────────────
  // Several conversations can run at the same time under different agents, so
  // the binding is per session. `settings.activeVault` remains the default for a
  // session that has no binding of its own.

  function readBindings() {
    const raw = readJson(files.bindings, {})
    const sessions = raw && raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {}
    return { version: 1, sessions }
  }

  function saveBindings(next) {
    writeAtomic(files.bindings, `${JSON.stringify({ version: 1, sessions: next.sessions }, null, 2)}\n`)
  }

  function bindingOf(sessionId) {
    const key = String(sessionId ?? '')
    if (key === '') return ''
    const bound = readBindings().sessions[key]
    if (typeof bound !== 'string' || bound === '') return ''
    return registry().some(item => item.id === bound) ? bound : ''
  }

  function setBinding(input = {}) {
    const sessionId = String(input.sessionId ?? '')
    if (sessionId === '') throw new MemoryError('bad-session', 'session id required')
    const next = readBindings()
    const agentId = String(input.agentId ?? '')
    if (agentId === '') delete next.sessions[sessionId]
    else next.sessions[sessionId] = requireAgent(agentId).id
    saveBindings(next)
    return { sessionId, agentId: bindingOf(sessionId) }
  }

  function listBindings() {
    const agents = new Map(registry().map(item => [item.id, item.name]))
    const sessions = readBindings().sessions
    return Object.keys(sessions)
      .map(sessionId => ({
        sessionId,
        agentId: sessions[sessionId],
        name: agents.get(sessions[sessionId]) ?? '',
        title: titleOf(sessionId),
      }))
      .filter(item => item.name !== '')
      .slice(-50)
  }

  function requireAgent(id) {
    const key = String(id ?? '')
    if (!AGENT_ID.test(key)) throw new MemoryError('bad-vault', `invalid agent id: ${key || '(empty)'}`)
    const found = registry().find(item => item.id === key)
    if (!found) throw new MemoryError('no-vault', `unknown agent: ${key}`)
    return found
  }

  function memoryFile(id) {
    return path.join(root, 'memory', `${id}.md`)
  }

  function logFile(id) {
    return path.join(root, 'memory', `${id}.log.md`)
  }

  function readMemory(id) {
    try {
      return fs.readFileSync(memoryFile(id), 'utf8')
    } catch {
      return ''
    }
  }

  /** Cheap lookup for the handoff watcher, which runs on every step. */
  function memoryUpdatedAt(id) {
    const found = registry().find(item => item.id === String(id ?? ''))
    return found?.memoryUpdatedAt ?? ''
  }

  /**
   * Fold the pre-shared layout (`<knowledgeDir>/<agentId>/<entry>.md`) into the
   * single shared directory, once per knowledge directory, keeping the old
   * folder name as the entry's contributing agent. Runs only for subdirectories
   * that are registered agents, so an unrelated folder is never touched.
   */
  function ensureShared(dir) {
    if (migrated.has(dir)) return
    let directoryEntries
    try {
      directoryEntries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      // Not created yet: leave it unmarked so the first real read retries.
      return
    }
    migrated.add(dir)
    const ids = new Set(registry().map(item => item.id))
    for (const entry of directoryEntries) {
      if (!entry.isDirectory() || !ids.has(entry.name)) continue
      const from = path.join(dir, entry.name)
      let names
      try {
        names = fs.readdirSync(from).filter(name => name.endsWith('.md'))
      } catch {
        continue
      }
      for (const name of names) {
        const entryId = name.slice(0, -3)
        if (!ENTRY_ID.test(entryId)) continue
        try {
          const parsed = parseEntry(entryId, fs.readFileSync(path.join(from, name), 'utf8'))
          parsed.agent = parsed.agent || entry.name
          let target = path.join(dir, `${entryId}.md`)
          if (fs.existsSync(target)) {
            let suffix = 2
            while (fs.existsSync(path.join(dir, `${entryId}-${suffix}.md`))) suffix += 1
            target = path.join(dir, `${entryId}-${suffix}.md`)
          }
          writeAtomic(target, renderEntry(parsed))
          fs.rmSync(path.join(from, name), { force: true })
        } catch {
          /* leave an unreadable file alone */
        }
      }
      try {
        fs.rmdirSync(from)
      } catch {
        /* not empty: keep it */
      }
    }
  }

  function knowledgeRoot() {
    const dir = resolveKnowledgeRoot()
    ensureShared(dir)
    return dir
  }

  function entries() {
    const dir = knowledgeRoot()
    let names = []
    try {
      names = fs.readdirSync(dir).filter(name => name.endsWith('.md'))
    } catch {
      return []
    }
    const list = []
    for (const name of names) {
      const entryId = name.slice(0, -3)
      if (!ENTRY_ID.test(entryId)) continue
      try {
        list.push(parseEntry(entryId, fs.readFileSync(path.join(dir, name), 'utf8')))
      } catch {
        /* unreadable entry is skipped rather than failing the list */
      }
    }
    list.sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
    return list
  }

  function knowledgeCount(id) {
    try {
      return entries().filter(entry => entry.agent === id).length
    } catch {
      return 0
    }
  }

  function view(agent) {
    const memory = readMemory(agent.id)
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description ?? '',
      createdAt: agent.createdAt ?? '',
      updatedAt: agent.updatedAt ?? '',
      memory: memory,
      memoryChars: memory.trim().length,
      memoryUpdatedAt: agent.memoryUpdatedAt ?? '',
      knowledgeCount: knowledgeCount(agent.id),
    }
  }

  function state() {
    const current = settings()
    const vaults = registry().map(view)
    const active = vaults.find(item => item.id === current.activeVault)
    return {
      root: root,
      knowledgeDir: knowledgeRoot(),
      knowledgeDirConfigured: current.knowledgeDir,
      memoryLimit: memoryLimit,
      entryLimit: entryLimit,
      knowledgeShared: true,
      knowledgeCount: entries().length,
      activeVault: active === undefined ? '' : active.id,
      hideBoundSessions: current.hideBoundSessions,
      transcripts: current.transcripts,
      sessionsRoot: current.sessionsRoot,
      bindings: listBindings(),
      vaults: vaults,
    }
  }

  function createAgent(input = {}) {
    const name = collapse(input.name) || 'New agent'
    const list = registry()
    const base = latin(name) || 'agent'
    let id = `${base}-${randomId()}`
    while (list.some(item => item.id === id)) id = `${base}-${randomId()}`
    const now = soon()
    const agent = {
      id,
      name: name.slice(0, 80),
      description: collapse(input.description).slice(0, 400),
      createdAt: now,
      updatedAt: now,
      memoryUpdatedAt: '',
    }
    list.push(agent)
    saveRegistry(list)
    return view(agent)
  }

  function updateAgent(input = {}) {
    const agent = requireAgent(input.id)
    const list = registry()
    const at = list.findIndex(item => item.id === agent.id)
    const now = soon()
    if (typeof input.name === 'string' && collapse(input.name) !== '') {
      list[at] = { ...list[at], name: collapse(input.name).slice(0, 80) }
    }
    if (typeof input.description === 'string') {
      list[at] = { ...list[at], description: collapse(input.description).slice(0, 400) }
    }
    list[at] = { ...list[at], updatedAt: now }
    saveRegistry(list)
    return view(list[at])
  }

  function deleteAgent(input = {}) {
    const agent = requireAgent(input.id)
    const list = registry().filter(item => item.id !== agent.id)
    saveRegistry(list)
    try {
      fs.rmSync(memoryFile(agent.id), { force: true })
      fs.rmSync(logFile(agent.id), { force: true })
    } catch {
      /* memory already gone */
    }
    let removedEntries = 0
    if (input.deleteKnowledge === true) {
      for (const entry of entries()) {
        if (entry.agent !== agent.id) continue
        try {
          fs.rmSync(path.join(knowledgeRoot(), `${entry.id}.md`), { force: true })
          removedEntries += 1
        } catch {
          /* already gone */
        }
      }
    }
    const current = settings()
    if (current.activeVault === agent.id) saveSettings({ activeVault: '' })
    const bindings = readBindings()
    let unbound = 0
    for (const sessionId of Object.keys(bindings.sessions)) {
      if (bindings.sessions[sessionId] !== agent.id) continue
      delete bindings.sessions[sessionId]
      unbound += 1
    }
    if (unbound > 0) saveBindings(bindings)
    return { removed: agent.id, knowledgeRemoved: removedEntries, unbound: unbound }
  }

  function saveSettings(patch = {}) {
    const current = settings()
    const next = { ...current }
    if (typeof patch.knowledgeDir === 'string') next.knowledgeDir = patch.knowledgeDir.trim()
    if (typeof patch.activeVault === 'string') next.activeVault = patch.activeVault
    if (typeof patch.hideBoundSessions === 'boolean') next.hideBoundSessions = patch.hideBoundSessions
    if (typeof patch.transcripts === 'boolean') next.transcripts = patch.transcripts
    if (typeof patch.sessionsRoot === 'string') next.sessionsRoot = patch.sessionsRoot.trim()
    if (next.activeVault !== '' && !registry().some(item => item.id === next.activeVault)) {
      next.activeVault = ''
    }
    writeAtomic(files.settings, `${JSON.stringify(next, null, 2)}\n`)
    return next
  }

  function writeMemory(input = {}) {
    const agent = requireAgent(input.id)
    const text = String(input.content ?? '').replace(/\r\n/g, '\n').trim()
    if (text.length > memoryLimit) {
      throw new MemoryError(
        'memory-too-long',
        `memory is ${text.length} characters; the limit is ${memoryLimit}. Compress it, keeping only what the next run must know.`,
      )
    }
    writeAtomic(memoryFile(agent.id), text === '' ? '' : `${text}\n`)
    const list = registry()
    const at = list.findIndex(item => item.id === agent.id)
    const now = soon()
    list[at] = { ...list[at], memoryUpdatedAt: now, updatedAt: now }
    saveRegistry(list)
    const note = collapse(input.note)
    const line = `\n## ${now}${note === '' ? '' : ` — ${note}`}\n\n${text === '' ? '(cleared)' : text}\n`
    try {
      fs.appendFileSync(logFile(agent.id), line, 'utf8')
    } catch {
      /* audit log is best effort */
    }
    return { id: agent.id, chars: text.length, updatedAt: now, limit: memoryLimit }
  }

  function listKnowledge(input = {}) {
    const filter = typeof input.id === 'string' && input.id !== '' ? requireAgent(input.id).id : ''
    const all = entries()
    return {
      knowledgeDir: knowledgeRoot(),
      shared: true,
      filter: filter,
      entries: all
        .filter(entry => filter === '' || entry.agent === filter)
        .map(entry => ({
          id: entry.id,
          title: entry.title,
          tags: entry.tags,
          agent: entry.agent,
          updated: entry.updated,
          snippet: snippet(entry.body),
        })),
      total: all.length,
    }
  }

  function searchKnowledge(input = {}) {
    const filter = typeof input.id === 'string' && input.id !== '' ? requireAgent(input.id).id : ''
    const query = collapse(input.query).toLowerCase()
    const tokens = query.split(' ').filter(token => token.length > 0)
    const limit = Math.min(Math.max(Number(input.limit) || 8, 1), 25)
    const ranked = entries()
      .filter(entry => filter === '' || entry.agent === filter)
      .map(entry => ({ entry, score: score(entry, tokens) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(item => ({
        id: item.entry.id,
        title: item.entry.title,
        tags: item.entry.tags,
        agent: item.entry.agent,
        updated: item.entry.updated,
        snippet: snippet(item.entry.body),
      }))
    return { query: query, total: ranked.length, shared: true, entries: ranked }
  }

  function readKnowledge(input = {}) {
    const entryId = String(input.entry ?? '')
    if (!ENTRY_ID.test(entryId)) throw new MemoryError('bad-entry', `invalid entry id: ${entryId || '(empty)'}`)
    const dir = knowledgeRoot()
    let raw
    try {
      raw = fs.readFileSync(path.join(dir, `${entryId}.md`), 'utf8')
    } catch {
      throw new MemoryError('no-entry', `no knowledge entry "${entryId}"`)
    }
    const entry = parseEntry(entryId, raw)
    return {
      id: entry.id,
      title: entry.title,
      tags: entry.tags,
      agent: entry.agent,
      created: entry.created,
      updated: entry.updated,
      content: entry.body.trim(),
    }
  }

  function saveKnowledge(input = {}) {
    const contributor = typeof input.id === 'string' && input.id !== '' ? requireAgent(input.id).id : ''
    const requested = typeof input.entry === 'string' && input.entry !== '' ? String(input.entry) : ''
    const content = String(input.content ?? '').replace(/\r\n/g, '\n').trim()
    if (content === '') throw new MemoryError('empty-entry', 'content must not be empty')
    if (content.length > entryLimit) {
      throw new MemoryError('entry-too-long', `content is ${content.length} characters; the limit is ${entryLimit}`)
    }
    const title = collapse(input.title) || collapse(content.split('\n')[0]).slice(0, 80) || 'Untitled'
    const tags = Array.isArray(input.tags)
      ? input.tags.map(item => collapse(item)).filter(Boolean).slice(0, 12)
      : collapse(input.tags).split(',').map(item => collapse(item)).filter(Boolean).slice(0, 12)
    const dir = knowledgeRoot()
    const existingEntries = entries()
    const existing = requested === '' ? undefined : existingEntries.find(item => item.id === requested)
    let entryId = requested
    let created = soon()
    if (existing) {
      created = existing.created || created
    } else if (requested === '') {
      const base = latin(title) || `note-${randomId()}`
      entryId = base
      const taken = new Set(existingEntries.map(item => item.id))
      let suffix = 2
      while (taken.has(entryId)) {
        entryId = `${base}-${suffix}`
        suffix += 1
      }
    }
    if (!ENTRY_ID.test(entryId)) throw new MemoryError('bad-entry', `invalid entry id: ${entryId}`)
    const updated = soon()
    const entry = {
      id: entryId,
      title: title.slice(0, 120),
      tags: tags,
      agent: contributor !== '' ? contributor : existing?.agent ?? '',
      created: created,
      updated: updated,
      source: collapse(input.source).slice(0, 120),
      body: content,
    }
    writeAtomic(path.join(dir, `${entryId}.md`), renderEntry(entry))
    return { entry: entryId, created: existing === undefined, updated: updated, title: entry.title, agent: entry.agent }
  }

  function deleteKnowledge(input = {}) {
    const entryId = String(input.entry ?? '')
    if (!ENTRY_ID.test(entryId)) throw new MemoryError('bad-entry', `invalid entry id: ${entryId || '(empty)'}`)
    const file = path.join(knowledgeRoot(), `${entryId}.md`)
    if (!fs.existsSync(file)) throw new MemoryError('no-entry', `no knowledge entry "${entryId}"`)
    fs.rmSync(file, { force: true })
    return { removed: entryId }
  }

  /** Resolve which agent a tool call or a UI action is about. */
  function resolveVault(input = {}) {
    const explicit = typeof input.id === 'string' ? input.id.trim() : ''
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
    const bound = sessionId === '' ? '' : bindingOf(sessionId)
    const current = settings()
    const wanted = explicit !== '' ? explicit : bound !== '' ? bound : current.activeVault
    if (wanted === '') {
      const names = registry().map(item => `${item.id} (${item.name})`).join(', ')
      throw new MemoryError(
        'no-active-vault',
        `no agent selected. Pass "id", or pick one in the Agents panel. Available: ${names || '(none created yet)'}`,
      )
    }
    return requireAgent(wanted)
  }

  return {
    root,
    files,
    memoryLimit,
    entryLimit,
    state,
    settings,
    knowledgeRoot,
    createAgent,
    updateAgent,
    deleteAgent,
    saveSettings,
    writeMemory,
    readMemory,
    memoryUpdatedAt,
    listKnowledge,
    searchKnowledge,
    readKnowledge,
    saveKnowledge,
    deleteKnowledge,
    /** Raw parsed entries, for the recall index; the tools use the views above. */
    allKnowledge: entries,
    resolveVault,
    bindingOf,
    setBinding,
    listBindings,
  }
}

export class MemoryError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MemoryError'
    this.code = code
  }
}
