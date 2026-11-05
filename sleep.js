// Voluntary early compaction ("sleep").
//
// The host already compacts on its own, but only when the request is close to the
// window — by then generation quality has already degraded for several turns, and
// a session that overshoots far enough cannot even be summarised (that is exactly
// how this conversation once reached 1.9M tokens against a 1M window).
//
// This module does not replace the host implementation. It watches the token
// meter at turn boundaries and asks the public `compaction` service for a
// balanced reduction earlier than the host would. Every attempt is accounted to
// index/compaction.jsonl so the threshold can be tuned against real data.

import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

export const SLEEP_DEFAULTS = Object.freeze({
  enabled: false,
  // Hard threshold: ask the host for its own balanced reduction.
  triggerTokens: 400000,
  // Target size of one tail slice, and how much recent work never to touch.
  // Bigger slices amortise the cache re-pay: at 20k a fold freed ~3k of what
  // the model actually reads and cost ~1k of cache miss, a wash within a turn.
  chunkTokens: 60000,
  keepRecent: 8,
  // Below this a fold costs more (one summary call + a cache re-pay) than it
  // saves, so small slices wait for the next idle.
  minFoldTokens: 5000,
  // Estimated model-visible tokens a slice must free before it is worth
  // folding. Measured 2026-11-05: a 33k-token slice usually frees only ~3k of
  // what the model actually reads (tool results are already pruned to ~5k
  // chars), and the fold costs a full prompt-cache miss — so small slices are
  // a net loss.
  minSavedTokens: 3000,
  // 'host' asks the compaction service (unreachable from a profile plugin);
  // 'shelve' archives the slice into the agent's journal and replaces it with
  // a pointer stub, which needs no service and cannot fail on size.
  mode: 'host',
  // One idle can fold several slices: a single 30k slice cannot keep up with a
  // session that grows faster than the cooldown.
  maxSlices: 3,
  // Above the hard threshold one slice should be BIG: many small slices cannot
  // catch up with a session that keeps growing, and the cache is lost anyway.
  bigChunkTokens: 200000,
  // Continuous mode: fold on every idle until the session is back under this
  // many tokens, instead of waiting for the soft threshold to be crossed.
  // 0 disables it. This is what keeps a long session from ever approaching the
  // window — the folds are small and near the tail, so the cache survives.
  keepUnder: 0,
  // Fold on every idle with no size target at all: whatever is past the
  // recent-working-set window gets archived, so the context never accumulates
  // between turns. `keepRecent` is the only thing that stays in the window.
  foldEveryTurn: false,
  // When the host compaction service is unreachable (it lives in the preset's
  // isolate scope), fall back to memory-backed slices instead of doing nothing.
  fallbackShelve: true,
  cooldownMs: 10 * 60 * 1000,
})

/** The compaction service is asked for `context-overflow`: the documented way to
 *  request a useful balanced reduction below the implementation's own threshold. */
export const SLEEP_TRIGGER = 'context-overflow'

