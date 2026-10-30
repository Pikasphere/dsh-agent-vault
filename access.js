/**
 * Access counters behind the heat term in lexical ranking (docs §7.4).
 *
 * Two numbers are kept per entry: how often it was *opened* (the panel drew its
 * full record — an unambiguous read) and how often it merely *appeared* in a
 * result list. Exposure is worth a quarter of a read because it is not a signal
 * that the entry helped: the model saw a preview and moved on. Counting both is
 * what lets a genuinely useful old note age slower than a noisy recent one,
 * without letting the ranking feed on its own output too hard.
 *
 * Writes are debounced: a search triggers at most a few counter bumps, and an
 * atomic rewrite of a small JSON file per query would be a silly price to pay.
 */
import fs from 'node:fs'
import path from 'node:path'

const FILE = 'access.json'
const VERSION = 1
const FLUSH_MS = 2000
const MAX_KEYS = 5000
const KEEP_DAYS = 365

export function createAccess(options = {}) {
  const root = path.resolve(options.rootDir || '.')
  const file = options.file ?? path.join(root, 'index', FILE)
  const now = options.now ?? (() => Date.now())
  const flushMs = Number(options.flushMs ?? FLUSH_MS)

  let loaded = null
  let timer = null
  let dirty = false

  function load() {
    if (loaded !== null) return loaded
    loaded = { version: VERSION, entries: {} }
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') {
        for (const [key, value] of Object.entries(raw.entries)) {
          const opens = Number(value?.opens)
          const exposed = Number(value?.exposed)
          if (!Number.isFinite(opens) && !Number.isFinite(exposed)) continue
          loaded.entries[key] = {
            opens: Number.isFinite(opens) ? Math.max(0, Math.round(opens)) : 0,
            exposed: Number.isFinite(exposed) ? Math.max(0, Math.round(exposed)) : 0,
            ...(typeof value?.lastRead === 'string' ? { lastRead: value.lastRead } : {}),
            ...(typeof value?.lastExposed === 'string' ? { lastExposed: value.lastExposed } : {}),
          }
        }
      }
    } catch {
      // A missing or corrupt file is not an error: the counters are a nudge, and
      // the next flush rewrites them from zero.
      loaded = { version: VERSION, entries: {} }
    }
    return loaded
  }

  function stats(key) {
    return load().entries[String(key ?? '')] ?? null
  }

  function bump(key, kind) {
    const id = String(key ?? '')
    if (id === '') return null
    const db = load()
    const entry = db.entries[id] ?? { opens: 0, exposed: 0 }
    const stamp = new Date(now()).toISOString()
    if (kind === 'read') {
      entry.opens += 1
      entry.lastRead = stamp
    } else {
      entry.exposed += 1
      entry.lastExposed = stamp
    }
    db.entries[id] = entry
    dirty = true
    schedule()
    return entry
  }

  function record(key, kind = 'exposed') {
    return bump(key, kind === 'read' ? 'read' : 'exposed')
  }

  function schedule() {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      flush()
    }, flushMs)
    // The process may exit (a test, a CLI eval) before the debounce fires; the
    // counters are allowed to be lost, the handle must not keep Node alive.
    if (typeof timer.unref === 'function') timer.unref()
  }

  function prune(db) {
    const cutoff = now() - KEEP_DAYS * 86400000
    const rows = Object.entries(db.entries)
      .map(([key, value]) => {
        const parse = input => {
          const time = Date.parse(String(input ?? ''))
          return Number.isFinite(time) ? time : 0
        }
        return { key, value, last: Math.max(parse(value.lastRead), parse(value.lastExposed)) }
      })
      .filter(row => row.last === 0 || row.last >= cutoff)
      .sort((left, right) => right.last - left.last)
      .slice(0, MAX_KEYS)
    db.entries = Object.fromEntries(rows.map(row => [row.key, row.value]))
  }

  function flush() {
    if (!dirty) return file
    const db = load()
    prune(db)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, `${JSON.stringify(db, null, 2)}\n`, 'utf8')
      fs.renameSync(tmp, file)
      dirty = false
    } catch {
      // Read-only index directory: drop the pending writes rather than failing
      // the search that triggered them.
      dirty = false
    }
    return file
  }

  return { file, record, stats, flush, get size() { return Object.keys(load().entries).length } }
}
