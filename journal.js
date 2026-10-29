/**
 * Private journals: the detailed, diary-like record of one agent.
 *
 * One file per agent, append-only. A journal is deliberately *not* shared: the
 * tools always resolve the calling conversation's agent and never accept another
 * agent id, so an agent can only ever read or extend its own journal. The agent
 * decides when to consult it; nothing is injected automatically.
 *
 * Layout: <root>/journal/<agentId>.jsonl for ordinary notes and
 *         <root>/checkpoints/<agentId>.jsonl for checkpoints.
 *
 * The two kinds live in separate files because they have different jobs: a note
 * is recallable material, a checkpoint is authoritative state that is injected
 * whole and must never surface in a search result. Files written before 2.0 mix
 * both kinds; `splitCheckpoints` migrates one agent lazily on first touch.
 *
 * @module journal
 */

import fs from 'node:fs'
import path from 'node:path'

import { MemoryError } from './store.js'

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const ENTRY_ID = /^j-[a-z0-9]{4,16}$/
const MAX_TEXT = 20000

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, text, 'utf8')
  fs.renameSync(temp, file)
}

export function createJournals(options = {}) {
  const root = path.resolve(options.rootDir || '.')
  const dir = path.join(root, 'journal')
  const checkpointDir = path.join(root, 'checkpoints')

  function fileOf(agentId) {
    const key = String(agentId ?? '')
    if (!AGENT_ID.test(key)) throw new MemoryError('bad-vault', `invalid agent id: ${key || '(empty)'}`)
    return path.join(dir, `${key}.jsonl`)
  }

  function checkpointFileOf(agentId) {
    const key = String(agentId ?? '')
    if (!AGENT_ID.test(key)) throw new MemoryError('bad-vault', `invalid agent id: ${key || '(empty)'}`)
    return path.join(checkpointDir, `${key}.jsonl`)
  }

  /** Every well-formed entry of one file, in file order. */
  function parseFile(file) {
    let raw = ''
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      return []
    }
    const entries = []
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim()
      if (text === '') continue
      try {
        const entry = JSON.parse(text)
        if (entry !== null && typeof entry === 'object' && ENTRY_ID.test(String(entry.id ?? ''))) entries.push(entry)
      } catch {
        /* a torn line is skipped, never fatal */
      }
    }
    return entries
  }

  /**
   * Move checkpoints out of a pre-2.0 journal file. Idempotent: once the notes
   * file holds no checkpoint rows there is nothing left to do, so it costs one
   * string probe per touch.
   */
  function splitCheckpoints(agentId) {
    const notesFile = fileOf(agentId)
    let raw = ''
    try {
      raw = fs.readFileSync(notesFile, 'utf8')
    } catch {
      return
    }
    if (!raw.includes('"kind":"checkpoint"')) return
    const notes = []
    const checkpoints = []
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim()
      if (text === '') continue
      let kind = 'note'
      try {
        kind = JSON.parse(text)?.kind === 'checkpoint' ? 'checkpoint' : 'note'
      } catch {
        /* keep a torn line where it is */
      }
      ;(kind === 'checkpoint' ? checkpoints : notes).push(`${text}\n`)
    }
    if (checkpoints.length === 0) return
    const checkpointFile = checkpointFileOf(agentId)
    const existing = (() => {
      try {
        const text = fs.readFileSync(checkpointFile, 'utf8')
        return text === '' || text.endsWith('\n') ? text : `${text}\n`
      } catch {
        return ''
      }
    })()
    writeAtomic(checkpointFile, `${existing}${checkpoints.join('')}`)
    writeAtomic(notesFile, notes.join(''))
  }

  function readAll(agentId) {
    splitCheckpoints(agentId)
    const merged = [...parseFile(fileOf(agentId)), ...parseFile(checkpointFileOf(agentId))]
    // File order inside one file is append order; merging two files keeps the
    // same guarantee by sorting on the timestamp, ties keeping file order.
    return merged
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => {
        const left = String(a.entry.at ?? '')
        const right = String(b.entry.at ?? '')
        return left === right ? a.index - b.index : left < right ? -1 : 1
      })
      .map(item => item.entry)
  }

  function count(agentId) {
    try {
      return readAll(agentId).length
    } catch {
      return 0
    }
  }

  /** Timestamp of the latest ordinary entry, used by the handoff watcher. */
  function latestAt(agentId) {
    try {
      const all = readAll(agentId)
      for (let index = all.length - 1; index >= 0; index -= 1) {
        if ((all[index].kind ?? 'note') !== 'checkpoint') return all[index].at ?? ''
      }
      return ''
    } catch {
      return ''
    }
  }

  function list(input = {}) {
    const agentId = String(input.id ?? '')
    const query = collapse(input.query).toLowerCase()
    const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 100)
    const includeCheckpoints = input.includeCheckpoints === true
    const all = readAll(agentId)
    const scoped = includeCheckpoints ? all : all.filter(entry => (entry.kind ?? 'note') !== 'checkpoint')
    const matching =
      query === ''
        ? scoped
        : scoped.filter(entry => {
            const haystack = `${entry.title ?? ''}\n${entry.text ?? ''}`.toLowerCase()
            return query.split(' ').filter(Boolean).every(token => haystack.includes(token))
          })
    const entries = matching.slice(-limit).reverse()
    return {
      id: agentId,
      total: all.length,
      matching: matching.length,
      entries: entries.map(entry => ({
        id: entry.id,
        at: entry.at,
        kind: entry.kind ?? 'note',
        title: entry.title ?? '',
        preview: collapse(entry.text).slice(0, 160),
        meta: entry.meta ?? null,
      })),
    }
  }

  function read(input = {}) {
    const agentId = String(input.id ?? '')
    const entryId = String(input.entry ?? '')
    if (!ENTRY_ID.test(entryId)) throw new MemoryError('bad-entry', `invalid entry id: ${entryId || '(empty)'}`)
    const found = readAll(agentId).find(entry => entry.id === entryId)
    if (found === undefined) throw new MemoryError('no-entry', `no journal entry "${entryId}"`)
    return {
      id: found.id,
      at: found.at,
      kind: found.kind ?? 'note',
      title: found.title ?? '',
      text: found.text ?? '',
      meta: found.meta ?? null,
    }
  }

  function write(input = {}) {
    const agentId = String(input.id ?? '')
    const text = String(input.text ?? '').replace(/\r\n/g, '\n').trim()
    if (text === '') throw new MemoryError('empty-entry', 'journal text must not be empty')
    if (text.length > MAX_TEXT) {
      throw new MemoryError('entry-too-long', `journal entry is ${text.length} characters; the limit is ${MAX_TEXT}`)
    }
    const title = collapse(input.title).slice(0, 100) || collapse(text.split('\n')[0]).slice(0, 100)
    const kind = input.kind === 'checkpoint' ? 'checkpoint' : 'note'
    const entry = {
      id: `j-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`,
      at: new Date().toISOString(),
      kind,
      title,
      text,
    }
    if (input.meta !== undefined && input.meta !== null && typeof input.meta === 'object') {
      entry.meta = input.meta
    }
    splitCheckpoints(agentId)
    const target = kind === 'checkpoint' ? checkpointFileOf(agentId) : fileOf(agentId)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.appendFileSync(target, `${JSON.stringify(entry)}\n`, 'utf8')
    return { id: entry.id, at: entry.at, kind, title: entry.title, chars: text.length }
  }

  function remove(input = {}) {
    const agentId = String(input.id ?? '')
    const entryId = String(input.entry ?? '')
    if (!ENTRY_ID.test(entryId)) throw new MemoryError('bad-entry', `invalid entry id: ${entryId || '(empty)'}`)
    const all = readAll(agentId)
    const kept = all.filter(entry => entry.id !== entryId)
    if (kept.length === all.length) throw new MemoryError('no-entry', `no journal entry "${entryId}"`)
    const notes = kept.filter(entry => (entry.kind ?? 'note') !== 'checkpoint')
    const checkpoints = kept.filter(entry => (entry.kind ?? 'note') === 'checkpoint')
    writeAtomic(fileOf(agentId), notes.map(entry => `${JSON.stringify(entry)}\n`).join(''))
    if (checkpoints.length > 0 || fs.existsSync(checkpointFileOf(agentId))) {
      writeAtomic(checkpointFileOf(agentId), checkpoints.map(entry => `${JSON.stringify(entry)}\n`).join(''))
    }
    return { removed: entryId }
  }

  /** Full notes of one agent — the recallable half of a journal. */
  function notes(agentId) {
    return readAll(agentId).filter(entry => (entry.kind ?? 'note') !== 'checkpoint')
  }

  return { root, dir, checkpointDir, list, read, write, remove, count, latestAt, notes, fileOf, checkpointFileOf }
}