export function createSleep({ ctx, store, journals, measureTokens, recordError = () => {} }) {
  const logFile = path.join(store.root, 'index', 'compaction.jsonl')
  const inFlight = new Set()
  const lastAttempt = new Map()
  const lastProbe = new Map()

  function settings() {
    let raw = {}
    try {
      const all = store.settings()
      if (all && typeof all.sleep === 'object' && all.sleep !== null) raw = all.sleep
    } catch {
      raw = {}
    }
    const trigger = Number(raw.triggerTokens)
    const cooldown = Number(raw.cooldownMs)
    const chunk = Number(raw.chunkTokens)
    const keep = Number(raw.keepRecent)
    const under = Number(raw.keepUnder)
    const minFold = Number(raw.minFoldTokens)
    const minSaved = Number(raw.minSavedTokens)
    const maxSlices = Number(raw.maxSlices)
    const bigChunk = Number(raw.bigChunkTokens)
    return {
      enabled: raw.enabled === true,
      debug: raw.debug === true,
      triggerTokens: Number.isFinite(trigger) && trigger > 0 ? Math.trunc(trigger) : SLEEP_DEFAULTS.triggerTokens,
      chunkTokens: Number.isFinite(chunk) && chunk >= 2000 ? Math.trunc(chunk) : SLEEP_DEFAULTS.chunkTokens,
      keepRecent: Number.isFinite(keep) && keep >= 2 ? Math.trunc(keep) : SLEEP_DEFAULTS.keepRecent,
      keepUnder: Number.isFinite(under) && under > 0 ? Math.trunc(under) : SLEEP_DEFAULTS.keepUnder,
      foldEveryTurn: raw.foldEveryTurn === true,
      minFoldTokens: Number.isFinite(minFold) && minFold > 0 ? Math.trunc(minFold) : SLEEP_DEFAULTS.minFoldTokens,
      minSavedTokens: Number.isFinite(minSaved) && minSaved >= 0 ? Math.trunc(minSaved) : SLEEP_DEFAULTS.minSavedTokens,
      mode: raw.mode === 'shelve' ? 'shelve' : raw.mode === 'host' ? 'host' : SLEEP_DEFAULTS.mode,
      maxSlices: Number.isFinite(maxSlices) && maxSlices >= 1 ? Math.min(Math.trunc(maxSlices), 8) : SLEEP_DEFAULTS.maxSlices,
      bigChunkTokens: Number.isFinite(bigChunk) && bigChunk >= 5000 ? Math.trunc(bigChunk) : SLEEP_DEFAULTS.bigChunkTokens,
      fallbackShelve: raw.fallbackShelve !== false,
      cooldownMs: Number.isFinite(cooldown) && cooldown >= 0 ? Math.trunc(cooldown) : SLEEP_DEFAULTS.cooldownMs,
    }
  }

  function record(entry) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true })
      fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
      return true
    } catch (error) {
      recordError(store, 'sleep/record', error)
      return false
    }
  }

  /**
   * Where the last fold started, per session. bili sweeps orphans only at or
   * after this mark ("cache-neutrally") because rewriting anything before it
   * re-bills the still-cached prefix; we use the same rule to pick slices.
   */
  function watermarkFile() {
    return path.join(store.root, 'index', 'sleep.json')
  }

  function watermarks() {
    try {
      const parsed = JSON.parse(fs.readFileSync(watermarkFile(), 'utf8'))
      return parsed !== null && typeof parsed === 'object' && typeof parsed.foldStartSeq === 'object' ? parsed.foldStartSeq : {}
    } catch {
      return {}
    }
  }

  function foldStartOf(sessionId) {
    const value = watermarks()[sessionId]
    return Number.isFinite(value) ? value : null
  }

  function setFoldStart(sessionId, seq) {
    if (!Number.isFinite(seq)) return
    try {
      const table = { ...watermarks(), [sessionId]: seq }
      fs.mkdirSync(path.dirname(watermarkFile()), { recursive: true })
      const tmp = `${watermarkFile()}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, foldStartSeq: table }, null, 2))
      fs.renameSync(tmp, watermarkFile())
    } catch (error) {
      recordError(store, 'sleep/watermark', error)
    }
  }

  /** One line per idle when `sleep.debug` is on: where the decision stopped. */
  function probe(sessionId, detail) {
    if (!settings().debug) return
    record({
      at: new Date().toISOString(),
      sessionId,
      kind: 'probe',
      ...detail,
    })
  }

  function sessionOf(sessionId) {
    try {
      const sessions = ctx.get('sessions')
      if (sessions === undefined || typeof sessions.get !== 'function') return null
      return sessions.get(sessionId) ?? null
    } catch {
      return null
    }
  }

  function optionsOf(session) {
    try {
      const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined
      const config = header?.config ?? {}
      return {
        provider: typeof config.provider === 'string' ? config.provider : undefined,
        model: typeof config.model === 'string' ? config.model : undefined,
      }
    } catch {
      return {}
    }
  }

  /** Cost of one surface node, in characters of its serialized event. */
  function nodeCost(session, seq) {
    try {
      const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : undefined
      return JSON.stringify(event?.data ?? {}).length
    } catch {
      return 0
    }
  }

  /** What the model actually reads for one node: tool results are pruned to a
   *  head and tail before they reach the prompt, so their raw size overstates
   *  the saving by an order of magnitude. */
  const PRUNED_TOOL_CHARS = 5120

  function visibleChars(session, seq) {
    const chars = nodeCost(session, seq)
    return nodeType(session, seq) === 'tool/result' ? Math.min(chars, PRUNED_TOOL_CHARS) : chars
  }

  /** Tokens a slice is expected to free, in the same units `measureTokens` uses. */
  function estimateSavedTokens(session, seqs) {
    let chars = 0
    for (const seq of seqs) chars += visibleChars(session, seq)
    // The stub that replaces the slice is ~100 CJK characters.
    return Math.max(0, Math.round(chars / 3) - 40)
  }

  function nodeType(session, seq) {
    try {
      const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : undefined
      return String(event?.type ?? '')
    } catch {
      return ''
    }
  }

  /** Tool-call ids carried by one surface node (only assistant messages carry them). */
  function toolCallIds(session, seq) {
    try {
      const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : undefined
      if (event?.type !== 'assistant/message') return []
      const content = event?.data?.message?.content
      if (!Array.isArray(content)) return []
      return content
        .filter(block => block !== null && typeof block === 'object' && block.type === 'tool-call' && typeof block.id === 'string' && block.id !== '')
        .map(block => block.id)
    } catch {
      return []
    }
  }

  /** Call id a tool/result node answers, or '' when the log does not record it. */
  function resultCallIds(session, seq) {
    try {
      const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : undefined
      if (event?.type !== 'tool/result') return []
      const id = event?.data?.message?.toolCallId
      return typeof id === 'string' && id !== '' ? [id] : []
    } catch {
      return []
    }
  }

  /**
   * Would folding this slice leave a call without its result (or the reverse)?
   * Deletions are the only thing that can break pairing: both nodes stay if
   * both are kept, both vanish if both are folded. So compare membership —
   * never trust the slice's edges to be the only place a pair can be cut.
   *
   * This is the guard that was missing when a fold of 16558–16579 dropped an
   * assistant message at 16580 whose call the provider still expected: the
   * session loaded fine and only the next request died with "tool result has
   * no matching call".
   */
  function pairingProblem(session, slice) {
    const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []
    if (nodes.length === 0) return null
    const removed = new Set(slice)
    const callAt = new Map()
    const resultAt = new Map()
    for (const seq of nodes) {
      for (const id of toolCallIds(session, seq)) callAt.set(id, seq)
      for (const id of resultCallIds(session, seq)) resultAt.set(id, seq)
    }
    for (const [id, resultSeq] of resultAt) {
      const callSeq = callAt.get(id)
      // A pair that was already broken before this fold is not ours to judge.
      if (callSeq === undefined) continue
      const callRemoved = removed.has(callSeq)
      const resultRemoved = removed.has(resultSeq)
      if (callRemoved === resultRemoved) continue
      return callRemoved
        ? `call ${id} (seq ${callSeq}) would be folded while its result (seq ${resultSeq}) stays`
        : `result ${id} (seq ${resultSeq}) would be folded while its call (seq ${callSeq}) stays`
    }
    return null
  }

  /**
   * Pick a slice near the tail, leaving the recent working set alone. Position
   * matters more than size: replacing a span at P invalidates every cached
   * prefix after P, so folding near the tail keeps the re-pay small, while
   * folding the oldest span (what the host does on pressure) re-bills almost
   * the whole conversation.
   */
  function selectSpan(session, chunkTokens, keepRecent, minFoldTokens, watermark) {
    const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []
    if (nodes.length <= keepRecent + 2) return null
    const budgetChars = Math.max(2000, Math.trunc(chunkTokens) * 3)
    let endIndex = nodes.length - 1 - keepRecent
    let startIndex = endIndex
    let cost = nodeCost(session, nodes[endIndex])
    while (startIndex > 0 && cost < budgetChars) {
      startIndex -= 1
      cost += nodeCost(session, nodes[startIndex])
    }
    // Never split a tool call from its results. A span may not start on a
    // result, and it may not end on a node that still owes results — a
    // tool/result, or an assistant message carrying tool calls. Cutting such a
    // pair replaces the call but leaves its result in the surface; the log then
    // loads fine and only the *next* model request dies, far away from here:
    // "DeepSeek Messages tool result has no matching call".
    while (startIndex <= endIndex && nodeType(session, nodes[startIndex]) === 'tool/result') startIndex += 1
    while (endIndex >= startIndex && (nodeType(session, nodes[endIndex]) === 'tool/result' || toolCallIds(session, nodes[endIndex]).length > 0)) endIndex -= 1
    if (endIndex - startIndex < 1) return null
    const start = nodes[startIndex]
    // Never rewrite at or before the last fold: that prefix is still cached and
    // replacing it would re-bill everything after it for no gain. Clamp the
    // start forward instead of giving up — the tail past the watermark is new
    // material and stays foldable even when the budget reaches further back.
    let startSeq = start
    let startAt = startIndex
    if (watermark !== null) {
      const markAt = nodes.indexOf(watermark)
      if (markAt >= 0) {
        if (startAt <= markAt) startAt = markAt + 1
      } else {
        while (startAt <= endIndex && nodes[startAt] <= watermark) startAt += 1
      }
      if (startAt > endIndex) return null
    }
    if (cost < Math.max(2000, Math.trunc(minFoldTokens) * 3)) return null
    // Surface POSITION is the unit the host uses: after a replacement the visible
    // seqs stop being monotonic, so a span is an index slice and its
    // sourceEventSeqs are exactly those nodes in surface order. Filtering by
    // numeric seq (the first implementation) dropped nodes the host still
    // considered "inside" the span and got the replacement refused.
    const startIndexFinal = startAt
    let seqs = nodes.slice(startIndexFinal, endIndex + 1)
    // Shrink rather than refuse: dropping from the tail keeps the (watermark
    // clamped) start, and the loop always terminates because the slice shrinks.
    let cut = null
    while (seqs.length >= 2) {
      const problem = pairingProblem(session, seqs)
      if (problem === null) {
        cut = null
        break
      }
      cut = problem
      seqs = seqs.slice(0, -1)
    }
    if (seqs.length < 2) return null
    return {
      start: seqs[0],
      end: seqs[seqs.length - 1],
      nodes: seqs.length,
      chars: cost,
      seqs,
    }
  }

  /**
   * Ask for one compaction: a tail fold when the session is above the keep-under
   * target (or on every turn), or the host's balanced reduction above the hard
   * host's balanced reduction above the hard one. Returns null when nothing was
   * attempted, or `{ attempted, kind, result }` so callers can tell "below
   * threshold" from "the service declined".
   */
  /**
   * The compaction service lives inside the agent preset's isolate scope, so a
   * profile-level plugin cannot see it through `ctx.get('compaction')`. The
   * agent object handed to us by a scoped event carries its own context, and
   * `agentPresets.serviceFor` resolves a service for that agent — try those
   * before concluding the service is unreachable.
   */
  function resolveCompaction(agent) {
    const tried = []
    const pick = (candidate, name) => {
      tried.push(name)
      try {
        if (candidate !== undefined && candidate !== null && typeof candidate === 'object' && typeof candidate.get === 'function') {
          const service = candidate.get('compaction')
          if (service !== undefined && service !== null) return service
        }
      } catch {
        /* not visible from this scope */
      }
      return undefined
    }
    const direct = pick(agent?.ctx, 'agent.ctx')
    if (direct !== undefined) return { service: direct, source: 'agent.ctx', tried }
    try {
      const presets = ctx.get('agentPresets')
      if (presets !== undefined && presets !== null && typeof presets.serviceFor === 'function' && agent !== undefined && agent !== null) {
        tried.push('agentPresets.serviceFor')
        const resolved = presets.serviceFor(agent, 'compaction')
        if (resolved !== undefined && resolved !== null) return { service: resolved, source: 'agentPresets', tried }
      }
    } catch {
      /* keep trying */
    }
    const scoped = pick(ctx, 'ctx')
    if (scoped !== undefined) return { service: scoped, source: 'root', tried }
    try {
      const root = ctx.root ?? ctx.scope ?? null
      if (root !== null) {
        const fromRoot = pick(root, 'ctx.root')
        if (fromRoot !== undefined) return { service: fromRoot, source: 'ctx.root', tried }
      }
    } catch {
      /* keep trying */
    }
    return { service: undefined, source: tried, tried }
  }

  /**
   * Memory-backed compaction: archive the slice into the agent's journal first,
   * then replace it in the session with a pointer stub.
   *
   * This is the answer to "压不住": the replacement is a few hundred characters
   * of text that we already have — no summarizer call, no token ceiling, so it
   * cannot fail because the payload is too large (the failure that killed the
   * 1.9M-token session). The archive is written before the surface changes, so
   * an interrupted run leaves the history untouched rather than half-lost.
   */
  function shelveMessages(session, span, agentId, sessionId, seqs) {
    const parts = []
    for (const seq of seqs) {
      const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : undefined
      const text = eventText(event)
      if (text !== '') parts.push(`[#${seq}] ${text}`)
    }
    const body = parts.join(String.fromCharCode(10) + String.fromCharCode(10))
    if (body === '') return null
    const CHUNK = 15000
    const written = []
    for (let offset = 0; offset < body.length; offset += CHUNK) {
      const slice = body.slice(offset, offset + CHUNK)
      const part = Math.floor(offset / CHUNK) + 1
      const total = Math.ceil(body.length / CHUNK)
      written.push(
        journals.write({
          id: agentId,
          kind: 'note',
          title: `${total > 1 ? `归档(${part}/${total}) ` : '归档 '}${sessionId.slice(0, 12)} seq ${span.start}-${span.end}`,
          text: slice,
          meta: { sessionId, span: { start: span.start, end: span.end }, part, total, archive: true },
        }),
      )
    }
    return written
  }

  function nodesBetween(session, start, end) {
    const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []
    return nodes.filter(seq => seq >= start && seq <= end)
  }

  function eventText(event) {
    const data = event?.data ?? {}
    if (event?.type === 'user/message') return blocksText(data.content)
    if (event?.type === 'assistant/message') return blocksText(data?.message?.content)
    if (event?.type === 'tool/result') return blocksText(data?.message?.content)
    return ''
  }

  function blocksText(content) {
    if (!Array.isArray(content)) return ''
    const parts = []
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      else if (block.type === 'tool-call') parts.push(`(call ${block.name ?? ''} ${String(block.arguments ?? '').slice(0, 400)})`)
    }
    return parts.join(String.fromCharCode(10)).trim()
  }

  /** Deterministic marker for one (session, slice) pair, so a retry can see it. */
  function spanStamp(sessionId, seqs) {
    return createHash('sha256').update(`${sessionId}:${seqs.join(',')}`).digest('hex').slice(0, 12)
  }

  /**
   * Has this exact slice already been replaced? A retry that appends a second
   * stub for the same span would archive it twice and — worse — replace nodes
   * that are no longer there. Check the durable log, not our own bookkeeping:
   * the log is what survived the crash.
   */
  function alreadyShelved(session, stamp) {
    let events = []
    try {
      if (typeof session?.snapshotEvents === 'function') events = session.snapshotEvents()
      else if (typeof session?.ownEvents === 'function') events = session.ownEvents()
      else if (typeof session?.eventAt === 'function') events = []
    } catch {
      events = []
    }
    const needle = `#am-${stamp}`
    for (const event of events) {
      if (event?.type !== 'user/message') continue
      const content = event?.data?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' && block.text.includes(needle)) return true
      }
    }
    return false
  }

  async function shelve(sessionId, agent, config) {
    const agentId = store.bindingOf(sessionId) || ''
    if (agentId === '') return { attempted: false, why: 'no-agent' }
    const session = sessionOf(sessionId)
    if (session === null) return { attempted: false, why: 'no-session' }
    const tokensBefore = measureTokens(sessionId)
    // A "deep" fold deliberately ignores the watermark: it is the cache-breaking
    // big compression, run rarely, and it must reach back past earlier folds or
    // the backlog can never come down.
    const span = selectSpan(
      session,
      config.chunkTokens,
      config.keepRecent,
      config.minFoldTokens,
      config.deep === true ? null : foldStartOf(sessionId),
    )
    if (span === null) return { attempted: false, why: 'no-span' }
    const startedAt = Date.now()
    const seqs = Array.isArray(span.seqs) ? span.seqs : nodesBetween(session, span.start, span.end)
    const estimatedSavedTokens = estimateSavedTokens(session, seqs)
    if (config.minSavedTokens > 0 && estimatedSavedTokens < config.minSavedTokens) {
      record({
        at: new Date().toISOString(),
        kind: 'skip',
        why: 'low-gain',
        sessionId,
        estimatedSavedTokens,
        span: { start: span.start, end: span.end, nodes: span.nodes },
      })
      return { attempted: false, why: 'low-gain', estimatedSavedTokens }
    }
    const stamp = spanStamp(sessionId, seqs)
    if (alreadyShelved(session, stamp)) {
      record({ at: new Date().toISOString(), kind: 'shelve', ok: true, skipped: 'duplicate', sessionId, stage: 'duplicate', span: { start: span.start, end: span.end, nodes: span.nodes } })
      return { attempted: false, why: 'duplicate' }
    }
    // Only a hard fold is archived into the journal. A small fold is a cache
    // move, not a memory: the raw events stay in the session log, which the
    // session index covers end to end, so writing every slice into the journal
    // would only pollute it (1,133 such notes by 2026-11-05) and duplicate what
    // `agent_recall` can already reach.
    const archive = config.archive !== false
    let written = null
    if (archive) {
      try {
        written = shelveMessages(session, span, agentId, sessionId, seqs)
      } catch (error) {
        record({ at: new Date().toISOString(), kind: 'shelve', ok: false, sessionId, stage: 'journal', error: String(error?.message ?? error).slice(0, 300) })
        return { attempted: true, ok: false }
      }
      if (written === null || written.length === 0) return { attempted: false, why: 'empty' }
    }
    const ids = written === null ? [] : written.map(item => item.id)
    const stub = archive
      ? `【已归档】第 ${span.start}–${span.end} 段（${span.nodes} 个节点）已存入记忆：${ids.join('、')}。要原始细节请用 agent_recall 检索这些编号或关键词；不要凭印象补写。 #am-${stamp}`
      : `【已折叠】第 ${span.start}–${span.end} 段（${span.nodes} 个节点）已移出上下文。原文仍在会话 ${sessionId} 的 seq ${span.start}–${span.end}，需要细节时用 agent_recall 的 session 来源检索，不要凭印象补写。 #am-${stamp}`
    try {
      session.append(
        'user/message',
        // Session format v4 admits one identified message with a
        // producer-owned source in every durable message slot. The host's
        // append path does not fill these in: without them the write succeeds
        // and the log only fails later, at load ("format v4 message requires a
        // producer-owned source kind" / "lacks an identified message").
        {
          id: randomUUID(),
          role: 'user',
          // `user` is the same producer kind the host uses for a real prompt; a
          // stub that stands in for a prompt must look like one to every reader.
          source: { kind: 'user' },
          content: [{ type: 'text', text: stub }],
        },
        // The host requires every shadowed surface node to be accounted for;
        // without this it refuses the replacement (and tells us which seqs are
        // missing, which is how this contract was discovered).
        { surfaceOp: { op: 'replace', startSeq: span.start, endSeq: span.end }, sourceEventSeqs: seqs },
      )
    } catch (error) {
      record({
        at: new Date().toISOString(), kind: 'shelve', ok: false, sessionId, stage: 'append',
        archived: ids, span: { start: span.start, end: span.end, nodes: span.nodes },
        error: String(error?.message ?? error).slice(0, 400), durationMs: Date.now() - startedAt,
      })
      return { attempted: true, ok: false, error }
    }
    setFoldStart(sessionId, span.start)
    // Two independent numbers on purpose: `shadowedTokenCount` is what the fold
    // archived (content side), `tokensBefore/After` is what the meter reports on
    // the rebuilt surface. They do not agree, so record both — tuning the
    // threshold needs the meter, judging the archive needs the shadow.
    const tokensAfter = measureTokens(sessionId)
    record({
      at: new Date().toISOString(), kind: 'shelve', ok: true, sessionId, agentId,
      deep: config.deep === true,
      span: { start: span.start, end: span.end, nodes: span.nodes },
      archived: ids,
      stubChars: stub.length,
      estimatedSavedTokens,
      shadowedTokenCount: Math.round((span.chars ?? 0) / 3),
      tokensBefore: tokensBefore > 0 ? tokensBefore : null,
      tokensAfter: tokensAfter > 0 ? tokensAfter : null,
      savedTokens: tokensBefore > 0 && tokensAfter > 0 ? Math.max(0, tokensBefore - tokensAfter) : null,
      durationMs: Date.now() - startedAt,
    })
    return { attempted: true, ok: true, archived: ids }
  }

  async function maybeCompact(agent) {
    // `measureTokens` is injected as a ONE-argument function (sessionId).
    const sessionId = String(agent?.id ?? '')
    if (sessionId === '') return null
    const config = settings()
    if (config.debug) record({ at: new Date().toISOString(), kind: 'enter-maybe', sessionId, enabled: config.enabled })
    if (!config.enabled) return null
    if (inFlight.has(sessionId)) return null
    const tokens = measureTokens(sessionId)
    const big = tokens >= config.triggerTokens
    // Two ways to fold, and no third: continuous tail folding (`keepUnder`
    // target, or every turn with no target at all), or the emergency fold once
    // the hard threshold is crossed. A mid-sized "soft threshold" fold was
    // redundant — it fired on the same idle as the continuous pass and only
    // split one job across two settings.
    const always = config.foldEveryTurn === true
    const continuous = always || (config.keepUnder > 0 && tokens > config.keepUnder)
    if (!big && !continuous) {
      record({ at: new Date().toISOString(), kind: 'skip', sessionId, why: 'below-threshold', tokens, keepUnder: config.keepUnder, trigger: config.triggerTokens })
      return null
    }
    if (!always && Date.now() - (lastAttempt.get(sessionId) ?? 0) < config.cooldownMs) {
      record({ at: new Date().toISOString(), kind: 'skip', sessionId, why: 'cooldown', tokens })
      return null
    }
    if (config.mode === 'shelve') {
      inFlight.add(sessionId)
      try {
        let last = null
        let done = null
        let pressure = tokens
        // A deep fold is a one-shot per idle: it already reaches back past the
        // watermark, so repeating it archives overlapping spans (the second
        // pass would fold the pointer the first one just wrote).
        // Continuous mode lowers the stopping line from the soft threshold to
        // `keepUnder`: the session is pulled back to a working size on every
        // idle, so it never has to be rescued by a big fold.
        // `foldEveryTurn` has no line to cross: with target 0 the loop runs
        // until nothing foldable is left (the watermark and the working set stop
        // it), which is exactly "archive last turn's material now".
        // `keepUnder` is the stopping line in both modes: with `foldEveryTurn`
        // it bounds how far one turn's pass goes, and 0 means "no line at all,
        // fold until nothing foldable is left".
        // One slice per turn end. Folding repeatedly inside a single idle was
        // measured at 60 folds in 13 minutes with a net context change of zero:
        // each slice was too small to amortise its own cache miss.
        const slices = 1
        for (let slice = 0; slice < slices; slice += 1) {
          const deep = pressure >= config.triggerTokens
          const sliceConfig = deep
            ? {
                ...config,
                // Enough to come back under the soft threshold, capped so one
                // summary never becomes an unbounded archive job.
                chunkTokens: Math.min(Math.max(pressure - (config.keepUnder > 0 ? config.keepUnder : Math.trunc(config.triggerTokens / 2)), config.chunkTokens), config.bigChunkTokens),
                maxSlices: 1,
                deep: true,
                archive: true,
              }
            : { ...config, maxSlices: 1, archive: false }
          last = await shelve(sessionId, agent, sliceConfig)
          if (last && last.attempted === true) done = last
          pressure = measureTokens(sessionId)
          if (!last || last.attempted !== true) break
        }
        // Only a real attempt earns the cooldown: resetting it on "no span"
        // starved every later attempt for a full minute at a time.
        if (last && last.attempted === true) lastAttempt.set(sessionId, Date.now())
        return done ?? last
      } catch (error) {
        record({ at: new Date().toISOString(), kind: 'shelve', ok: false, sessionId, error: String(error?.message ?? error).slice(0, 300) })
        return { attempted: true, ok: false, error }
      } finally {
        inFlight.delete(sessionId)
      }
    }
    const { service: compaction, source } = resolveCompaction(agent)
    if (compaction === undefined || compaction === null) {
      record({ at: new Date().toISOString(), kind: 'skip', sessionId, why: 'no-compaction-service', tokens, tried: source, fallback: config.fallbackShelve })
      if (!config.fallbackShelve) return null
      // The service lives in the preset's isolate scope; folding into memory is
      // the only thing a profile-level plugin can do, and doing nothing is worse.
      inFlight.add(sessionId)
      try {
        let last = null
        let done = null
        // Same rule as the service path: one slice per turn end, and only a
        // slice big enough to cross the hard threshold is archived.
        last = await shelve(sessionId, agent, { ...config, maxSlices: 1, archive: tokens >= config.triggerTokens })
        if (last && last.attempted === true) done = last
        if (last && last.attempted === true) lastAttempt.set(sessionId, Date.now())
        return done ?? last
      } finally {
        inFlight.delete(sessionId)
      }
    }
    if (source !== 'root') record({ at: new Date().toISOString(), kind: 'acquired', sessionId, source })
    if (big && typeof compaction.compactIfNeeded !== 'function') {
      record({ at: new Date().toISOString(), kind: 'skip', sessionId, why: 'compactIfNeeded-missing', tokens })
      return null
    }
    if (!big && typeof compaction.compactRegion !== 'function') {
      record({ at: new Date().toISOString(), kind: 'skip', sessionId, why: 'compactRegion-missing', tokens })
      return null
    }
    const session = sessionOf(sessionId)
    if (session === null) {
      record({ at: new Date().toISOString(), kind: 'skip', sessionId, why: 'no-session', tokens })
      return null
    }
    const span = big
      ? null
      : selectSpan(session, config.chunkTokens, config.keepRecent, config.minFoldTokens, foldStartOf(sessionId))
    if (!big && span === null) {
      record({ at: new Date().toISOString(), kind: 'skip', sessionId, why: 'no-span',
        tokens,
        nodes: Array.isArray(session?.surface?.nodes) ? session.surface.nodes.length : 0,
        watermark: foldStartOf(sessionId),
      })
      return null
    }

    inFlight.add(sessionId)
    const startedAt = Date.now()
    const controller = new AbortController()
    const guard = setTimeout(() => controller.abort(), 120000)
    if (typeof guard.unref === 'function') guard.unref()
    const base = {
      at: new Date().toISOString(),
      sessionId,
      agentId: store.bindingOf(sessionId) || '',
      kind: big ? 'big' : 'small',
      reason: big ? 'threshold' : 'sweep',
      beforeTokens: tokens,
    }
    try {
      const context = { session, options: optionsOf(session) }
      const result = big
        ? await compaction.compactIfNeeded(context, SLEEP_TRIGGER, controller.signal)
        : await compaction.compactRegion(span.start, span.end, context, controller.signal)
      const summary = Array.isArray(result?.summary) ? result.summary : []
      if (!big && span !== null) setFoldStart(sessionId, Number.isFinite(result?.startSeq) ? result.startSeq : span.start)
      record({
        ...base,
        ok: true,
        compacted: result !== null && result !== undefined,
        span: span === null ? null : { start: span.start, end: span.end, nodes: span.nodes },
        shadowedTokenCount: result?.shadowedTokenCount ?? 0,
        summaryChars: summary.reduce((sum, block) => sum + (typeof block?.text === 'string' ? block.text.length : 0), 0),
        durationMs: Date.now() - startedAt,
      })
      return { attempted: true, kind: big ? 'big' : 'small', result }
    } catch (error) {
      record({
        ...base,
        ok: false,
        span: span === null ? null : { start: span.start, end: span.end, nodes: span.nodes },
        error: String(error?.message ?? error).slice(0, 400),
        durationMs: Date.now() - startedAt,
      })
      return { attempted: true, kind: big ? 'big' : 'small', result: null, error }
    } finally {
      clearTimeout(guard)
      inFlight.delete(sessionId)
      lastAttempt.set(sessionId, Date.now())
    }
  }

  /** Turn boundaries only: `compactNow` needs an idle agent, and idle is the one
   *  moment where spending a few seconds on a summary costs the user nothing. */
  function attach() {
    // Two entry points on purpose. `agent/status` is the precise one (idle is
    // when compactNow wants the agent), but it is a scoped event and may not
    // reach a root-level listener on every host build. `session/event` is the
    // post-commit feed and always reaches us, so a committed `turn/end` also
    // schedules a check just after the turn settles. Both are cheap and
    // idempotent: inFlight + cooldown absorb the duplicate.
    const disposers = []
    // `agent/pre-step` is the hook we know works in this profile (handoff's
    // archived-session gate runs there), so it doubles as a liveness probe: if
    // neither scoped event arrives, this one still tells us the plugin is
    // receiving anything at all.
    disposers.push(
      ctx.effect(
        () =>
          ctx.on('agent/pre-step', (payload, next) => {
            const sessionId = String(payload?.agent?.id ?? '')
            if (sessionId !== '') {
              const seenAt = lastProbe.get(sessionId) ?? 0
              if (Date.now() - seenAt > 60000) {
                lastProbe.set(sessionId, Date.now())
                probe(sessionId, { seen: 'pre-step', tokens: measureTokens(sessionId) })
              }
              const timer = setTimeout(() => {
                void maybeCompact({ id: sessionId })
              }, 2000)
              if (typeof timer.unref === 'function') timer.unref()
            }
            return next()
          }),
        'agent-memory: sleep pre-step',
      ),
    )
    disposers.push(
      ctx.effect(
        () =>
          ctx.on('agent/status', payload => {
            const status = payload?.status
            if (status !== 'idle') return
            probe(String(payload?.agent?.id ?? ''), { seen: 'status-idle' })
            void maybeCompact(payload?.agent)
          }),
        'agent-memory: sleep status',
      ),
    )
    disposers.push(
      ctx.effect(
        () =>
          ctx.on('session/event', (session, event) => {
            if (event?.type !== 'turn/end') return
            const sessionId = String(session?.id ?? '')
            if (sessionId === '') return
            probe(sessionId, { seen: 'turn-end' })
            const timer = setTimeout(() => {
              void maybeCompact({ id: sessionId })
            }, 800)
            if (typeof timer.unref === 'function') timer.unref()
          }),
        'agent-memory: sleep turn-end',
      ),
    )
    // Polling is the fallback that cannot be scope-filtered away: the store's
    // `list()` hands us every live session, so the check does not depend on
    // receiving an event at all.
    const sweep = async () => {
      // Diagnostics are verbose on purpose, so they belong behind the debug
      // switch now that the pipeline works; real outcomes (`shelve`, `skip`)
      // are recorded unconditionally below.
      let verbose = false
      try {
        verbose = settings().debug
      } catch {
        verbose = false
      }
      const mark = detail => {
        if (verbose) record({ at: new Date().toISOString(), kind: 'tick', ...detail })
      }
      mark({ step: 'enter' })
      let sessions
      try {
        sessions = ctx.get('sessions')
      } catch (error) {
        mark({ step: 'get-threw', error: String(error?.message ?? error).slice(0, 300) })
        return
      }
      mark({ step: 'got', hasSessions: sessions !== undefined && sessions !== null, canList: typeof sessions?.list === 'function' })
      if (sessions === undefined || sessions === null || typeof sessions.list !== 'function') return
      let live = []
      try {
        live = sessions.list()
      } catch (error) {
        mark({ step: 'list-threw', error: String(error?.message ?? error).slice(0, 300) })
        return
      }
      mark({ step: 'listed', sessions: live.length })
      for (const session of live) {
        const id = String(session?.id ?? '')
        if (id === '') continue
        try {
          const config = settings()
          if (!config.enabled) {
            mark({ step: 'disabled', sessionId: id, tokens: measureTokens(id) })
            continue
          }
          let tokens = measureTokens(id)
          const session = (() => {
            try {
              return ctx.get('sessions')?.get?.(id) ?? null
            } catch {
              return null
            }
          })()
          if (tokens === 0 && session !== null) {
            // Why is a 674-message session priced at zero? Walk the same steps
            // and record what each one actually answered.
            let meterOk = false
            let meterValue = null
            let meterError = ''
            try {
              const meter = ctx.get('tokenMeter')
              meterOk = meter !== undefined && meter !== null && typeof meter.measure === 'function'
              if (meterOk) {
                const measuredValue = meter.measure(session)
                meterValue = measuredValue?.totalTokens ?? null
              }
            } catch (error) {
              meterError = String(error?.message ?? error).slice(0, 200)
            }
            let chars = 0
            let jsonError = ''
            try {
              const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
              for (const message of messages) {
                try {
                  chars += JSON.stringify(message).length
                } catch (error) {
                  jsonError = jsonError === '' ? String(error?.message ?? error).slice(0, 200) : jsonError
                }
              }
            } catch (error) {
              jsonError = String(error?.message ?? error).slice(0, 200)
            }
            if (tokens === 0 && (meterValue > 0 || chars > 0)) {
              tokens = meterValue > 0 ? Number(meterValue) : Math.round(chars / 3)
              mark({ step: 'measure-recovered', sessionId: id, tokens })
            }
            mark({
              step: 'measure-debug',
              sessionId: id,
              meterOk,
              meterValue,
              meterError,
              chars,
              jsonError,
              estimate: Math.round(chars / 3),
            })
          }
          mark({
            step: 'measured',
            sessionId: id,
            tokens,
            keepUnder: config.keepUnder,
            trigger: config.triggerTokens,
            hasSession: session !== null,
            nodes: Array.isArray(session?.surface?.nodes) ? session.surface.nodes.length : -1,
            derived: typeof session?.deriveMessages === 'function' ? (() => { try { return session.deriveMessages().length } catch { return -2 } })() : -1,
          })
          mark({ step: 'pre-call', sessionId: id })
          const outcome = await maybeCompact({ id })
          mark({ step: 'post-call', sessionId: id, attempted: outcome?.attempted === true, kind: outcome?.kind ?? '' })
        } catch (error) {
          mark({ step: 'session-threw', sessionId: id, error: String(error?.message ?? error).slice(0, 300) })
        }
      }
    }
    const selfTest = setTimeout(() => record({ at: new Date().toISOString(), kind: 'timer-fired' }), 6000)
    if (typeof selfTest.unref === 'function') selfTest.unref()
    const first = setTimeout(() => void sweep(), 5000)
    if (typeof first.unref === 'function') first.unref()
    const timer = setInterval(() => void sweep(), 60000)
    if (typeof timer.unref === 'function') timer.unref()
    record({ at: new Date().toISOString(), kind: 'attached', hooks: disposers.length })

    return () => {
      clearTimeout(selfTest)
      clearTimeout(first)
      clearInterval(timer)
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // best effort
        }
      }
    }
  }

  function history(limit = 50) {
    try {
      const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
      const rows = []
      for (const line of lines.slice(-Math.max(1, limit))) {
        try {
          rows.push(JSON.parse(line))
        } catch {
          // a torn tail while another process appends
        }
      }
      return rows
    } catch {
      return []
    }
  }

  /**
   * Fold accounting for one session, split by the two paths: the continuous
   * tail folds that keep the prefix cached, and the deep fold that reaches past
   * the watermark once the hard threshold is crossed. The panel shows them as
   * separate numbers on purpose — they have different costs and different
   * failure modes, and a session that only ever deep-folds is being neglected.
   */
  function foldSummary(sessionId) {
    const rows = history(2000).filter(row => String(row.sessionId ?? '') === sessionId && row.kind === 'shelve')
    const blank = () => ({ count: 0, tokens: 0, nodes: 0, lastAt: '', lastRun: null })
    const continuous = blank()
    const deep = blank()
    const recent = []
    const failures = []
    let streak = { count: 0, at: '', stage: '', error: '' }
    for (const row of rows) {
      const bucket = row.deep === true || (Number(row.shadowedTokenCount) || 0) >= 120000 ? deep : continuous
      if (row.ok === true) {
        bucket.count += 1
        bucket.tokens += Number(row.shadowedTokenCount) || 0
        bucket.nodes += Number(row.span?.nodes) || 0
        bucket.lastAt = row.at ?? ''
        bucket.lastRun = row
        streak = { count: 0, at: '', stage: '', error: '' }
      } else {
        failures.push({ at: row.at ?? '', stage: row.stage ?? '', error: String(row.error ?? '').slice(0, 300) })
        streak = { count: streak.count + 1, at: row.at ?? '', stage: row.stage ?? '', error: String(row.error ?? '').slice(0, 300) }
      }
      recent.push({
        at: row.at ?? '',
        ok: row.ok === true,
        deep: row.deep === true || (Number(row.shadowedTokenCount) || 0) >= 120000,
        nodes: Number(row.span?.nodes) || 0,
        tokens: Number(row.shadowedTokenCount) || 0,
        saved: Number(row.savedTokens) || 0,
        ms: Number(row.durationMs) || 0,
        stage: row.stage ?? '',
        error: String(row.error ?? '').slice(0, 200),
      })
    }
    return {
      continuous,
      deep,
      recent: recent.slice(-12),
      failures: failures.slice(-5),
      alert: streak.count >= 2 ? streak : null,
      totalTokens: continuous.tokens + deep.tokens,
    }
  }

  /**
   * Sessions whose last attempts all failed. The host treats a refused
   * compaction as a warning and carries on, so a session can sit over its
   * window with nothing but a warn line in a log nobody reads — this run count
   * is what the panel turns into a red row.
   */
  function failures(window = 200) {
    const rows = history(window).filter(row => row.ok === true || row.ok === false)
    const runs = new Map()
    for (const row of rows) {
      const sessionId = String(row.sessionId ?? '')
      if (sessionId === '') continue
      if (row.ok === true) {
        runs.delete(sessionId)
        continue
      }
      const previous = runs.get(sessionId)
      runs.set(sessionId, {
        sessionId,
        count: (previous?.count ?? 0) + 1,
        at: row.at ?? '',
        kind: row.kind ?? '',
        error: String(row.error ?? '').slice(0, 400),
      })
    }
    return [...runs.values()].sort((a, b) => b.count - a.count)
  }

  function state() {
    const rows = history(200)
    const failing = failures(200)
    return {
      ...settings(),
      logFile,
      foldStartSeq: watermarks(),
      attempts: rows.length,
      last: rows.length === 0 ? null : rows[rows.length - 1],
      savedTokens: rows.reduce((sum, row) => sum + (Number(row.shadowedTokenCount) || 0), 0),
      failing,
      alert: failing.length > 0 && failing[0].count >= 2 ? failing[0] : null,
    }
  }

  return { attach, maybeCompact, settings, state, history, failures, foldSummary, logFile }
}
