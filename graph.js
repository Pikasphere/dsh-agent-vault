/**
 * One-hop graph expansion for recall (docs/memory-recall-v2.md §6.5).
 *
 * Lexical ranking only connects entries whose *surface* looks alike. Material
 * from one line of work often does not: "the vault plugin" and
 * `dsh-agent-vault` share no characters yet belong together. This module adds
 * the missing links as a post-pass over the lexical seeds.
 *
 * Three deliberate constraints:
 *   - edges are computed on every call and never stored. With a corpus this
 *     size (tens of entries) a full recompute costs milliseconds, and it makes
 *     `journal.delete` correct with no incremental bookkeeping;
 *   - only one hop. Two hops travel through hubs such as a common file name and
 *     the noise grows faster than the signal. When a model needs more depth it
 *     can call the tool again with a `why.hub` term, which stays visible;
 *   - entities are extracted by shape from a small whitelist, never edited by
 *     hand. A hand-maintained entity list is a maintenance tax nobody pays.
 *
 * @module graph
 */

import fs from 'node:fs'
import path from 'node:path'

import { round } from './rank.js'

export const EDGE = { ref: 0.9, entity: 0.6, session: 0.5 }
export const MIN_EDGE = 0.35
export const SEED_COUNT = 8
export const MAX_NEIGHBORS = 5
export const NEIGHBOR_FACTOR = 0.3

/**
 * Entity shapes, in the order they are applied. Everything is matched against
 * the raw text; normalisation happens afterwards.
 */
