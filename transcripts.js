// Conversation transcripts as a recall source (2.0.0-alpha.4).
// DSH appends one zstd frame per record to <sessions>/<workspace>/<session>/session.v4.jsonl.zstd.
// We only index sessions the vault already knows about (handoff checkpoints + current bindings),
// keep the user/assistant text (never tool results or reasoning), redact secrets, and cap volume.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { decompressFrames } from './zstd-frames.mjs'

export const SESSION_FILE = 'session.v4.jsonl.zstd'
export const MAX_CHARS = 12000
const HEAD_CHARS = 2000
// Small blocks are deliberate: the vector layer re-cuts every entry into ~420
// character rows, and a block whose content changes (the open tail block does,
// on every turn) re-embeds all of its rows. 1200 keeps one turn's re-embed to
// ~3 rows instead of ~18, while still being a readable snippet.
const CHUNK_CHARS = 1200

const SECRETS = [
  [/\bsk-[A-Za-z0-9]{16,}\b/g, '[redacted-key]'],
  [/\bghp_[A-Za-z0-9]{20,}\b/g, '[redacted-token]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted-token]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-key]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [redacted]'],
  [/((?:api[_-]?key|secret|passw(?:or)?d|access[_-]?token)\s*[:=]\s*['"]?)[^\s'"]{8,}/gi, '$1[redacted]'],
]

/** Mask credentials that would otherwise be duplicated into the index (and the panel). */
export function redact(text) {
  let out = text
  for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement)
  return out
}

function frameText(file) {
  return decompressFrames(fs.readFileSync(file), buffer => zstdDecompressSync(buffer)).toString('utf8')
}

/** Read one record list; tolerates truncated tails from a session that is still being written. */
export function readRecords(file) {
  const lines = frameText(file).split('\n')
  const records = []
  for (const line of lines) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // torn tail while the host appends — ignore just that record
    }
  }
  return records
}

function messageText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text.trim())
    .filter(Boolean)
    .join('\n')
}

function extract(records, sessionId) {
  let cwd = ''
  let title = ''
  let at = ''
  let toolCalls = 0
  const messages = []
  for (const record of records) {
    const time = typeof record.time === 'number' ? record.time : 0
    if (record.type === 'session') {
      cwd = typeof record.data?.cwd === 'string' ? record.data.cwd : record.cwd ?? ''
      continue
    }
    if (record.type === 'session/title') {
      if (record.data?.title) title = String(record.data.title)
      continue
    }
    if (record.type === 'tool/call') {
      toolCalls += 1
      continue
    }
    let role = ''
    let text = ''
    if (record.type === 'user/message') {
      role = 'user'
      text = messageText(record.data?.content)
    } else if (record.type === 'assistant/message') {
      role = 'assistant'
      text = messageText(record.data?.message?.content)
    } else {
      continue
    }
    if (text === '') continue
    if (time) at = time
    messages.push({ seq: typeof record.seq === 'number' ? record.seq : 0, role, at: time ? new Date(time).toISOString() : '', text: redact(text) })
  }
  const kept = trimMessages(messages)
  const lines = kept.messages.map(message => `${message.role === 'user' ? '用户' : '助手'}：${message.text}`)
  let body = lines.join('\n')
  if (kept.truncated) body = `${lines.slice(0, kept.headCount).join('\n')}\n……\n${lines.slice(kept.headCount).join('\n')}`
  const firstUser = lines.find(line => line.startsWith('用户：')) ?? ''
  return {
    sessionId,
    cwd,
    title: title || firstUser.slice(0, 60).replace(/^用户：/, '') || sessionId,
    at: at ? new Date(at).toISOString() : '',
    text: body,
    toolCalls,
    messages: kept.messages,
    truncated: kept.truncated,
  }
}

/**
 * Keep the head (the task) and the tail (where the work ended) inside the
 * character budget; the middle is dropped. The kept message list is what a hit
 * points at, so it must be the same subset the body is built from.
 */
