// Early compaction ("sleep"): threshold, cooldown, accounting, failure paths.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { SLEEP_DEFAULTS, createSleep } from './sleep.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-sleep-'))
const logFile = path.join(root, 'index', 'compaction.jsonl')

function harness(options = {}) {
  fs.rmSync(logFile, { force: true })
  const settings = {
    enabled: true,
    triggerTokens: 1000,
    cooldownMs: 0,
    ...(options.settings ?? {}),
  }
  const calls = []
  const session = { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
  const services = {
    sessions: { get: id => (id === 'session-a' ? session : undefined) },
    compaction: {
      compactIfNeeded: async (context, trigger, signal) => {
        calls.push({ context, trigger, aborted: signal.aborted })
        if (options.throws === true) throw new Error('summary failed')
        if (options.null === true) return null
        return {
          compactionId: 'c1',
          summary: [{ type: 'text', text: 'x'.repeat(120) }],
          shadowedTokenCount: 5000,
        }
      },
    },
  }
  const ctx = {
    get: name => services[name],
    on: () => () => {},
    effect: fn => fn(),
  }
  const store = {
    root,
    settings: () => ({ sleep: settings }),
    bindingOf: () => 'agent-a',
  }
  let tokens = options.tokens ?? 0
  const sleep = createSleep({
    ctx,
    store,
    measureTokens: () => tokens,
    recordError: (target, scope, error) => {
      throw new Error(`unexpected recordError ${scope}: ${error?.message ?? error}`)
    },
  })
  return {
    sleep,
    calls,
    settings,
    setTokens: value => {
      tokens = value
    },
  }
}

// disabled: never touches the service
{
  const h = harness({ settings: { enabled: false }, tokens: 999999 })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result, null)
  assert.equal(h.calls.length, 0)
  assert.equal(fs.existsSync(logFile), false)
}

// below threshold: no call
{
  const h = harness({ tokens: 500 })
  assert.equal(await h.sleep.maybeCompact({ id: 'session-a' }), null)
  assert.equal(h.calls.length, 0)
}

// above threshold: one call, early trigger, one accounting line
{
  const h = harness({ tokens: 1200 })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result?.attempted, true)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].trigger, 'context-overflow')
  assert.equal(h.calls[0].context.options.provider, 'p')
  assert.equal(h.calls[0].context.session, undefined ?? h.calls[0].context.session)
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  const row = JSON.parse(lines[0])
  assert.equal(row.sessionId, 'session-a')
  assert.equal(row.ok, true)
  assert.equal(row.beforeTokens, 1200)
  assert.equal(row.shadowedTokenCount, 5000)
  assert.equal(row.summaryChars, 120)
  assert.equal(row.reason, 'threshold')
  assert.ok(row.durationMs >= 0)
}

// cooldown: the second attempt inside the window is skipped
{
  const h = harness({ tokens: 1200, settings: { cooldownMs: 60000 } })
  assert.equal((await h.sleep.maybeCompact({ id: 'session-a' }))?.attempted, true)
  assert.equal(await h.sleep.maybeCompact({ id: 'session-a' }), null)
  assert.equal(h.calls.length, 1)
}

// service declines: still accounted, but nothing was folded
{
  const h = harness({ tokens: 1200, null: true })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result?.attempted, true)
  assert.equal(result.result, null)
  const rows = h.sleep.history(10)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].ok, true)
  assert.equal(rows[0].compacted, false)
  assert.equal(rows[0].shadowedTokenCount, 0)
}

// failure: accounted with the error, never thrown to the loop
{
  const h = harness({ tokens: 1200, throws: true })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result?.attempted, true)
  assert.equal(result.error instanceof Error, true)
  const rows = h.sleep.history(10)
  assert.equal(rows[0].ok, false)
  assert.ok(String(rows[0].error).includes('summary failed'))
}

// missing session or missing service: no call, no throw
{
  const h = harness({ tokens: 1200 })
  assert.equal(await h.sleep.maybeCompact({ id: 'session-unknown' }), null)
  const bare = createSleep({
    ctx: { get: () => undefined, on: () => () => {}, effect: fn => fn() },
    store: { root, settings: () => ({ sleep: { enabled: true, triggerTokens: 1 } }), bindingOf: () => '' },
    measureTokens: () => 999999,
    recordError: () => {},
  })
  assert.equal(await bare.maybeCompact({ id: 'session-a' }), null)
}

// state(): settings + totals from the log
{
  fs.rmSync(logFile, { force: true })
  const h = harness({ tokens: 1200 })
  await h.sleep.maybeCompact({ id: 'session-a' })
  const state = h.sleep.state()
  assert.equal(state.enabled, true)
  assert.equal(state.triggerTokens, 1000)
  assert.equal(state.attempts, 1)
  assert.equal(state.savedTokens, 5000)
  assert.equal(state.logFile, logFile)
  assert.equal(state.last.shadowedTokenCount, 5000)
}

// defaults stay conservative
assert.deepEqual({ ...SLEEP_DEFAULTS }, { enabled: false, triggerTokens: 400000, cooldownMs: 600000 })

fs.rmSync(root, { recursive: true, force: true })
console.log('ALL SLEEP TESTS PASSED')