const WINDOWS_PATH = /[A-Za-z]:\\[^\s"'，。；）】]+/g
const UNIX_PATH = /(?:^|[\s"'（(])((?:\/[A-Za-z0-9_.-]+){2,})/g
const AGENT_ID = /\bagent-[a-z0-9]{4}\b/g
const JOURNAL_ID = /\bj-[a-z0-9]{4,16}\b/g
const FILE_NAME = /[\w-]+\.(?:js|mjs|md|json|yml|yaml|ts|py|exe|zst|svg)\b/g
const QUALIFIED_NAME = /\b[a-z_]+(?:\.[a-z_]+){1,}\b/g
/** Package / repo names: the hyphen is the rule, not a length threshold. */
const HYPHENATED = /\b[a-z0-9]+(?:-[a-z0-9]+){1,}\b/g

/** Words that appear everywhere; left in, they would fuse the graph into one blob. */
const GENERIC = new Set([
  'windows', 'linux', 'macos', 'node', 'json', 'jsonl', 'true', 'false', 'null',
  'undefined', 'http', 'https', 'localhost', 'readme', 'github', 'npm', 'git', 'main',
  'index', 'system', 'prompt', 'memory', 'deepseek', 'harness', 'dsh', 'test',
  'debug', 'right-click', 'round-trip',
])

const TRAILING = /[\s.,;:!?，。；：！？、）)】\]"'`]+$/

function normalize(value) {
  let text = String(value ?? '').trim().toLowerCase().replace(/\\/g, '/')
  text = text.replace(TRAILING, '')
  return text
}

function acceptable(key) {
  if (key.length < 3 || key.length > 64) return false
  if (/^[0-9]+$/.test(key)) return false
  if (!/[a-z\u4e00-\u9fff]/.test(key)) return false
  if (GENERIC.has(key)) return false
  return true
}

/** Entities a piece of text mentions. A `Set`, because an edge is binary. */
export function extractEntities(text) {
  const raw = String(text ?? '')
  const found = new Set()
  const push = value => {
    const key = normalize(value)
    if (acceptable(key)) found.add(key)
  }
  for (const match of raw.matchAll(WINDOWS_PATH)) push(match[0])
  for (const match of raw.matchAll(UNIX_PATH)) push(match[1])
  for (const match of raw.matchAll(AGENT_ID)) push(match[0])
  for (const match of raw.matchAll(JOURNAL_ID)) push(match[0])
  for (const match of raw.matchAll(FILE_NAME)) push(match[0])
  for (const match of raw.matchAll(QUALIFIED_NAME)) push(match[0])
  for (const match of raw.matchAll(HYPHENATED)) push(match[0])
  return found
}

/**
 * Globally unique key for an entry. Journal and knowledge ids are already unique
 * (`j-…`, slug), but log ids are positional within one agent's file (`m-3`), so a
 * log entry must carry its agent or two agents' entries collide in the vector
 * store — which silently re-embeds both on every query.
 */
export function entryKey(entry) {
  if (entry.src === 'log' && typeof entry.agent === 'string' && entry.agent !== '') {
    return `log:${entry.agent}:${entry.id}`
  }
  return `${entry.src}:${entry.id}`
}

/** A cited id has to look like one: long enough, and not a plain word. */
function citableId(id) {
  const text = String(id ?? '')
  return text.length >= 6 && /^[a-z0-9][a-z0-9_-]+$/i.test(text) && (text.includes('-') || /[0-9]/.test(text))
}

function cites(entry, other) {
  const id = String(other.id ?? '')
  if (!citableId(id)) return false
  if (entryKey(entry) === entryKey(other)) return false
  return String(entry.text ?? '').toLowerCase().includes(id.toLowerCase())
}

/**
 * The strongest edge between two entries, or `null`.
 *
 * Precedence is by weight: a citation (0.9) beats a shared entity (up to 0.6),
 * which beats a shared session (0.5).
 */
export function edgeBetween(left, right, options = {}) {
  if (!left || !right || entryKey(left) === entryKey(right)) return null
  const rarity = options.rarity ?? (() => 1)
  if (cites(left, right) || cites(right, left)) {
    const cited = cites(left, right) ? right.id : left.id
    return { edge: 'ref', weight: EDGE.ref, hub: cited }
  }
  const shared = [...(left.entities ?? [])].filter(item => (right.entities ?? new Set()).has(item))
  if (shared.length > 0) {
    const hub = shared.sort((a, b) => b.length - a.length || (a < b ? -1 : 1))[0]
    // One shared identifier already says something; two or more saturate. A
    // straight `shared / 2` would put a single shared entity at 0.3 and below
    // the edge floor, which kills the most common bridge of all.
    const base = EDGE.entity * Math.min(1, 0.5 + shared.length / 4)
    // An entity half the corpus mentions (`dsh-agent-vault` in a vault repo)
    // links everything to everything; damping by document frequency is what
    // keeps "shared entity" a signal instead of a tautology.
    return { edge: 'entity', weight: base * rarity(hub), hub }
  }
  const session = String(left.sessionId ?? '')
  if (session !== '' && session === String(right.sessionId ?? '')) {
    return { edge: 'session', weight: EDGE.session, hub: session }
  }
  return null
}

/**
 * `seeds` are `{entry, score}` rows. Returns `{entry, score, via, why}` extras:
 * neighbours of a seed, ranked by `seed.score × edgeWeight × 0.3`, best edge
 * per neighbour, already-seeded entries excluded.
 */
export function expand(seeds, entries, options = {}) {
  const max = Number(options.maxNeighbors) || MAX_NEIGHBORS
  const minWeight = Number(options.minWeight) || MIN_EDGE
  const factor = Number(options.factor) || NEIGHBOR_FACTOR
  const seeded = new Set(seeds.map(row => entryKey(row.entry)))
  const df = new Map()
  for (const entry of entries) {
    for (const entity of entry.entities ?? []) df.set(entity, (df.get(entity) ?? 0) + 1)
  }
  // An entity shared by a handful of entries is a real bridge; one that half the
  // corpus repeats (`agent-memory` in a memory plugin) links everything to
  // everything, so its weight fades with document frequency.
  const rarity = entity => {
    const n = df.get(entity) ?? 1
    if (n <= 3) return 1
    return Math.max(0, 1 - (n - 3) / 4)
  }
  const best = new Map()
  for (const seed of seeds) {
    for (const entry of entries) {
      const key = entryKey(entry)
      if (seeded.has(key)) continue
      const edge = edgeBetween(seed.entry, entry, { rarity })
      if (edge === null || edge.weight < minWeight) continue
      const score = seed.score * edge.weight * factor
      const known = best.get(key)
      if (known === undefined || score > known.score) {
        best.set(key, {
          entry,
          score,
          via: edge.edge,
          why: { hub: edge.hub, edge: edge.edge, weight: round(edge.weight, 2) },
        })
      }
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, max)
}

/**
 * `<memoryDir>/index/aliases.json` — `{"alias": ["target", …]}`.
 *
 * Chinese recall benefits more from aliases than from edges, and an alias is
 * one line of JSON away, so the map is reloaded whenever the file's mtime
 * changes rather than at startup.
 */
export function createAliases(options = {}) {
  const root = path.resolve(options.rootDir || '.')
  const file = path.join(root, 'index', 'aliases.json')
  let cached = { mtimeMs: -1, items: [] }

  function read() {
    let stat = null
    try {
      stat = fs.statSync(file)
    } catch {
      return []
    }
    if (stat.mtimeMs === cached.mtimeMs) return cached.items
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const items = []
      for (const [key, value] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
        if (Array.isArray(value)) {
          for (const target of value) {
            const text = normalize(target)
            if (text !== '') items.push({ key: normalize(key), target: text })
          }
        }
      }
      cached = { mtimeMs: stat.mtimeMs, items }
      return items
    } catch {
      return []
    }
  }

  /** Alias rows whose key appears in the query. */
  function expandQuery(query) {
    const text = String(query ?? '').toLowerCase()
    if (text.trim() === '') return []
    return read().filter(item => item.key !== '' && text.includes(item.key))
  }

  /** Create an empty map once, so the file is discoverable and editable. */
  function ensure() {
    if (fs.existsSync(file)) return file
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, '{}\n', 'utf8')
    fs.renameSync(temp, file)
    return file
  }

  /** The raw table, normalised: `{ key: [target, ...] }`, empties dropped. */
  function map() {
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return {}
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out = {}
    for (const [key, value] of Object.entries(raw)) {
      const name = String(key).trim()
      if (name === '') continue
      const targets = Array.isArray(value) ? value : [value]
      const clean = [
        ...new Set(targets.map(item => (typeof item === 'string' ? item.trim() : '')).filter(item => item !== '')),
      ]
      if (clean.length > 0) out[name] = clean
    }
    return out
  }

  function save(next) {
    ensure()
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}
`, 'utf8')
    fs.renameSync(temp, file)
    cached = { mtimeMs: -1, items: [] }
    return next
  }

  /** Add or replace one key. An empty target list removes the key. */
  function set(key, targets) {
    const name = String(key ?? '').trim()
    if (name === '') throw new Error('an alias key is required')
    const list = Array.isArray(targets) ? targets : targets === undefined ? [] : [targets]
    const clean = [...new Set(list.map(item => (typeof item === 'string' ? item.trim() : '')).filter(item => item !== ''))]
    const next = map()
    if (clean.length === 0) delete next[name]
    else next[name] = clean
    save(next)
    return { key: name, targets: clean }
  }

  function remove(key) {
    const name = String(key ?? '').trim()
    const next = map()
    if (name === '' || next[name] === undefined) return false
    delete next[name]
    save(next)
    return true
  }

  return { file, read, expandQuery, ensure, map, set, remove }
}
