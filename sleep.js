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
import path from 'node:path'

export const SLEEP_DEFAULTS = Object.freeze({
  enabled: false,
  // Hard threshold: ask the host for its own balanced reduction.
  triggerTokens: 400000,
  // Soft threshold: fold a tail slice instead, which keeps the KV prefix warm.
  softTokens: 300000,
  // Target size of one tail slice, and how much recent work never to touch.
  chunkTokens: 20000,
  keepRecent: 8,
  cooldownMs: 10 * 60 * 1000,
})

/** The compaction service is asked for `context-overflow`: the documented way to
 *  request a useful balanced reduction below the implementation's own threshold. */
export const SLEEP_TRIGGER = 'context-overflow'

export function createSleep({ ctx, store, measureTokens, recordError = () => {} }) {
  const logFile = path.join(store.root, 'index', 'compaction.jsonl')
  const inFlight = new Set()
  const lastAttempt = new Map()

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
    const soft = Number(raw.softTokens)
    const chunk = Number(raw.chunkTokens)
    const keep = Number(raw.keepRecent)
    return {
      enabled: raw.enabled === true,
      triggerTokens: Number.isFinite(trigger) && trigger > 0 ? Math.trunc(trigger) : SLEEP_DEFAULTS.triggerTokens,
      softTokens: Number.isFinite(soft) && soft > 0 ? Math.trunc(soft) : SLEEP_DEFAULTS.softTokens,
      chunkTokens: Number.isFinite(chunk) && chunk >= 2000 ? Math.trunc(chunk) : SLEEP_DEFAULTS.chunkTokens,
      keepRecent: Number.isFinite(keep) && keep >= 2 ? Math.trunc(keep) : SLEEP_DEFAULTS.keepRecent,
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

  function nodeType(session, seq) {
    try {
      const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : undefined
      return String(event?.type ?? '')
    } catch {
      return ''
    }
  }

  /**
   * Pick a slice near the tail, leaving the recent working set alone. Position
   * matters more than size: replacing a span at P invalidates every cached
   * prefix after P, so folding near the tail keeps the re-pay small, while
   * folding the oldest span (what the host does on pressure) re-bills almost
   * the whole conversation.
   */
  function selectSpan(session, chunkTokens, keepRecent) {
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
    // Never split a tool call from its result: a span may not start on a result
    // nor end on a call, or compactRegion rejects it as unbalanced.
    while (startIndex <= endIndex && nodeType(session, nodes[startIndex]) === 'tool/result') startIndex += 1
    while (endIndex > startIndex && nodeType(session, nodes[endIndex]) === 'tool/call') endIndex -= 1
    if (endIndex - startIndex < 1) return null
    return { start: nodes[startIndex], end: nodes[endIndex], nodes: endIndex - startIndex + 1 }
  }

  /**
   * Ask for one compaction: a small tail fold above the soft threshold, or the
   * host's balanced reduction above the hard one. Returns null when nothing was
   * attempted, or `{ attempted, kind, result }` so callers can tell "below
   * threshold" from "the service declined".
   */
  async function maybeCompact(agent) {
    const sessionId = String(agent?.id ?? '')
    if (sessionId === '') return null
    const config = settings()
    if (!config.enabled) return null
    if (inFlight.has(sessionId)) return null
    const tokens = measureTokens(ctx, sessionId)
    const big = tokens >= config.triggerTokens
    const small = !big && tokens >= config.softTokens
    if (!big && !small) return null
    if (Date.now() - (lastAttempt.get(sessionId) ?? 0) < config.cooldownMs) return null
    const compaction = ctx.get('compaction')
    if (compaction === undefined || compaction === null) return null
    if (big && typeof compaction.compactIfNeeded !== 'function') return null
    if (small && typeof compaction.compactRegion !== 'function') return null
    const session = sessionOf(sessionId)
    if (session === null) return null
    const span = big ? null : selectSpan(session, config.chunkTokens, config.keepRecent)
    if (!big && span === null) return null

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
    return ctx.effect(
      () =>
        ctx.on('agent/status', payload => {
          const status = payload?.status
          if (status !== 'idle') return
          void maybeCompact(payload?.agent)
        }),
      'agent-memory: sleep status',
    )
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

  function state() {
    const rows = history(200)
    return {
      ...settings(),
      logFile,
      attempts: rows.length,
      last: rows.length === 0 ? null : rows[rows.length - 1],
      savedTokens: rows.reduce((sum, row) => sum + (Number(row.shadowedTokenCount) || 0), 0),
    }
  }

  return { attach, maybeCompact, settings, state, history, logFile }
}