function trimMessages(messages) {
  let total = 0
  for (const message of messages) total += message.text.length + 6
  if (total <= MAX_CHARS) return { messages, truncated: false, headCount: messages.length }
  const head = []
  let used = 0
  for (const message of messages) {
    const cost = message.text.length + 6
    if (used + cost > HEAD_CHARS) break
    head.push(message)
    used += cost
  }
  const tail = []
  const limit = MAX_CHARS - HEAD_CHARS - 8
  used = 0
  for (let index = messages.length - 1; index >= head.length; index -= 1) {
    const message = messages[index]
    const cost = message.text.length + 6
    if (used + cost > limit) break
    tail.unshift(message)
    used += cost
  }
  return { messages: [...head, ...tail], truncated: true, headCount: head.length }
}

/**
 * @param {{rootDir: string, store: {listBindings: () => {sessionId: string}[]}, sessionsRoot?: string}} options
 */
export function createTranscripts({ rootDir, store, sessionsRoot, exclude }) {
  const dir = typeof sessionsRoot === 'string' && sessionsRoot !== '' ? sessionsRoot : path.join(os.homedir(), '.dsh', 'sessions')
  const cache = new Map()
  const excluded = () => {
    let list = []
    try {
      list = typeof exclude === 'function' ? exclude() : exclude ?? []
    } catch {
      list = []
    }
    return new Set(Array.isArray(list) ? list.filter(item => typeof item === 'string' && item !== '') : [])
  }

  /**
   * Sessions the vault already knows, with the agents that own them: a session
   * enters an agent's recall only when that agent checkpointed or was bound to it.
   */
  function owners() {
    const map = new Map()
    const claim = (sessionId, agentId) => {
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (typeof agentId !== 'string' || agentId === '') return
      if (!map.has(sessionId)) map.set(sessionId, new Set())
      map.get(sessionId).add(agentId)
    }
    for (const sub of ['journal', 'checkpoints']) {
      const target = path.join(rootDir, sub)
      let names = []
      try {
        names = fs.readdirSync(target).filter(name => name.endsWith('.jsonl'))
      } catch {
        continue
      }
      for (const name of names) {
        const owner = name.replace(/\.jsonl$/, '')
        let raw = ''
        try {
          raw = fs.readFileSync(path.join(target, name), 'utf8')
        } catch {
          continue
        }
        for (const line of raw.split('\n')) {
          if (line.trim() === '') continue
          try {
            claim(JSON.parse(line)?.meta?.sessionId, owner)
          } catch {
            // ignore a broken line
          }
        }
      }
    }
    for (const binding of store.listBindings()) claim(binding?.sessionId, binding?.agentId)
    return map
  }

  function known() {
    return new Set(owners().keys())
  }

  function locate(sessionId) {
    let workspaces = []
    try {
      workspaces = fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory())
    } catch {
      return ''
    }
    for (const workspace of workspaces) {
      const file = path.join(dir, workspace.name, sessionId, SESSION_FILE)
      if (fs.existsSync(file)) return file
    }
    return ''
  }

  /** Full message list, cached on the same stamp the trimmed entry uses. */
  const allCache = new Map()
  function allOf(sessionId) {
    const file = locate(sessionId)
    if (file === '') return []
    let stamp = ''
    try {
      const stat = fs.statSync(file)
      stamp = `${stat.size}:${stat.mtimeMs}`
    } catch {
      return []
    }
    const cached = allCache.get(sessionId)
    if (cached !== undefined && cached.stamp === stamp) return cached.messages
    const messages = all(sessionId)
    allCache.set(sessionId, { stamp, messages })
    return messages
  }

  function entryOf(sessionId) {
    const file = locate(sessionId)
    if (file === '') return null
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      return null
    }
    const stamp = `${stat.size}:${stat.mtimeMs}`
    const cached = cache.get(sessionId)
    if (cached && cached.stamp === stamp) return cached.entry
    let entry = null
    try {
      entry = extract(readRecords(file), sessionId)
      if (entry.text.trim() === '') entry = null
    } catch {
      entry = null
    }
    const key = sessionId
    cache.set(key, { stamp, entry })
    return entry
  }

  /** Every readable session of this agent, with its indexed state, for the panel list. */
  function list(agentId = '') {
    const skip = excluded()
    const out = []
    for (const [sessionId, agents] of owners()) {
      if (agentId !== '' && !agents.has(agentId)) continue
      const entry = entryOf(sessionId)
      if (entry === null) continue
      out.push({
        sessionId: entry.sessionId,
        title: entry.title,
        at: entry.at,
        cwd: entry.cwd,
        chars: entry.text.length,
        toolCalls: entry.toolCalls,
        included: !skip.has(sessionId),
      })
    }
    return out.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  }

  /**
   * One session becomes several entries, one per ~6k characters of messages.
   * A single trimmed entry per session made the middle of a long conversation
   * invisible to recall (this session: 203k chars, only 5% indexed), and the
   * whole point of keeping the log is being able to search it later.
   */
  function chunkEntries(entry, messages) {
    if (messages.length === 0) {
      return [{
        id: entry.sessionId,
        src: 'session',
        at: entry.at,
        title: entry.title,
        tags: [],
        text: entry.text,
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        round: 0,
        span: messageSpan(entry.sessionId),
      }]
    }
    const chunks = []
    let bucket = []
    let chars = 0
    let round = 0
    const flush = () => {
      if (bucket.length === 0) return
      const first = bucket[0]
      const last = bucket[bucket.length - 1]
      chunks.push({
        id: `${entry.sessionId}#${first.seq}`,
        src: 'session',
        at: last.at,
        title: entry.title,
        tags: [],
        text: bucket.map(message => `${message.role === 'user' ? '用户' : '助手'}：${message.text}`).join(String.fromCharCode(10)),
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        round: first.round,
        span: [first.seq, last.seq],
      })
      bucket = []
      chars = 0
    }
    for (const message of messages) {
      if (message.role === 'user') round += 1
      bucket.push({ seq: message.seq, role: message.role, at: message.at, text: message.text, round })
      chars += message.text.length + 6
      if (chars >= CHUNK_CHARS) flush()
    }
    flush()
    return chunks
  }

  function messageSpan(sessionId) {
    const messages = allOf(sessionId)
    if (messages.length === 0) return []
    return [messages[0].seq, messages[messages.length - 1].seq]
  }

  /** Recall entries for the sessions this agent owns (`''` = every agent, for reindex). */
  function entries(agentId = '') {
    const skip = excluded()
    const out = []
    for (const [sessionId, agents] of owners()) {
      if (agentId !== '' && !agents.has(agentId)) continue
      if (skip.has(sessionId)) continue
      const entry = entryOf(sessionId)
      if (entry === null) continue
      out.push(...chunkEntries(entry, allOf(sessionId)))
    }
    return out
  }

  /** Every message of one session, so a chunk hit can point at any of them. */
  function messagesOf(sessionId) {
    return allOf(sessionId)
  }

  /** One session as a single trimmed entry (panel detail, not recall). */
  function get(sessionId) {
    const entry = entryOf(sessionId)
    if (entry === null) return null
    return {
      id: entry.sessionId,
      src: 'session',
      at: entry.at,
      title: entry.title,
      tags: [],
      text: entry.text,
      sessionId: entry.sessionId,
      cwd: entry.cwd,
    }
  }

  /**
   * Every user/assistant message of one session, untrimmed. The reader view
   * searches the whole conversation, so it cannot reuse the 12k recall excerpt.
   */
  function all(sessionId) {
    const file = locate(sessionId)
    if (file === '') return []
    let records = []
    try {
      records = readRecords(file)
    } catch {
      return []
    }
    const messages = []
    for (const record of records) {
      let role = ''
      let text = ''
      if (record.type === 'user/message') {
        role = 'user'
        text = messageText(record.data?.content)
      } else if (record.type === 'assistant/message') {
        role = 'assistant'
        text = messageText(record.data?.message?.content)
      } else {
        continue
      }
      if (text === '') continue
      const time = typeof record.time === 'number' ? record.time : 0
      messages.push({
        seq: typeof record.seq === 'number' ? record.seq : 0,
        role,
        at: time ? new Date(time).toISOString() : '',
        text: redact(text),
      })
    }
    return messages
  }

  /**
   * Read-only event ledger of one session: the record-type histogram plus any
   * compaction/summary records. Nothing is intercepted or rewritten — this is
   * what "accounting before takeover" needs to look at.
   */
  function ledger(sessionId) {
    const empty = {
      sessionId,
      available: false,
      records: 0,
      types: [],
      compactions: [],
      runs: [],
      stats: { attempts: 0, ok: 0, failed: 0, refused: 0, prunedCount: 0, prunedTokens: 0, prunedMax: 0, summaryChars: 0, peakRequestTokens: 0 },
    }
    const file = locate(sessionId)
    if (file === '') return empty
    let records = []
    try {
      records = readRecords(file)
    } catch {
      return empty
    }
    const counts = new Map()
    const compactions = []
    const runs = new Map()
    let prunedCount = 0
    let prunedTokens = 0
    let prunedMax = 0
    let peakRequestTokens = 0
    for (const record of records) {
      const type = typeof record.type === 'string' && record.type !== '' ? record.type : 'unknown'
      counts.set(type, (counts.get(type) ?? 0) + 1)
      if (!type.includes('compact') && !type.includes('summar')) continue
      const at = typeof record.time === 'number' ? new Date(record.time).toISOString() : ''
      const data = record.data ?? {}
      compactions.push({
        seq: typeof record.seq === 'number' ? record.seq : 0,
        at,
        type,
        preview: JSON.stringify(data).slice(0, 400),
      })
      if (type === 'compaction/prune') {
        const tokens = typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0
        prunedCount += 1
        prunedTokens += tokens
        prunedMax = Math.max(prunedMax, tokens)
        continue
      }
      const id = typeof data.compactionId === 'string' ? data.compactionId : ''
      if (id === '') continue
      if (!runs.has(id)) runs.set(id, { compactionId: id, turn: 0, startedAt: '', endedAt: '', durationMs: 0, ok: null, reason: '', summaryChars: 0 })
      const run = runs.get(id)
      if (type === 'compaction/start') {
        run.startedAt = at
        if (typeof data.turn === 'number') run.turn = data.turn
      } else if (type === 'compaction/end') {
        run.endedAt = at
        run.ok = typeof data.error === 'string' && data.error !== '' ? false : true
        if (run.ok === false) {
          const message = data.error
          run.reason = message.includes('refused by billion-context') ? 'refused-by-proxy' : message.slice(0, 200)
          for (const match of message.matchAll(/(\d{5,})/g)) {
            const tokens = Number(match[1])
            if (tokens > peakRequestTokens) peakRequestTokens = tokens
          }
        }
      } else if (type === 'compaction/summary') {
        const parts = Array.isArray(data.summary) ? data.summary : []
        run.summaryChars = parts.reduce((sum, part) => sum + (typeof part?.text === 'string' ? part.text.length : 0), 0)
      }
    }
    const ordered = [...runs.values()].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
    for (const run of ordered) {
      if (run.startedAt !== '' && run.endedAt !== '') run.durationMs = Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt))
    }
    const stats = {
      attempts: ordered.length,
      ok: ordered.filter(run => run.ok === true).length,
      failed: ordered.filter(run => run.ok === false).length,
      refused: ordered.filter(run => run.reason === 'refused-by-proxy').length,
      prunedCount,
      prunedTokens,
      prunedMax,
      summaryChars: ordered.reduce((sum, run) => sum + run.summaryChars, 0),
      peakRequestTokens,
    }
    const types = [...counts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
    return { sessionId, available: true, records: records.length, types, compactions, runs: ordered, stats }
  }

  return { root: dir, known, owners, entries, list, messagesOf, all, ledger, get, read: entryOf }
}
