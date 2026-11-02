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
  // Below this a fold costs more (one summary call + a cache re-pay) than it
  // saves, so small slices wait for the next idle.
  minFoldTokens: 5000,
  cooldownMs: 10 * 60 * 1000,
})

/** The compaction service is asked for `context-overflow`: the documented way to
 *  request a useful balanced reduction below the implementation's own threshold. */
export const SLEEP_TRIGGER = 'context-overflow'

export function createSleep({ ctx, store, measureTokens, recordError = () => {} }) {
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
    const soft = Number(raw.softTokens)
    const chunk = Number(raw.chunkTokens)
    const keep = Number(raw.keepRecent)
    const minFold = Number(raw.minFoldTokens)
    return {
      enabled: raw.enabled === true,
      debug: raw.debug === true,
      triggerTokens: Number.isFinite(trigger) && trigger > 0 ? Math.trunc(trigger) : SLEEP_DEFAULTS.triggerTokens,
      softTokens: Number.isFinite(soft) && soft > 0 ? Math.trunc(soft) : SLEEP_DEFAULTS.softTokens,
      chunkTokens: Number.isFinite(chunk) && chunk >= 2000 ? Math.trunc(chunk) : SLEEP_DEFAULTS.chunkTokens,
      keepRecent: Number.isFinite(keep) && keep >= 2 ? Math.trunc(keep) : SLEEP_DEFAULTS.keepRecent,
      minFoldTokens: Number.isFinite(minFold) && minFold > 0 ? Math.trunc(minFold) : SLEEP_DEFAULTS.minFoldTokens,
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
    // Never split a tool call from its result: a span may not start on a result
    // nor end on a call, or compactRegion rejects it as unbalanced.
    while (startIndex <= endIndex && nodeType(session, nodes[startIndex]) === 'tool/result') startIndex += 1
    while (endIndex > startIndex && nodeType(session, nodes[endIndex]) === 'tool/call') endIndex -= 1
    if (endIndex - startIndex < 1) return null
    const start = nodes[startIndex]
    // Never rewrite at or before the last fold: that prefix is still cached and
    // replacing it would re-bill everything after it for no gain.
    if (watermark !== null && start <= watermark) return null
    if (cost < Math.max(2000, Math.trunc(minFoldTokens) * 3)) return null
    return { start, end: nodes[endIndex], nodes: endIndex - startIndex + 1, chars: cost }
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
    if (!big && !small) {
      probe(sessionId, { skipped: 'below-threshold', tokens, soft: config.softTokens, trigger: config.triggerTokens })
      return null
    }
    if (Date.now() - (lastAttempt.get(sessionId) ?? 0) < config.cooldownMs) {
      probe(sessionId, { skipped: 'cooldown', tokens })
      return null
    }
    const compaction = ctx.get('compaction')
    if (compaction === undefined || compaction === null) {
      probe(sessionId, { skipped: 'no-compaction-service', tokens })
      return null
    }
    if (big && typeof compaction.compactIfNeeded !== 'function') {
      probe(sessionId, { skipped: 'compactIfNeeded-missing', tokens })
      return null
    }
    if (small && typeof compaction.compactRegion !== 'function') {
      probe(sessionId, { skipped: 'compactRegion-missing', tokens })
      return null
    }
    const session = sessionOf(sessionId)
    if (session === null) {
      probe(sessionId, { skipped: 'no-session', tokens })
      return null
    }
    const span = big
      ? null
      : selectSpan(session, config.chunkTokens, config.keepRecent, config.minFoldTokens, foldStartOf(sessionId))
    if (!big && span === null) {
      probe(sessionId, {
        skipped: 'no-span',
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
                probe(sessionId, { seen: 'pre-step', tokens: measureTokens(ctx, sessionId) })
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
      // Every step below writes unconditionally: the gated `probe()` helper
      // hides "settings threw" behind "debug is off", which is exactly the
      // ambiguity this sweep is supposed to resolve.
      const mark = detail => record({ at: new Date().toISOString(), kind: 'tick', ...detail })
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
            mark({ step: 'disabled', sessionId: id, tokens: measureTokens(ctx, id) })
            continue
          }
          let tokens = measureTokens(ctx, id)
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
            soft: config.softTokens,
            trigger: config.triggerTokens,
            hasSession: session !== null,
            nodes: Array.isArray(session?.surface?.nodes) ? session.surface.nodes.length : -1,
            derived: typeof session?.deriveMessages === 'function' ? (() => { try { return session.deriveMessages().length } catch { return -2 } })() : -1,
          })
          await maybeCompact({ id })
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

  function state() {
    const rows = history(200)
    return {
      ...settings(),
      logFile,
      foldStartSeq: watermarks(),
      attempts: rows.length,
      last: rows.length === 0 ? null : rows[rows.length - 1],
      savedTokens: rows.reduce((sum, row) => sum + (Number(row.shadowedTokenCount) || 0), 0),
    }
  }

  return { attach, maybeCompact, settings, state, history, logFile }
}
