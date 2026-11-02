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
  triggerTokens: 400000,
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
    return {
      enabled: raw.enabled === true,
      triggerTokens: Number.isFinite(trigger) && trigger > 0 ? Math.trunc(trigger) : SLEEP_DEFAULTS.triggerTokens,
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

  /**
   * Ask for one early compaction. Returns null when nothing was attempted, or
   * `{ attempted, result }` so callers and tests can tell the difference between
   * "below threshold" and "the service declined".
   */
  async function maybeCompact(agent) {
    const sessionId = String(agent?.id ?? '')
    if (sessionId === '') return null
    const config = settings()
    if (!config.enabled) return null
    if (inFlight.has(sessionId)) return null
    const tokens = measureTokens(ctx, sessionId)
    if (tokens < config.triggerTokens) return null
    if (Date.now() - (lastAttempt.get(sessionId) ?? 0) < config.cooldownMs) return null
    const compaction = ctx.get('compaction')
    if (compaction === undefined || compaction === null || typeof compaction.compactIfNeeded !== 'function') return null
    const session = sessionOf(sessionId)
    if (session === null) return null

    inFlight.add(sessionId)
    const startedAt = Date.now()
    const controller = new AbortController()
    const guard = setTimeout(() => controller.abort(), 120000)
    if (typeof guard.unref === 'function') guard.unref()
    try {
      const result = await compaction.compactIfNeeded({ session, options: optionsOf(session) }, SLEEP_TRIGGER, controller.signal)
      const summary = Array.isArray(result?.summary) ? result.summary : []
      record({
        at: new Date().toISOString(),
        sessionId,
        agentId: store.bindingOf(sessionId) || '',
        reason: 'threshold',
        beforeTokens: tokens,
        ok: true,
        compacted: result !== null && result !== undefined,
        shadowedTokenCount: result?.shadowedTokenCount ?? 0,
        summaryChars: summary.reduce((sum, block) => sum + (typeof block?.text === 'string' ? block.text.length : 0), 0),
        durationMs: Date.now() - startedAt,
      })
      return { attempted: true, result }
    } catch (error) {
      record({
        at: new Date().toISOString(),
        sessionId,
        agentId: store.bindingOf(sessionId) || '',
        reason: 'threshold',
        beforeTokens: tokens,
        ok: false,
        error: String(error?.message ?? error).slice(0, 400),
        durationMs: Date.now() - startedAt,
      })
      return { attempted: true, result: null, error }
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
